'use strict';

const utils = require('@iobroker/adapter-core');
const { getModel } = require('./lib/models');
const { buildObjects } = require('./lib/stateTree');
const { TelnetClient } = require('./lib/transport/telnet');
const { ColonDriver } = require('./lib/drivers/colon');

// Objects from io-package.json instanceObjects, never removed by the model cleanup
const INSTANCE_OBJECTS = new Set(['info', 'info.connection']);

const DRIVERS = { colon: ColonDriver };

const POLL_DEFAULT_MS = 30000;
const POLL_MIN_MS = 15000; // a full SW-510W status poll takes about 8 s at 500 ms per command
const POLL_MAX_MS = 3600000;

class Atlona extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'atlona' });
        this.unloaded = false;
        this.transport = null;
        this.driver = null;
        this.model = null;
        this.stateIds = new Set();
        this.pollTimer = null;
        this.pollingInterval = POLL_DEFAULT_MS;
        this.lastFailure = '';
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);

        const config = this.readConfig();
        if (!config) {
            return;
        }
        this.model = getModel(config.model);
        this.pollingInterval = config.pollingInterval;

        const objects = buildObjects(this.model);
        this.stateIds = new Set(objects.filter(obj => obj.type === 'state').map(obj => obj._id));
        await this.syncObjects(objects);
        if (this.unloaded) {
            return;
        }
        await this.setState('info.model', this.model.name, true);
        this.subscribeStates('*');

        this.transport = new TelnetClient({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            timers: {
                setTimeout: (fn, ms) => this.setTimeout(fn, ms),
                clearTimeout: timer => this.clearTimeout(timer),
            },
            log: this.log,
        });
        const Driver = DRIVERS[this.model.dialect];
        this.driver = Driver
            ? new Driver(this.model, this.transport, this.log, updates => void this.applyUpdates(updates))
            : null;
        if (!this.driver) {
            this.log.warn(`The ${this.model.dialect} dialect is not implemented yet; only the connection is monitored`);
        }
        this.transport.on('ready', () => this.onConnected(config));
        this.transport.on('disconnected', (reason, wasReady) => this.onDisconnected(config, reason, wasReady));
        this.log.info(`Connecting to ${this.model.name} at ${config.host}:${config.port}`);
        this.transport.start();
    }

    /**
     * Validates the instance config. Logs an error and returns null if the adapter cannot run.
     *
     * @returns {{host: string, port: number, model: string, username: string, password: string,
     *   pollingInterval: number} | null} normalised config
     */
    readConfig() {
        const host = String(this.config.host ?? '').trim();
        if (!host) {
            this.log.error('No device address configured. Enter the IP address or host name in the instance settings.');
            return null;
        }
        const model = String(this.config.model ?? '');
        if (!getModel(model)) {
            this.log.error(`Unknown device model "${model}". Select a model in the instance settings.`);
            return null;
        }
        const port = Number(this.config.port);
        const interval = Number(this.config.pollingInterval);
        return {
            host,
            model,
            port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : getModel(model).port,
            username: String(this.config.username ?? '').trim() || 'admin',
            password: String(this.config.password ?? '') || 'Atlona',
            pollingInterval: Number.isFinite(interval)
                ? Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(interval)))
                : POLL_DEFAULT_MS,
        };
    }

    /**
     * Creates or updates the model's objects and removes objects left over from another model.
     *
     * @param {Array<{_id: string, type: string, common: object, native: object}>} objects object tree
     */
    async syncObjects(objects) {
        const wanted = new Set(objects.map(obj => obj._id));
        for (const obj of objects) {
            await this.extendObject(obj._id, { type: obj.type, common: obj.common, native: obj.native });
            if (this.unloaded) {
                return;
            }
        }
        const existing = Object.keys(await this.getAdapterObjectsAsync())
            .map(id => id.slice(this.namespace.length + 1))
            .filter(id => id && !wanted.has(id) && !INSTANCE_OBJECTS.has(id))
            .sort((a, b) => b.split('.').length - a.split('.').length);
        for (const id of existing) {
            this.log.debug(`Removing ${id}: not part of the ${this.model.name} state tree`);
            await this.delObjectAsync(id);
        }
    }

    /** @param {{host: string, port: number}} config normalised config */
    async onConnected(config) {
        if (this.unloaded) {
            return;
        }
        this.log.info(`Connected to ${this.model.name} at ${config.host}:${config.port}`);
        this.lastFailure = '';
        await this.setState('info.connection', true, true);
        if (!this.driver) {
            return;
        }
        try {
            await this.applyUpdates(await this.driver.identify());
        } catch (err) {
            this.log.debug(`Identity query failed: ${err.message}`);
        }
        await this.pollOnce();
    }

    /** Polls the device once, then schedules the next poll (re-armed at the end, so polls never overlap). */
    async pollOnce() {
        this.pollTimer = null;
        if (this.unloaded || this.transport?.state !== 'ready') {
            return;
        }
        try {
            await this.applyUpdates(await this.driver.poll());
        } catch (err) {
            this.log.debug(`Poll incomplete: ${err.message}`);
        }
        if (!this.unloaded && this.transport?.state === 'ready') {
            this.pollTimer = this.setTimeout(() => this.pollOnce(), this.pollingInterval);
        }
    }

    /**
     * Writes confirmed device values.
     *
     * @param {Array<[string, ioBroker.StateValue]>} updates [state id, value] pairs
     */
    async applyUpdates(updates) {
        for (const [id, val] of updates) {
            if (this.unloaded) {
                return;
            }
            if (this.stateIds.has(id)) {
                await this.setStateChangedAsync(id, val, true);
            }
        }
    }

    /**
     * Logs a lost connection once, and repeated identical failures only at debug level.
     *
     * @param {{host: string, port: number}} config normalised config
     * @param {string} reason why the session ended
     * @param {boolean} wasReady whether the session had been usable
     */
    onDisconnected(config, reason, wasReady) {
        if (this.unloaded) {
            return;
        }
        this.clearTimeout(this.pollTimer);
        this.pollTimer = null;
        if (wasReady) {
            this.log.info(`Disconnected from ${config.host}:${config.port}: ${reason}`);
            void this.setState('info.connection', false, true);
        } else if (reason !== this.lastFailure) {
            this.log.warn(`Cannot connect to ${config.host}:${config.port}: ${reason}. Retrying in the background.`);
        } else {
            this.log.debug(`Still cannot connect to ${config.host}:${config.port}: ${reason}`);
        }
        this.lastFailure = reason;
    }

    /**
     * @param {string} id state id
     * @param {ioBroker.State | null | undefined} state new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack || this.unloaded) {
            return;
        }
        const key = id.slice(this.namespace.length + 1);
        if (!this.driver) {
            this.log.warn(`Commands for the ${this.model?.dialect} dialect are not implemented yet; ignoring ${key}`);
            return;
        }
        if (this.transport?.state !== 'ready') {
            this.log.warn(`Cannot set ${key}: not connected to the device`);
            return;
        }
        try {
            await this.applyUpdates(await this.driver.command(key, state.val));
        } catch (err) {
            this.log.warn(`Cannot set ${key} to ${state.val}: ${err.message}`);
        }
    }

    /** @param {() => void} callback called when cleanup is done */
    onUnload(callback) {
        this.unloaded = true;
        try {
            this.clearTimeout(this.pollTimer);
            this.transport?.stop();
            this.transport = null;
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Atlona(options);
} else {
    (() => new Atlona())();
}
