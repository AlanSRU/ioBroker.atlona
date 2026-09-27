'use strict';

/**
 * Colon/JSON dialect (AT-UHD-SW-510W), over telnet or over the JSON-RPC WebSocket.
 *
 * Every command is described once as a spec: `{ method, args, params }`. Telnet sends
 * `<method> <args...>`, and the WebSocket sends `{"method":..,"params":{..}}`. `params: null` marks
 * a command whose WebSocket parameter names are unknown.
 *
 * Telnet (captured on fw 2.9.8): each reply is one line of compact JSON (or plain text, e.g. `on` for
 * Display:Minimal:Get), followed by a `#` prompt line. JSON replies echo the command, exactly as sent,
 * in `methodreturn`. Errors: `Error: Unknown Command - '<cmd>'`, or JSON with an `error` member. Some
 * replies take many seconds, so a late reply can arrive while the next command is pending;
 * `methodreturn` tells them apart.
 *
 * WebSocket `ws://<ip>/API` (fw 2.9.8): JSON-RPC 2.0. `params` must be an object. Replies use the REST
 * formats (e.g. `{"volume":-20}`) and echo the `id`. A missing parameter gives
 * `{"error":"Invalid parameter: <name>"}`, and an unknown method gets a reply with neither `result`
 * nor `error`. Several clients may connect at once, and events are pushed to every client.
 */

const PROMPT = '#';
const QUERY_TIMEOUT_MS = 8000;
const SET_TIMEOUT_MS = 20000; // Sets have taken over 15 s on a real SW-510W

const normalise = text => String(text).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * @param {string} method API method
 * @param {Array<string | number>} [args] telnet arguments, in order
 * @param {object | null} [params] WebSocket parameters; null if unknown
 * @returns {{method: string, args: Array<string | number>, params: object | null}} command spec
 */
const spec = (method, args = [], params = {}) => ({ method, args, params });

/**
 * @param {string} line a reply line
 * @returns {object | null} the parsed JSON object, or null if the line is not JSON
 */
function parseJson(line) {
    if (!line.startsWith('{')) {
        return null;
    }
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * Reply matcher for TelnetClient.request(): collects lines up to each `#` prompt and ends the reply
 * at the first group that belongs to `command`. A group holding only JSON for another command (a
 * late reply to an earlier, timed-out command) or only events is skipped.
 *
 * @param {string} command the command sent
 * @returns {(line: string) => 'done' | 'more'} accept function
 */
function makeAccept(command) {
    const key = normalise(command);
    let group = [];
    return line => {
        if (line !== PROMPT) {
            group.push(line);
            return 'more';
        }
        const mine = group.some(l => {
            const obj = parseJson(l);
            return obj ? obj.methodreturn !== undefined && normalise(obj.methodreturn) === key : true;
        });
        group = [];
        return mine ? 'done' : 'more';
    };
}

/**
 * Extracts the reply to `command` from the collected telnet lines.
 *
 * @param {string} command the command sent
 * @param {string[]} lines lines collected by makeAccept
 * @returns {object | string} the JSON `result`, or the plain-text reply
 */
function interpret(command, lines) {
    const key = normalise(command);
    const own = lines.filter(line => {
        if (line === PROMPT) {
            return false;
        }
        const obj = parseJson(line);
        return !obj || (obj.methodreturn !== undefined && normalise(obj.methodreturn) === key);
    });
    const obj = own.map(parseJson).find(Boolean);
    if (obj) {
        if (obj.error !== undefined || obj.result === undefined) {
            const detail = typeof obj.error === 'string' ? `: ${obj.error}` : '';
            throw new DeviceError(`Device rejected "${command}"${detail}`);
        }
        return obj.result;
    }
    const text = own.join('\n').trim();
    if (/^error:|unknown command|command fail/i.test(text)) {
        throw new DeviceError(`Device rejected "${command}": ${text}`);
    }
    return text;
}

/** The device answered, but refused or did not understand the command. */
class DeviceError extends Error {}

/** Sends specs over a TelnetClient. */
class TelnetLink {
    /**
     * @param {import('../transport/telnet').TelnetClient} transport telnet session
     * @param {{debug: (msg: string) => void}} log logger
     */
    constructor(transport, log) {
        this.transport = transport;
        this.log = log;
        this.onEvent = () => {};
        transport.on('line', line => this.handleLine(line));
    }

    /**
     * @param {{method: string, args: Array<string | number>}} s command spec
     * @param {number} timeoutMs reply timeout
     * @returns {Promise<object | string>} JSON result or plain text
     */
    async call(s, timeoutMs) {
        const cmd = [s.method, ...s.args].join(' ');
        const lines = await this.transport.request(cmd, { accept: makeAccept(cmd), timeoutMs });
        for (const line of lines) {
            if (parseJson(line)?.event) {
                this.handleLine(line); // an event can arrive between a command and its reply
            }
        }
        return interpret(cmd, lines);
    }

    /**
     * Handles a line that is not the reply to a pending command.
     *
     * @param {string} line unsolicited line
     */
    handleLine(line) {
        const event = parseJson(line)?.event;
        if (event) {
            this.onEvent(event);
        } else if (line !== PROMPT) {
            this.log.debug(`Unsolicited: ${line}`);
        }
    }
}

/** Sends specs over a WsClient (JSON-RPC). */
class WsLink {
    /** @param {import('../transport/ws').WsClient} transport WebSocket session */
    constructor(transport) {
        this.transport = transport;
        this.byodFromEvents = true; // see Display:Input:All:Get in statusQueries
        this.onEvent = () => {};
        transport.on('event', event => this.onEvent(event));
    }

    /**
     * @param {{method: string, params: object | null}} s command spec
     * @param {number} timeoutMs reply timeout
     * @returns {Promise<object>} JSON result
     */
    async call(s, timeoutMs) {
        if (s.params === null) {
            throw new RangeError(`${s.method} is not available over the WebSocket connection; use telnet`);
        }
        const msg = await this.transport.request(s.method, s.params, { timeoutMs });
        if (msg.error !== undefined) {
            const detail = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
            throw new DeviceError(`Device rejected "${s.method}": ${detail}`);
        }
        if (msg.result === undefined) {
            throw new DeviceError(`Device does not support "${s.method}"`);
        }
        return msg.result;
    }
}

/**
 * @param {unknown} value a reported value
 * @returns {number | undefined} a finite number, or undefined when nothing usable was reported
 */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {unknown} value a reported value
 * @returns {boolean | undefined} the boolean, or undefined when nothing usable was reported
 */
function bool(value) {
    return typeof value === 'boolean' ? value : undefined;
}

/**
 * Converts a user-written number. `Number(null)`, `Number('')` and `Number(false)` are all 0, which
 * would be a real (and for volume, the loudest) value, so blanks and booleans are rejected instead.
 *
 * @param {unknown} value value written by the user
 * @returns {number} the number
 */
function userNumber(value) {
    const n =
        typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) {
        throw new RangeError(`${JSON.stringify(value)} is not a number`);
    }
    return n;
}

/**
 * Converts a user-written boolean. `Boolean('false')` is true, so only true/false, 1/0 and their
 * string forms are accepted.
 *
 * @param {unknown} value value written by the user
 * @returns {boolean} the boolean
 */
function userBool(value) {
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    if (value === false || value === 0 || value === 'false' || value === '0') {
        return false;
    }
    throw new RangeError(`${JSON.stringify(value)} is not true or false`);
}

/**
 * @param {unknown} value value written by the user
 * @param {number} min lowest allowed integer
 * @param {number} max highest allowed integer
 * @returns {number} the integer
 */
function intIn(value, min, max) {
    const n = userNumber(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new RangeError(`Value must be a whole number from ${min} to ${max}`);
    }
    return n;
}

/**
 * Status queries. `apply` maps the reply (telnet or WebSocket format) to [stateId, value] pairs;
 * undefined values are dropped.
 *
 * @param {object} def model definition
 * @param {{byodFromEvents?: boolean}} [options] link quirks
 * @returns {Array<{spec: object, apply: (reply: object | string) => Array<[string, unknown]>}>} queries
 */
function statusQueries(def, options = {}) {
    const queries = [
        {
            spec: spec('Display:Input:Get'),
            apply: r => [['control.source', num(r.input) === undefined ? undefined : r.input + 1]],
        },
        { spec: spec('Audio:Volume:Get'), apply: r => [['control.volume', num(r.volume?.value ?? r.volume)]] },
        {
            spec: spec('Audio:Mute:Get'),
            apply: r => [
                ['control.muteHdmi', bool(r.outputmute?.hdmi ?? r.mutehdmi)],
                ['control.muteAnalog', bool(r.outputmute?.analog ?? r.muteanalog)],
            ],
        },
        {
            spec: spec('Display:Minimal:Get'),
            // telnet: plain text "on", "off", or "false" when no display is connected; WebSocket: {state}
            apply: r => [['control.display', typeof r === 'string' ? /^(on|true)$/i.test(r) : bool(r.state)]],
        },
        // Audio:GetSource is not polled: on fw 2.9.8 it kept reporting "digital" after an accepted
        // "Audio:SetSource 1 analog" with input 2 active, so it does not reflect the per-input setting.
        {
            spec: spec('Display:Matrix:Mode:Get'),
            apply: r => {
                const mode = bool(r.mode);
                return [
                    [
                        'control.matrixMode',
                        mode === undefined ? undefined : !mode ? 0 : /static/i.test(r.subtype ?? '') ? 2 : 1,
                    ],
                ];
            },
        },
    ];
    def.outputs.forEach((_, i) => {
        queries.push({
            spec: spec('Display:Matrix:Get', [i], { output: i }),
            apply: r => [[`outputs.${i + 1}.source`, num(r.input) === undefined ? undefined : r.input + 1]],
        });
    });
    if (def.inputSignal) {
        queries.push({
            spec: spec('Display:Input:All:Get'),
            // Over the WebSocket this query reported the wireless (BYOD) input as active with no client
            // connected, while telnet and the pushed events said false. That entry is the one with a
            // `type` member; over the WebSocket it is left to the pushed events.
            apply: r =>
                def.inputs.map((_, i) => [
                    `inputs.${i + 1}.signal`,
                    options.byodFromEvents && r[i]?.type !== undefined ? undefined : bool(r[i]?.status),
                ]),
        });
    }
    for (const n of def.hdcpInputs ?? []) {
        queries.push({
            spec: spec('Display:Input:HDCP:State:Get', [n - 1], { input: n - 1 }),
            apply: r => [[`inputs.${n}.hdcp`, bool(r.state)]],
        });
    }
    if (def.temperature) {
        queries.push({
            spec: spec('Instruments:Temperature:Get'),
            apply: r => [['info.temperature', num(r.value ?? r.temperature?.value)]],
        });
    }
    return queries;
}

/** Queries asked once per connection. */
const IDENTITY_QUERIES = [
    {
        spec: spec('Misc:Model:Get'),
        apply: r => [['info.model', typeof r.model === 'string' ? r.model : undefined]],
    },
    {
        spec: spec('Misc:Versions:Get'),
        apply: r => {
            const v = r.versions ?? r;
            return [
                [
                    'info.firmware',
                    typeof v.master === 'string' ? `${v.master}${v.mcu ? ` (MCU ${v.mcu})` : ''}` : undefined,
                ],
            ];
        },
    },
];

/**
 * Maps a pushed event to state updates. Captured on fw 2.9.8 (telnet and WebSocket alike):
 * `{"jsonrpc":"2.0","event":{"output":{"0":{"input":4,"state":true},...},"input":{"0":{"status":false},...}}}`
 * and `{"jsonrpc":"2.0","event":{"output":[4,4]}}`. The meaning of `output.<n>.state` is unknown, so it is ignored.
 *
 * @param {object} def model definition
 * @param {object} event the `event` member
 * @returns {Array<[string, unknown]>} state updates
 */
function eventUpdates(def, event) {
    const updates = [];
    const output = event?.output;
    def.outputs.forEach((_, i) => {
        const input = Array.isArray(output) ? output[i] : output?.[i]?.input;
        if (num(input) !== undefined) {
            updates.push([`outputs.${i + 1}.source`, input + 1]);
        }
    });
    if (def.inputSignal) {
        def.inputs.forEach((_, i) => {
            const signal = bool(event?.input?.[i]?.status);
            if (signal !== undefined) {
                updates.push([`inputs.${i + 1}.signal`, signal]);
            }
        });
    }
    return updates;
}

/**
 * Driver for the colon/JSON dialect. Returns state updates as [id, value] pairs; the adapter writes them.
 */
class ColonDriver {
    /**
     * @param {object} def model definition
     * @param {TelnetLink | WsLink} link connection to the device
     * @param {{debug: (msg: string) => void}} log logger
     * @param {(updates: Array<[string, unknown]>) => void} onPush receives updates from pushed events
     */
    constructor(def, link, log, onPush) {
        this.def = def;
        this.link = link;
        this.log = log;
        link.onEvent = event => {
            const updates = eventUpdates(def, event);
            if (updates.length) {
                onPush(updates);
            }
        };
        this.queries = statusQueries(def, { byodFromEvents: link.byodFromEvents });
        this.unsupported = new Set();
        this.activeInput = undefined; // 1-based, for Audio:SetSource
    }

    /**
     * Runs queries, skipping any the firmware does not know.
     *
     * @param {Array<{spec: object, apply: (reply: object | string) => Array<[string, unknown]>}>} queries queries to run
     * @returns {Promise<Array<[string, unknown]>>} state updates
     */
    async run(queries) {
        const updates = [];
        for (const query of queries) {
            const key = [query.spec.method, ...query.spec.args].join(' ');
            if (this.unsupported.has(key)) {
                continue;
            }
            let reply;
            try {
                reply = await this.link.call(query.spec, QUERY_TIMEOUT_MS);
            } catch (err) {
                if (!(err instanceof DeviceError)) {
                    throw err; // timeout or connection lost: end this poll
                }
                this.unsupported.add(key);
                this.log.debug(`${err.message}; not asking again on this connection`);
                continue;
            }
            for (const [id, val] of query.apply(reply)) {
                if (val !== undefined) {
                    updates.push([id, val]);
                }
            }
        }
        this.track(updates);
        return updates;
    }

    /** @returns {Promise<Array<[string, unknown]>>} identity states (model, firmware) */
    identify() {
        return this.run(IDENTITY_QUERIES);
    }

    /** @returns {Promise<Array<[string, unknown]>>} current device status */
    poll() {
        return this.run(this.queries);
    }

    /** @param {Array<[string, unknown]>} updates updates to remember the active input from */
    track(updates) {
        for (const [id, val] of updates) {
            if (id === 'control.source') {
                this.activeInput = val;
            }
        }
    }

    /**
     * Executes a user command.
     *
     * @param {string} id state id relative to the adapter namespace
     * @param {ioBroker.StateValue} val value written by the user
     * @returns {Promise<Array<[string, unknown]>>} confirmed state updates
     */
    async command(id, val) {
        const { inputs, outputs, volume } = this.def;
        let match;
        let updates;

        if (id === 'control.source') {
            const n = intIn(val, 1, inputs.length);
            const r = await this.confirm(spec('Display:Input:Set', [n - 1], { input: n - 1 }));
            updates = [['control.source', num(r?.activeinput) === undefined ? n : r.activeinput + 1]];
        } else if (id === 'control.volume') {
            const dB = Math.round(Math.min(volume.max, Math.max(volume.min, userNumber(val))));
            await this.confirm(spec('Audio:Volume:Set', [dB], { volume: dB }));
            updates = [['control.volume', dB]];
        } else if (id === 'control.muteHdmi' || id === 'control.muteAnalog') {
            const port = id === 'control.muteHdmi' ? 'hdmi' : 'analog';
            const on = userBool(val);
            await this.confirm(spec('Audio:Mute:Set', [port, String(on)], { [port]: on }));
            updates = [[id, on]];
        } else if (id === 'control.display') {
            const on = userBool(val);
            await this.confirm(spec('Display:Minimal:Set', [on ? 1 : 0], { state: on ? 1 : 0 }));
            updates = [[id, on]];
        } else if (id === 'control.audioSource') {
            if (val !== 'digital' && val !== 'analog') {
                throw new RangeError('Audio source must be "digital" or "analog"');
            }
            if (!(this.activeInput >= 1 && this.activeInput <= 4)) {
                throw new RangeError('The audio source can only be set while a wired input (1 to 4) is active');
            }
            await this.confirm(spec('Audio:SetSource', [this.activeInput - 1, val], null));
            updates = [[id, val]];
        } else if (id === 'control.matrixMode') {
            const mode = intIn(val, 0, 2);
            await this.confirm(spec('Display:Matrix:Mode:Set', [mode], { mode }));
            updates = [[id, mode]];
        } else if ((match = /^outputs\.(\d+)\.source$/.exec(id))) {
            const out = intIn(match[1], 1, outputs.length);
            const n = intIn(val, 1, inputs.length);
            try {
                await this.confirm(spec('Display:Matrix:Set', [n - 1, out - 1], { input: n - 1, output: out - 1 }));
            } catch (err) {
                throw err instanceof DeviceError ? new DeviceError(`${err.message}. Is matrix mode on?`) : err;
            }
            updates = [[id, n]];
        } else if ((match = /^inputs\.(\d+)\.hdcp$/.exec(id)) && this.def.hdcpInputs?.includes(Number(match[1]))) {
            const i = Number(match[1]) - 1;
            const on = userBool(val);
            await this.confirm(spec('Display:Input:HDCP:State:Set', [i, on ? 1 : 0], { input: i, state: on ? 1 : 0 }));
            updates = [[id, on]];
        } else if (id === 'commands.reboot' || id === 'commands.byodKick') {
            // Buttons act on true only: writing false (a script "resetting" the button, a toggle widget)
            // must not reboot the switcher or disconnect every wireless presenter.
            if (userBool(val)) {
                await this.confirm(spec(id === 'commands.reboot' ? 'Platform:Restart' : 'Display:BYOD:Kick'));
            }
            updates = [];
        } else {
            throw new RangeError(`${id} is not writable`);
        }
        this.track(updates);
        return updates;
    }

    /**
     * Sends a Set command and checks that the device did not report failure.
     *
     * @param {{method: string, args: Array<string | number>, params: object | null}} s command spec
     * @returns {Promise<object | string>} the reply
     */
    async confirm(s) {
        const r = await this.link.call(s, SET_TIMEOUT_MS);
        if (typeof r === 'object' && r.success === false) {
            throw new DeviceError(`Device rejected "${s.method}"`);
        }
        return r;
    }
}

module.exports = { ColonDriver, TelnetLink, WsLink, DeviceError, makeAccept, interpret, statusQueries, eventUpdates };
