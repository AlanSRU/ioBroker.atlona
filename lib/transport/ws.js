'use strict';

const { EventEmitter } = require('node:events');

const DEFAULTS = {
    path: '/API',
    pacingMs: 500,
    connectTimeoutMs: 10000,
    requestTimeoutMs: 8000,
    reconnectMinMs: 5000,
    reconnectMaxMs: 60000,
    stableMs: 60000,
    maxTimeouts: 2,
};

/**
 * One persistent JSON-RPC 2.0 WebSocket session (e.g. `ws://<ip>/API` on the SW-510W).
 *
 * - Sends one request at a time, at least `pacingMs` apart, and matches each reply by `id`.
 * - Messages carrying an `event` member are emitted as `event`.
 * - Reconnects with exponential backoff, reset once a session has stayed up for `stableMs`.
 * - Drops the session after `maxTimeouts` consecutive unanswered requests.
 *
 * Events: `ready`, `disconnected` (reason, wasReady), `event` (the `event` member of a pushed message).
 * Same lifecycle and `state` values as TelnetClient, so the adapter treats both alike.
 */
class WsClient extends EventEmitter {
    /**
     * @param {object} options connection options
     * @param {string} options.host device address
     * @param {number} options.port HTTP port
     * @param {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (timer: unknown) => void}} options.timers
     *   adapter-managed timers
     * @param {{debug: (msg: string) => void}} options.log logger for traffic
     * @param {typeof WebSocket} [options.WebSocket] WebSocket implementation (default: the Node.js global)
     */
    constructor(options) {
        super();
        this.opts = { ...DEFAULTS, ...options };
        this.timers = options.timers;
        this.log = options.log;
        this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
        this.state = 'idle'; // idle | connecting | ready | closed
        this.ws = null;
        this.queue = [];
        this.current = null;
        this.nextId = 1;
        this.lastSendAt = 0;
        this.timeouts = 0;
        this.reconnectDelay = this.opts.reconnectMinMs;
        this.failure = '';
        this.connectTimer = null;
        this.pumpTimer = null;
        this.stableTimer = null;
        this.reconnectTimer = null;
    }

    /** Opens the session. It reconnects by itself until stop() is called. */
    start() {
        if (this.state === 'idle') {
            this._connect();
        }
    }

    /** Closes the session for good and rejects every pending request. */
    stop() {
        this.state = 'closed';
        this._clearTimers();
        this.timers.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this._rejectAll('Connection closed');
        if (this.ws) {
            this._detach(this.ws);
            try {
                this.ws.close();
            } catch {
                // already closed or never opened
            }
            this.ws = null;
        }
    }

    /**
     * Queues a request and resolves with the device's reply message.
     *
     * @param {string} method JSON-RPC method, e.g. "Audio:Volume:Get"
     * @param {object} [params] parameters (the SW-510W requires an object, even an empty one)
     * @param {object} [options] request options
     * @param {number} [options.timeoutMs] reply timeout
     * @returns {Promise<object>} the whole reply message (`result` and/or `error`)
     */
    request(method, params = {}, options = {}) {
        if (this.state !== 'ready') {
            return Promise.reject(new Error('Not connected'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({
                method,
                params,
                timeoutMs: options.timeoutMs ?? this.opts.requestTimeoutMs,
                id: 0,
                timer: null,
                resolve,
                reject,
            });
            this._pump();
        });
    }

    /** Opens a new WebSocket. */
    _connect() {
        this.state = 'connecting';
        this.failure = '';
        const url = `ws://${this.opts.host}:${this.opts.port}${this.opts.path}`;
        let ws;
        try {
            ws = new this.WebSocket(url);
        } catch (err) {
            this.failure = err.message;
            this._onClose();
            return;
        }
        this.ws = ws;
        this.connectTimer = this.timers.setTimeout(() => {
            this.connectTimer = null;
            this._fail('Connection timed out');
        }, this.opts.connectTimeoutMs);
        ws.onopen = () => {
            this.timers.clearTimeout(this.connectTimer);
            this.connectTimer = null;
            this.log.debug(`WebSocket connected to ${url}`);
            this.state = 'ready';
            this.timeouts = 0;
            this.stableTimer = this.timers.setTimeout(() => {
                this.stableTimer = null;
                this.reconnectDelay = this.opts.reconnectMinMs;
            }, this.opts.stableMs);
            this.emit('ready');
            this._pump();
        };
        ws.onmessage = msg => this._onMessage(String(msg.data));
        ws.onerror = err => {
            this.failure ||= err?.message || err?.error?.message || 'WebSocket error';
            if (this.state === 'connecting') {
                // Node's WebSocket reports a refused connection with 'error' only; 'close' never follows
                this._fail(this.failure);
            }
        };
        ws.onclose = () => this._onClose();
    }

    /**
     * Routes a received message to the pending request or the `event` listeners.
     *
     * @param {string} text message text
     */
    _onMessage(text) {
        this.log.debug(`< ${text}`);
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        if (msg?.event !== undefined) {
            this.emit('event', msg.event);
        }
        const current = this.current;
        if (!current || msg?.id === undefined || String(msg.id) !== String(current.id)) {
            return; // an event, or a late reply to a request that already timed out
        }
        this.timers.clearTimeout(current.timer);
        this.current = null;
        this.timeouts = 0;
        current.resolve(msg);
        this._pump();
    }

    /** Sends the next queued request once the previous one is answered and pacingMs has passed. */
    _pump() {
        if (this.state !== 'ready' || this.current || this.pumpTimer || !this.queue.length) {
            return;
        }
        const remaining = this.lastSendAt + this.opts.pacingMs - Date.now();
        if (remaining > 0) {
            this.pumpTimer = this.timers.setTimeout(() => {
                this.pumpTimer = null;
                this._pump();
            }, remaining);
            return;
        }
        const item = this.queue.shift();
        item.id = this.nextId++;
        this.current = item;
        this.lastSendAt = Date.now();
        const text = JSON.stringify({ jsonrpc: '2.0', method: item.method, params: item.params, id: item.id });
        this.log.debug(`> ${text}`);
        this.ws.send(text);
        item.timer = this.timers.setTimeout(() => this._onTimeout(item), item.timeoutMs);
    }

    /**
     * Rejects an unanswered request, and drops the session after maxTimeouts in a row.
     *
     * @param {object} item the queued request
     */
    _onTimeout(item) {
        if (this.current !== item) {
            return;
        }
        this.current = null;
        const err = new Error(`No reply to "${item.method}"`);
        err.code = 'ETIMEDOUT';
        item.reject(err);
        this.timeouts++;
        if (this.timeouts >= this.opts.maxTimeouts) {
            this._fail(`No reply to ${this.timeouts} requests in a row`);
        } else {
            this._pump();
        }
    }

    /**
     * Ends the session; `_onClose` reports the reason and schedules the reconnect.
     *
     * @param {string} reason why the session is being dropped
     */
    _fail(reason) {
        this.failure = reason;
        const ws = this.ws;
        if (ws) {
            this._detach(ws);
            try {
                ws.close();
            } catch {
                // already closed or never opened
            }
        }
        this._onClose();
    }

    /**
     * Stops a socket from calling back into this client.
     *
     * @param {WebSocket} ws socket to detach
     */
    _detach(ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = () => {};
    }

    /** Cleans up after the socket closed and schedules a reconnect with backoff. */
    _onClose() {
        if (this.state === 'closed' || this.state === 'idle') {
            return;
        }
        const wasReady = this.state === 'ready';
        const reason = this.failure || (wasReady ? 'Connection closed by device' : 'Connection failed');
        if (this.ws) {
            this._detach(this.ws);
            this.ws = null;
        }
        this._clearTimers();
        this._rejectAll(reason);
        this.state = 'idle';
        this.emit('disconnected', reason, wasReady);
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(delay * 2, this.opts.reconnectMaxMs);
        this.log.debug(`Reconnecting in ${delay} ms`);
        this.reconnectTimer = this.timers.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.state === 'idle') {
                this._connect();
            }
        }, delay);
    }

    /** Clears the per-session timers (not the reconnect timer). */
    _clearTimers() {
        for (const name of ['connectTimer', 'pumpTimer', 'stableTimer']) {
            this.timers.clearTimeout(this[name]);
            this[name] = null;
        }
        if (this.current) {
            this.timers.clearTimeout(this.current.timer);
        }
    }

    /**
     * Rejects the pending request and everything queued behind it.
     *
     * @param {string} reason error message
     */
    _rejectAll(reason) {
        const pending = this.current ? [this.current, ...this.queue] : this.queue;
        this.current = null;
        this.queue = [];
        for (const item of pending) {
            item.reject(new Error(reason));
        }
    }
}

module.exports = { WsClient };
