'use strict';

const utils = require('@iobroker/adapter-core');
const { getModel } = require('./lib/models');
const { buildObjects } = require('./lib/stateTree');
const { TelnetClient } = require('./lib/transport/telnet');

// Objects from io-package.json instanceObjects, never removed by the model cleanup
const INSTANCE_OBJECTS = new Set(['info', 'info.connection']);

class Atlona extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'atlona' });
        this.unloaded = false;
        this.transport = null;
        this.model = null;
        this.lastFailure = '';
        this.driverWarned = false;
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

        await this.syncObjects(buildObjects(this.model));
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
        this.transport.on('ready', () => this.onConnected(config));
        this.transport.on('disconnected', (reason, wasReady) => this.onDisconnected(config, reason, wasReady));
        this.transport.on('line', line => this.log.debug(`Unsolicited: ${line}`));
        this.log.info(`Connecting to ${this.model.name} at ${config.host}:${config.port}`);
        this.transport.start();
    }

    /**
     * Validates the instance config. Logs an error and returns null if the adapter cannot run.
     *
     * @returns {{host: string, port: number, model: string, username: string, password: string} | null}
     *   normalised config
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
        return {
            host,
            model,
            port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : getModel(model).port,
            username: String(this.config.username ?? '').trim() || 'admin',
            password: String(this.config.password ?? '') || 'Atlona',
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
    onConnected(config) {
        if (this.unloaded) {
            return;
        }
        this.log.info(`Connected to ${this.model.name} at ${config.host}:${config.port}`);
        this.lastFailure = '';
        void this.setState('info.connection', true, true);
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
    onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        // The dialect drivers arrive in the next phases (see MODEL-EXPANSION-PLAN.md §8).
        if (!this.driverWarned) {
            this.log.warn(`Commands for the ${this.model?.dialect} dialect are not implemented yet; ignoring ${id}`);
            this.driverWarned = true;
        }
    }

    /** @param {() => void} callback called when cleanup is done */
    onUnload(callback) {
        this.unloaded = true;
        try {
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
