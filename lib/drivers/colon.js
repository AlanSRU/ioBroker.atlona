'use strict';

/**
 * Colon/JSON dialect (AT-UHD-SW-510W) over telnet.
 *
 * Captured on an SW-510W, firmware 2.9.8: every reply is one line of compact JSON (or plain text,
 * e.g. `on` for Display:Minimal:Get) followed by a `#` prompt line. JSON replies echo the command,
 * exactly as sent, in `methodreturn`. Errors: `Error: Unknown Command - '<cmd>'`, or JSON with an
 * `error` member. Some replies take over a second, so a late reply can arrive while the next command
 * is pending; `methodreturn` is what tells them apart.
 */

const PROMPT = '#';
const REPLY_TIMEOUT_MS = 5000;

const normalise = text => String(text).trim().replace(/\s+/g, ' ').toLowerCase();

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
 * late reply to an earlier, timed-out command) is skipped.
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
 * Extracts the reply to `command` from the collected lines.
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
 * @param {unknown} value value written by the user
 * @param {number} min lowest allowed integer
 * @param {number} max highest allowed integer
 * @returns {number} the integer
 */
function intIn(value, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new RangeError(`Value must be a whole number from ${min} to ${max}`);
    }
    return n;
}

/**
 * Status queries. `apply` maps the reply to [stateId, value] pairs; undefined values are dropped.
 *
 * @param {object} def model definition
 * @returns {Array<{cmd: string, apply: (reply: object | string) => Array<[string, unknown]>}>} queries
 */
function statusQueries(def) {
    const queries = [
        {
            cmd: 'Display:Input:Get',
            apply: r => [['control.source', num(r.input) === undefined ? undefined : r.input + 1]],
        },
        { cmd: 'Audio:Volume:Get', apply: r => [['control.volume', num(r.volume?.value ?? r.volume)]] },
        {
            cmd: 'Audio:Mute:Get',
            apply: r => [
                ['control.muteHdmi', bool(r.outputmute?.hdmi)],
                ['control.muteAnalog', bool(r.outputmute?.analog)],
            ],
        },
        {
            cmd: 'Display:Minimal:Get',
            // plain text: "on", "off", or "false" when no display is connected
            apply: r => [['control.display', typeof r === 'string' ? /^(on|true)$/i.test(r) : bool(r.state)]],
        },
        {
            cmd: 'Audio:GetSource',
            apply: r => [['control.audioSource', typeof r.audiosource === 'string' ? r.audiosource : undefined]],
        },
        {
            cmd: 'Display:Matrix:Mode:Get',
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
            cmd: `Display:Matrix:Get ${i}`,
            apply: r => [[`outputs.${i + 1}.source`, num(r.input) === undefined ? undefined : r.input + 1]],
        });
    });
    if (def.inputSignal) {
        queries.push({
            cmd: 'Display:Input:All:Get',
            apply: r => def.inputs.map((_, i) => [`inputs.${i + 1}.signal`, bool(r[i]?.status)]),
        });
    }
    for (const n of def.hdcpInputs ?? []) {
        queries.push({
            cmd: `Display:Input:HDCP:State:Get ${n - 1}`,
            apply: r => [[`inputs.${n}.hdcp`, bool(r.state)]],
        });
    }
    if (def.temperature) {
        queries.push({ cmd: 'Instruments:Temperature:Get', apply: r => [['info.temperature', num(r.value)]] });
    }
    return queries;
}

/** Queries asked once per connection. */
const IDENTITY_QUERIES = [
    { cmd: 'Misc:Model:Get', apply: r => [['info.model', typeof r.model === 'string' ? r.model : undefined]] },
    {
        cmd: 'Misc:Versions:Get',
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
 * Maps a pushed event to state updates. Captured after Set commands on fw 2.9.8:
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
     * @param {import('../transport/telnet').TelnetClient} transport open telnet session
     * @param {{debug: (msg: string) => void}} log logger
     * @param {(updates: Array<[string, unknown]>) => void} onPush receives updates from pushed events
     */
    constructor(def, transport, log, onPush) {
        this.def = def;
        this.transport = transport;
        this.log = log;
        this.onPush = onPush;
        transport.on('line', line => this.handleLine(line));
        this.queries = statusQueries(def);
        this.unsupported = new Set();
        this.activeInput = undefined; // 1-based, for Audio:SetSource
    }

    /**
     * Sends a command and returns its interpreted reply.
     *
     * @param {string} cmd command text
     * @returns {Promise<object | string>} JSON result or plain text
     */
    async send(cmd) {
        const lines = await this.transport.request(cmd, { accept: makeAccept(cmd), timeoutMs: REPLY_TIMEOUT_MS });
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
            const updates = eventUpdates(this.def, event);
            if (updates.length) {
                this.onPush(updates);
            }
        } else if (line !== PROMPT) {
            this.log.debug(`Unsolicited: ${line}`);
        }
    }

    /**
     * Runs queries, skipping any the firmware does not know.
     *
     * @param {Array<{cmd: string, apply: (reply: object | string) => Array<[string, unknown]>}>} queries queries to run
     * @returns {Promise<Array<[string, unknown]>>} state updates
     */
    async run(queries) {
        const updates = [];
        for (const query of queries) {
            if (this.unsupported.has(query.cmd)) {
                continue;
            }
            let reply;
            try {
                reply = await this.send(query.cmd);
            } catch (err) {
                if (!(err instanceof DeviceError)) {
                    throw err; // timeout or connection lost: end this poll
                }
                this.unsupported.add(query.cmd);
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
        const onOff = val ? 1 : 0;
        let match;
        let updates;

        if (id === 'control.source') {
            const n = intIn(val, 1, inputs.length);
            const r = await this.send(`Display:Input:Set ${n - 1}`);
            updates = [['control.source', num(r.activeinput) === undefined ? n : r.activeinput + 1]];
        } else if (id === 'control.volume') {
            const dB = Math.round(Math.min(volume.max, Math.max(volume.min, Number(val))));
            if (!Number.isFinite(dB)) {
                throw new RangeError('Volume must be a number');
            }
            await this.confirm(`Audio:Volume:Set ${dB}`);
            updates = [['control.volume', dB]];
        } else if (id === 'control.muteHdmi' || id === 'control.muteAnalog') {
            const port = id === 'control.muteHdmi' ? 'hdmi' : 'analog';
            await this.confirm(`Audio:Mute:Set ${port} ${Boolean(val)}`);
            updates = [[id, Boolean(val)]];
        } else if (id === 'control.display') {
            await this.confirm(`Display:Minimal:Set ${onOff}`);
            updates = [[id, Boolean(val)]];
        } else if (id === 'control.audioSource') {
            if (val !== 'digital' && val !== 'analog') {
                throw new RangeError('Audio source must be "digital" or "analog"');
            }
            if (!(this.activeInput >= 1 && this.activeInput <= 4)) {
                throw new RangeError('The audio source can only be set while a wired input (1 to 4) is active');
            }
            await this.confirm(`Audio:SetSource ${this.activeInput - 1} ${val}`);
            updates = [[id, val]];
        } else if (id === 'control.matrixMode') {
            const mode = intIn(val, 0, 2);
            await this.confirm(`Display:Matrix:Mode:Set ${mode}`);
            updates = [[id, mode]];
        } else if ((match = /^outputs\.(\d+)\.source$/.exec(id))) {
            const out = intIn(match[1], 1, outputs.length);
            const n = intIn(val, 1, inputs.length);
            try {
                await this.confirm(`Display:Matrix:Set ${n - 1} ${out - 1}`);
            } catch (err) {
                throw err instanceof DeviceError ? new DeviceError(`${err.message}. Is matrix mode on?`) : err;
            }
            updates = [[id, n]];
        } else if ((match = /^inputs\.(\d+)\.hdcp$/.exec(id)) && this.def.hdcpInputs?.includes(Number(match[1]))) {
            await this.confirm(`Display:Input:HDCP:State:Set ${Number(match[1]) - 1} ${onOff}`);
            updates = [[id, Boolean(val)]];
        } else if (id === 'commands.reboot') {
            await this.confirm('Platform:Restart');
            updates = [];
        } else if (id === 'commands.byodKick') {
            await this.confirm('Display:BYOD:Kick');
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
     * @param {string} cmd command text
     */
    async confirm(cmd) {
        const r = await this.send(cmd);
        if (typeof r === 'object' && r.success === false) {
            throw new DeviceError(`Device rejected "${cmd}"`);
        }
    }
}

module.exports = { ColonDriver, DeviceError, makeAccept, interpret, statusQueries, eventUpdates };
