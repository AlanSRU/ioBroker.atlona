'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

// Telnet protocol bytes (RFC 854)
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const USER_PROMPT = /^(login|username|user name)(\s+please)?\s*:?$/i;
const PASSWORD_PROMPT = /^password\s*:?$/i;
const LOGIN_OK = /^welcome to telnet/i;
const LOGIN_REJECTED = /^please try again/i;
const FULL_CONNECTIONS = /full connections/i;

const DEFAULTS = {
    pacingMs: 500,
    connectTimeoutMs: 10000,
    requestTimeoutMs: 3000,
    loginQuietMs: 1500,
    reconnectMinMs: 5000,
    reconnectMaxMs: 60000,
    stableMs: 60000,
    maxTimeouts: 2,
};

/**
 * Removes telnet IAC sequences from a byte stream. Keeps its state between chunks, because a
 * sequence can be split across two TCP packets. Every option the device offers or requests is
 * refused, which leaves the session in plain NVT mode.
 */
class TelnetDecoder {
    /** Starts in plain-data state. */
    constructor() {
        this.state = 'data';
        this.verb = 0;
    }

    /**
     * @param {Buffer} chunk bytes from the socket
     * @returns {{data: Buffer, replies: Buffer}} payload bytes, and negotiation bytes to send back
     */
    decode(chunk) {
        const data = [];
        const replies = [];
        for (const byte of chunk) {
            switch (this.state) {
                case 'data':
                    if (byte === IAC) {
                        this.state = 'iac';
                    } else {
                        data.push(byte);
                    }
                    break;
                case 'iac':
                    if (byte === IAC) {
                        data.push(IAC);
                        this.state = 'data';
                    } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
                        this.verb = byte;
                        this.state = 'option';
                    } else if (byte === SB) {
                        this.state = 'sb';
                    } else {
                        this.state = 'data'; // two-byte command (NOP, GA, ...)
                    }
                    break;
                case 'option':
                    if (this.verb === DO) {
                        replies.push(IAC, WONT, byte);
                    } else if (this.verb === WILL) {
                        replies.push(IAC, DONT, byte);
                    }
                    this.state = 'data';
                    break;
                case 'sb':
                    if (byte === IAC) {
                        this.state = 'sbIac';
                    }
                    break;
                case 'sbIac':
                    this.state = byte === SE ? 'data' : 'sb';
                    break;
            }
        }
        return { data: Buffer.from(data), replies: Buffer.from(replies) };
    }
}

/**
 * Splits text into lines on CR, LF or CR LF. Empty lines are dropped. The unterminated tail is
 * kept in `partial`, where login prompts such as "Password: " sit because they end without a newline.
 */
class LineFramer {
    /** Starts with an empty buffer. */
    constructor() {
        this.partial = '';
    }

    /**
     * @param {string} text decoded text from the socket
     * @returns {string[]} complete, trimmed, non-empty lines
     */
    push(text) {
        const parts = (this.partial + text).split(/\r\n|\r|\n/);
        this.partial = parts.pop() ?? '';
        return parts.map(line => line.trim()).filter(line => line !== '');
    }

    /** Discards the unterminated tail (used once a prompt has been handled). */
    clear() {
        this.partial = '';
    }
}

/**
 * One persistent telnet session to an Atlona device.
 *
 * - Handles the optional login prompt (Login:/Username:/Password:).
 * - Sends one command at a time, at least `pacingMs` apart, and matches the reply to it.
 * - Reconnects with exponential backoff, reset once a session has stayed up for `stableMs`.
 * - Drops the session after `maxTimeouts` consecutive unanswered commands.
 *
 * Events: `ready` (session usable), `disconnected` (reason, wasReady), `line` (unsolicited line).
 */
class TelnetClient extends EventEmitter {
    /**
     * @param {object} options connection options
     * @param {string} options.host device address
     * @param {number} options.port telnet port
     * @param {string} options.username sent when the device prompts for a login
     * @param {string} options.password sent when the device prompts for a password
     * @param {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (timer: unknown) => void}} options.timers adapter-managed timers
     * @param {{debug: (msg: string) => void}} options.log logger for traffic
     */
    constructor(options) {
        super();
        this.opts = { ...DEFAULTS, ...options };
        this.timers = options.timers;
        this.log = options.log;
        this.state = 'idle'; // idle | connecting | login | ready | closed
        this.socket = null;
        this.queue = [];
        this.current = null;
        this.lastSendAt = 0;
        this.timeouts = 0;
        this.reconnectDelay = this.opts.reconnectMinMs;
        this.failure = '';
        this.loginTimer = null;
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

    /** Closes the session for good and rejects every pending command. */
    stop() {
        this.state = 'closed';
        this._clearTimers();
        this.timers.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this._rejectAll('Connection closed');
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.on('error', () => {});
            this.socket.destroy();
            this.socket = null;
        }
    }

    /**
     * Queues a command and resolves with its reply lines.
     *
     * @param {string} command command text, without terminator
     * @param {object} [options] reply matching
     * @param {(line: string, lines: string[]) => 'done'|'more'|false} [options.accept] classifies each
     *   incoming line: 'done' ends the reply, 'more' adds the line and waits for more, false passes it
     *   on as an unsolicited `line` event. Default: the first line is the whole reply.
     * @param {number} [options.timeoutMs] reply timeout
     * @returns {Promise<string[]>} the reply lines
     */
    request(command, options = {}) {
        if (this.state !== 'ready') {
            return Promise.reject(new Error('Not connected'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({
                command,
                accept: options.accept ?? (() => 'done'),
                timeoutMs: options.timeoutMs ?? this.opts.requestTimeoutMs,
                lines: [],
                timer: null,
                resolve,
                reject,
            });
            this._pump();
        });
    }

    /** Opens a new TCP connection with fresh decoder, framer and login state. */
    _connect() {
        this.state = 'connecting';
        this.failure = '';
        this.decoder = new TelnetDecoder();
        this.text = new StringDecoder('utf8');
        this.framer = new LineFramer();
        this.userSent = false;
        this.passwordSent = false;

        const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
        this.socket = socket;
        socket.setTimeout(this.opts.connectTimeoutMs);
        socket.on('timeout', () => this._fail('Connection timed out'));
        socket.on('connect', () => {
            socket.setTimeout(0);
            socket.setKeepAlive(true, 10000);
            socket.setNoDelay(true);
            this.state = 'login';
            this.log.debug(`TCP connected to ${this.opts.host}:${this.opts.port}`);
            this._armLoginTimer();
        });
        socket.on('data', chunk => this._onData(chunk));
        socket.on('error', err => {
            this.failure ||= err.message;
        });
        socket.on('close', () => this._onClose());
    }

    /**
     * Decodes a chunk and routes each line to the login handler or the pending command.
     *
     * @param {Buffer} chunk bytes from the socket
     */
    _onData(chunk) {
        const { data, replies } = this.decoder.decode(chunk);
        if (replies.length) {
            this.socket.write(replies);
        }
        const lines = this.framer.push(this.text.write(data));
        for (const line of lines) {
            if (this.socket.destroyed) {
                return; // _fail() ended the session; the rest of the chunk is moot
            }
            this.log.debug(`< ${line}`);
            if (this.state === 'login') {
                this._onLoginLine(line);
            } else if (this.state === 'ready') {
                this._onReplyLine(line);
            }
        }
        if (this.state === 'login' && !this.socket.destroyed) {
            const partial = this.framer.partial.trim();
            if (USER_PROMPT.test(partial) || PASSWORD_PROMPT.test(partial)) {
                this.framer.clear();
                this.log.debug(`< ${partial}`);
                this._onLoginLine(partial);
            } else if (data.length) {
                this._armLoginTimer();
            }
        }
    }

    /**
     * Answers login prompts and detects login failures.
     *
     * @param {string} line a complete line, or a prompt without terminator
     */
    _onLoginLine(line) {
        if (FULL_CONNECTIONS.test(line)) {
            this._fail('Device reports "Full Connections": all telnet sessions are in use');
        } else if (LOGIN_REJECTED.test(line) || (USER_PROMPT.test(line) && this.userSent)) {
            this._fail('Login rejected: check username and password');
        } else if (USER_PROMPT.test(line)) {
            this.userSent = true;
            this.log.debug('> (username)');
            this.socket.write(`${this.opts.username}\r`);
            this._armLoginTimer();
        } else if (PASSWORD_PROMPT.test(line)) {
            if (this.passwordSent) {
                this._fail('Login rejected: check username and password');
                return;
            }
            this.passwordSent = true;
            this.log.debug('> (password)');
            this.socket.write(`${this.opts.password}\r`);
            this._armLoginTimer();
        } else if (LOGIN_OK.test(line)) {
            this._becomeReady();
        } else {
            this._armLoginTimer(); // banner text: wait for a prompt or for silence
        }
    }

    /** No prompt within loginQuietMs of the last data means the device needs no login. */
    _armLoginTimer() {
        this.timers.clearTimeout(this.loginTimer);
        this.loginTimer = this.timers.setTimeout(() => {
            this.loginTimer = null;
            if (this.state === 'login') {
                this._becomeReady();
            }
        }, this.opts.loginQuietMs);
    }

    /** Marks the session usable and starts sending queued commands. */
    _becomeReady() {
        this.timers.clearTimeout(this.loginTimer);
        this.loginTimer = null;
        this.state = 'ready';
        this.timeouts = 0;
        this.stableTimer = this.timers.setTimeout(() => {
            this.stableTimer = null;
            this.reconnectDelay = this.opts.reconnectMinMs;
        }, this.opts.stableMs);
        this.emit('ready');
        this._pump();
    }

    /**
     * Offers a line to the pending command; anything it does not accept is unsolicited.
     *
     * @param {string} line a complete line
     */
    _onReplyLine(line) {
        const current = this.current;
        const verdict = current ? current.accept(line, current.lines) : false;
        if (!verdict) {
            this.emit('line', line);
            return;
        }
        current.lines.push(line);
        if (verdict === 'done') {
            this.timers.clearTimeout(current.timer);
            this.current = null;
            this.timeouts = 0;
            current.resolve(current.lines);
            this._pump();
        }
    }

    /** Sends the next queued command once the previous one is answered and pacingMs has passed. */
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
        this.current = item;
        this.lastSendAt = Date.now();
        this.log.debug(`> ${item.command}`);
        this.socket.write(`${item.command}\r`);
        item.timer = this.timers.setTimeout(() => this._onTimeout(item), item.timeoutMs);
    }

    /**
     * Rejects an unanswered command, and drops the session after maxTimeouts in a row.
     *
     * @param {object} item the queued command
     */
    _onTimeout(item) {
        if (this.current !== item) {
            return;
        }
        this.current = null;
        const err = new Error(`No reply to "${item.command}"`);
        err.code = 'ETIMEDOUT';
        item.reject(err);
        this.timeouts++;
        if (this.timeouts >= this.opts.maxTimeouts) {
            this._fail(`No reply to ${this.timeouts} commands in a row`);
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
        this.socket?.destroy();
    }

    /** Cleans up after the socket closed and schedules a reconnect with backoff. */
    _onClose() {
        const wasReady = this.state === 'ready';
        const reason = this.failure || 'Connection closed by device';
        this.socket?.removeAllListeners();
        this.socket?.on('error', () => {});
        this.socket = null;
        this._clearTimers();
        this._rejectAll(reason);
        if (this.state === 'closed') {
            return;
        }
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
        for (const name of ['loginTimer', 'pumpTimer', 'stableTimer']) {
            this.timers.clearTimeout(this[name]);
            this[name] = null;
        }
        if (this.current) {
            this.timers.clearTimeout(this.current.timer);
        }
    }

    /**
     * Rejects the pending command and everything queued behind it.
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

module.exports = { TelnetClient, TelnetDecoder, LineFramer };
