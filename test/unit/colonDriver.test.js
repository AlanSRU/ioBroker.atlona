'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const {
    ColonDriver,
    TelnetLink,
    WsLink,
    DeviceError,
    makeAccept,
    interpret,
    eventUpdates,
} = require('../../lib/drivers/colon');
const { TelnetClient } = require('../../lib/transport/telnet');
const { MODELS } = require('../../lib/models');
const { buildObjects } = require('../../lib/stateTree');
const { BANNER, REPLIES, SET_REPLIES, EVENTS } = require('./fixtures/sw510w-telnet');

const DEF = MODELS['sw-510w'];

/** Splits a raw device reply into lines the way the transport's framer does. */
const linesOf = reply => [
    ...reply
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean),
    '#',
];

/** Runs a reply through makeAccept, as TelnetClient.request() would. */
function collect(command, raw) {
    const accept = makeAccept(command);
    const lines = [];
    for (const line of raw.flatMap(linesOf)) {
        lines.push(line);
        if (accept(line) === 'done') {
            return lines;
        }
    }
    return null;
}

describe('Colon dialect: reply parsing (SW-510W captures)', () => {
    it('returns the JSON result of a matching reply', () => {
        const lines = collect('Audio:Volume:Get', [REPLIES['Audio:Volume:Get']]);
        assert.deepEqual(interpret('Audio:Volume:Get', lines), { volume: { units: 'dB', value: -20 } });
    });

    it('returns plain-text replies (Display:Minimal:Get)', () => {
        const lines = collect('Display:Minimal:Get', [REPLIES['Display:Minimal:Get']]);
        assert.equal(interpret('Display:Minimal:Get', lines), 'on');
    });

    it('matches methodreturn regardless of case and spacing', () => {
        const lines = collect('display:matrix:get  0', [REPLIES['Display:Matrix:Get 0']]);
        assert.deepEqual(interpret('display:matrix:get  0', lines), { input: 4 });
    });

    it('skips a late reply to an earlier command', () => {
        const raw = [REPLIES['Display:InputState:Get 1'], REPLIES['Audio:Mute:Get']];
        const lines = collect('Audio:Mute:Get', raw);
        assert.ok(lines, 'reply completed');
        assert.deepEqual(interpret('Audio:Mute:Get', lines), { outputmute: { analog: false, hdmi: false } });
    });

    it('throws DeviceError for "Unknown Command", JSON errors and "Command Failure"', () => {
        assert.throws(() => interpret('Type', collect('Type', [REPLIES.Type])), DeviceError);
        const hdcp = 'Display:Input:HDCP:State:Get 4';
        assert.throws(() => interpret(hdcp, collect(hdcp, [REPLIES[hdcp]])), DeviceError);
        assert.throws(() => interpret('Display:Matrix:Set 1 0', ['Command Failure', '#']), DeviceError);
        const route = 'Display:Matrix:Set 4 0';
        assert.throws(() => interpret(route, collect(route, [SET_REPLIES[route]])), /Command Failure/);
    });
});

/** A fake transport that answers from the capture table, and records every command sent. */
function fakeTransport(extra = {}) {
    const sent = [];
    return {
        sent,
        on() {},
        async request(cmd, { accept }) {
            sent.push(cmd);
            const reply =
                extra[cmd] ?? REPLIES[cmd] ?? SET_REPLIES[cmd] ?? `{"result":{"success":true},"methodreturn":"${cmd}"}`;
            const lines = [];
            for (const line of linesOf(reply)) {
                lines.push(line);
                if (accept(line) === 'done') {
                    return lines;
                }
            }
            throw new Error('reply never completed');
        },
    };
}

const quietLog = { debug: () => {} };

describe('Colon dialect: status poll', () => {
    it('maps every captured reply to the SW-510W state tree', async () => {
        const driver = new ColonDriver(DEF, new TelnetLink(fakeTransport(), quietLog), quietLog, () => {});
        const updates = Object.fromEntries(await driver.poll());
        assert.deepEqual(updates, {
            'control.source': 5,
            'control.volume': -20,
            'control.muteHdmi': false,
            'control.muteAnalog': false,
            'control.display': true,
            'control.matrixMode': 0,
            'outputs.1.source': 5,
            'outputs.2.source': 5,
            'inputs.1.signal': false,
            'inputs.2.signal': true,
            'inputs.3.signal': false,
            'inputs.4.signal': false,
            'inputs.5.signal': false,
            'inputs.1.hdcp': true,
            'inputs.2.hdcp': true,
            'inputs.3.hdcp': true,
            'inputs.4.hdcp': true,
            'info.temperature': 57,
        });
    });

    it('only writes states that exist in the tree', async () => {
        const ids = new Set(buildObjects(DEF).map(o => o._id));
        const driver = new ColonDriver(DEF, new TelnetLink(fakeTransport(), quietLog), quietLog, () => {});
        for (const [id] of [...(await driver.poll()), ...(await driver.identify())]) {
            assert.ok(ids.has(id), `${id} is not in the state tree`);
        }
    });

    it('reads model and firmware', async () => {
        const driver = new ColonDriver(DEF, new TelnetLink(fakeTransport(), quietLog), quietLog, () => {});
        assert.deepEqual(Object.fromEntries(await driver.identify()), {
            'info.model': 'AT-UHD-SW-510W',
            'info.firmware': '2.9.8 (MCU 1.1.41)',
        });
    });

    it('stops asking for a query the firmware does not know', async () => {
        const transport = fakeTransport({
            'Display:Input:All:Get': "Error: Unknown Command - 'Display:Input:All:Get'",
        });
        const driver = new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, () => {});
        const first = Object.fromEntries(await driver.poll());
        assert.equal(first['inputs.1.signal'], undefined);
        await driver.poll();
        assert.equal(transport.sent.filter(c => c === 'Display:Input:All:Get').length, 1);
    });

    it('never turns a missing value into a real one', async () => {
        const transport = fakeTransport({
            'Audio:Volume:Get': '{"result":{},"methodreturn":"Audio:Volume:Get"}',
            'Display:Input:Get': '{"result":{"type":"unknown"},"methodreturn":"Display:Input:Get"}',
        });
        const updates = Object.fromEntries(
            await new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, () => {}).poll(),
        );
        assert.equal('control.volume' in updates, false);
        assert.equal('control.source' in updates, false);
    });

    it('also understands the REST reply formats', async () => {
        const transport = fakeTransport({
            'Audio:Volume:Get': '{"result":{"volume":-35},"methodreturn":"Audio:Volume:Get"}',
            'Misc:Versions:Get': '{"result":{"mcu":"1.1.41","master":"2.9.8"},"methodreturn":"Misc:Versions:Get"}',
        });
        const driver = new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, () => {});
        assert.equal(Object.fromEntries(await driver.poll())['control.volume'], -35);
        assert.equal(Object.fromEntries(await driver.identify())['info.firmware'], '2.9.8 (MCU 1.1.41)');
    });
});

describe('Colon dialect: commands', () => {
    const run = async (id, val, extra) => {
        const transport = fakeTransport(extra);
        const driver = new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, () => {});
        driver.activeInput = 2;
        const updates = await driver.command(id, val);
        return { sent: transport.sent, updates };
    };

    it('switches the active input (1-based state, 0-based device index)', async () => {
        const { sent, updates } = await run('control.source', 3, {
            'Display:Input:Set 2': '{"result":{"activeinput":2},"methodreturn":"Display:Input:Set 2","jsonrpc":"2.0"}',
        });
        assert.deepEqual(sent, ['Display:Input:Set 2']);
        assert.deepEqual(updates, [['control.source', 3]]);
    });

    it('rejects an input number out of range without sending anything', async () => {
        const transport = fakeTransport();
        await assert.rejects(
            new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, () => {}).command('control.source', 6),
            RangeError,
        );
        assert.deepEqual(transport.sent, []);
    });

    it('clamps and rounds the volume to the model range', async () => {
        assert.deepEqual((await run('control.volume', -95)).sent, ['Audio:Volume:Set -80']);
        assert.deepEqual((await run('control.volume', 4)).sent, ['Audio:Volume:Set 0']);
        assert.deepEqual((await run('control.volume', -20.4)).sent, ['Audio:Volume:Set -20']);
    });

    it('builds mute, display, matrix mode and HDCP commands', async () => {
        assert.deepEqual((await run('control.muteHdmi', true)).sent, ['Audio:Mute:Set hdmi true']);
        assert.deepEqual((await run('control.muteAnalog', false)).sent, ['Audio:Mute:Set analog false']);
        assert.deepEqual((await run('control.display', false)).sent, ['Display:Minimal:Set 0']);
        assert.deepEqual((await run('control.matrixMode', 2)).sent, ['Display:Matrix:Mode:Set 2']);
        assert.deepEqual((await run('inputs.1.hdcp', false)).sent, ['Display:Input:HDCP:State:Set 0 0']);
        assert.deepEqual((await run('outputs.2.source', 1)).sent, ['Display:Matrix:Set 0 1']);
        assert.deepEqual((await run('commands.reboot', true)).sent, ['Platform:Restart']);
        assert.deepEqual((await run('commands.byodKick', true)).sent, ['Display:BYOD:Kick']);
    });

    it('sets the audio source of the active wired input only', async () => {
        assert.deepEqual((await run('control.audioSource', 'analog')).sent, ['Audio:SetSource 1 analog']);
        const driver = new ColonDriver(DEF, new TelnetLink(fakeTransport(), quietLog), quietLog, () => {});
        driver.activeInput = 5; // BYOD
        await assert.rejects(driver.command('control.audioSource', 'analog'), /wired input/);
    });

    it('explains a matrix route refused while matrix mode is off', async () => {
        await assert.rejects(run('outputs.1.source', 5), /Command Failure\. Is matrix mode on\?/);
    });

    it('accepts every captured no-op Set reply', async () => {
        assert.deepEqual((await run('control.source', 5)).updates, [['control.source', 5]]);
        assert.deepEqual((await run('control.volume', -20)).updates, [['control.volume', -20]]);
        assert.deepEqual((await run('control.muteHdmi', false)).updates, [['control.muteHdmi', false]]);
        assert.deepEqual((await run('control.display', true)).updates, [['control.display', true]]);
        assert.deepEqual((await run('control.matrixMode', 0)).updates, [['control.matrixMode', 0]]);
        assert.deepEqual((await run('inputs.1.hdcp', true)).updates, [['inputs.1.hdcp', true]]);
    });

    it('reports a Set the device refused', async () => {
        await assert.rejects(
            run('control.muteHdmi', true, {
                'Audio:Mute:Set hdmi true': '{"methodreturn":"Audio:Mute:Set hdmi true","error":{"success":false}}',
            }),
            DeviceError,
        );
    });

    it('acts on buttons only when true is written', async () => {
        assert.deepEqual((await run('commands.reboot', false)).sent, []);
        assert.deepEqual((await run('commands.byodKick', false)).sent, []);
        assert.deepEqual((await run('commands.byodKick', true)).sent, ['Display:BYOD:Kick']);
    });

    it('rejects blank, null and boolean numbers instead of treating them as 0', async () => {
        for (const val of [null, '', '  ', false, true, 'loud', undefined]) {
            await assert.rejects(run('control.volume', val), RangeError, `volume ${JSON.stringify(val)}`);
            await assert.rejects(run('control.matrixMode', val), RangeError, `matrixMode ${JSON.stringify(val)}`);
            await assert.rejects(run('control.source', val), RangeError, `source ${JSON.stringify(val)}`);
        }
        assert.deepEqual((await run('control.volume', '-30')).sent, ['Audio:Volume:Set -30']);
        assert.deepEqual((await run('control.matrixMode', 0)).sent, ['Display:Matrix:Mode:Set 0']);
    });

    it('accepts only real true/false values for switches', async () => {
        assert.deepEqual((await run('control.muteHdmi', 'false')).sent, ['Audio:Mute:Set hdmi false']);
        assert.deepEqual((await run('control.display', 1)).sent, ['Display:Minimal:Set 1']);
        for (const val of [null, '', 'yes', 2, undefined]) {
            await assert.rejects(run('control.muteHdmi', val), RangeError, `mute ${JSON.stringify(val)}`);
            await assert.rejects(run('inputs.1.hdcp', val), RangeError, `hdcp ${JSON.stringify(val)}`);
        }
    });

    it('refuses the wireless input HDCP state and unknown ids', async () => {
        await assert.rejects(run('inputs.5.hdcp', true), /not writable/);
        await assert.rejects(run('info.model', 'x'), /not writable/);
    });

    it('handles every writable state in the tree', async () => {
        const writable = buildObjects(DEF).filter(o => o.type === 'state' && o.common.write);
        for (const { _id, common } of writable) {
            const val = common.type === 'boolean' ? true : common.type === 'string' ? 'digital' : (common.min ?? 1);
            await run(_id, val); // throws for an unhandled id
        }
    });
});

describe('Colon dialect: pushed events', () => {
    it('maps the captured events to routes and input signals', () => {
        const full = Object.fromEntries(eventUpdates(DEF, JSON.parse(EVENTS.full).event));
        assert.deepEqual(full, {
            'outputs.1.source': 5,
            'outputs.2.source': 5,
            'inputs.1.signal': false,
            'inputs.2.signal': true,
            'inputs.3.signal': false,
            'inputs.4.signal': false,
            'inputs.5.signal': false,
        });
        assert.deepEqual(eventUpdates(DEF, JSON.parse(EVENTS.routes).event), [
            ['outputs.1.source', 5],
            ['outputs.2.source', 5],
        ]);
    });

    it('passes an event that arrives before a reply to onPush, and still finds the reply', async () => {
        const pushed = [];
        const transport = fakeTransport({
            'Display:Matrix:Mode:Set 0': `${EVENTS.full}\n#\n${SET_REPLIES['Display:Matrix:Mode:Set 0']}`,
        });
        const driver = new ColonDriver(DEF, new TelnetLink(transport, quietLog), quietLog, updates =>
            pushed.push(...updates),
        );
        assert.deepEqual(await driver.command('control.matrixMode', 0), [['control.matrixMode', 0]]);
        assert.ok(pushed.some(([id, val]) => id === 'inputs.2.signal' && val === true));
    });

    it('handles unsolicited event lines', () => {
        const pushed = [];
        const link = new TelnetLink(fakeTransport(), quietLog);
        new ColonDriver(DEF, link, quietLog, updates => pushed.push(...updates));
        link.handleLine(EVENTS.routes);
        link.handleLine('#');
        assert.deepEqual(pushed, [
            ['outputs.1.source', 5],
            ['outputs.2.source', 5],
        ]);
    });
});

describe('Colon dialect: over a real telnet session', function () {
    this.timeout(10000);
    let server;
    let telnet;

    afterEach(() => {
        telnet?.stop();
        server?.close();
    });

    it('polls a simulated SW-510W that uses LF line endings and "#" prompts', async () => {
        server = net.createServer(socket => {
            socket.on('error', () => {});
            socket.write(BANNER);
            let buffer = '';
            socket.on('data', chunk => {
                buffer += chunk.toString();
                let idx;
                while ((idx = buffer.indexOf('\r')) >= 0) {
                    const cmd = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    socket.write(`${REPLIES[cmd] ?? `Error: Unknown Command - '${cmd}'`}\n#\n`);
                }
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        telnet = new TelnetClient({
            host: '127.0.0.1',
            port: server.address().port,
            username: 'admin',
            password: 'Atlona',
            timers: { setTimeout, clearTimeout },
            log: quietLog,
            pacingMs: 10,
            loginQuietMs: 100,
        });
        telnet.start();
        await once(telnet, 'ready');
        const driver = new ColonDriver(DEF, new TelnetLink(telnet, quietLog), quietLog, () => {});
        const updates = Object.fromEntries([...(await driver.identify()), ...(await driver.poll())]);
        assert.equal(updates['info.model'], 'AT-UHD-SW-510W');
        assert.equal(updates['control.source'], 5);
        assert.equal(updates['control.display'], true);
        assert.equal(updates['inputs.2.signal'], true);
    });
});

// ---- Over the JSON-RPC WebSocket link

const WS = require('./fixtures/sw510w-ws');

/** A fake WsClient answering from the WebSocket captures; records every request. */
function fakeWsTransport(extra = {}) {
    const sent = [];
    const listeners = {};
    return {
        sent,
        on(name, fn) {
            listeners[name] = fn;
        },
        push(event) {
            listeners.event?.(event);
        },
        async request(method, params) {
            sent.push({ method, params });
            const key = `${method} ${JSON.stringify(params)}`;
            return Object.hasOwn(extra, key)
                ? { id: '1', jsonrpc: '2.0', ...extra[key] }
                : WS.reply({ method, params, id: 1 });
        },
    };
}

describe('Colon dialect over WebSocket', () => {
    const make = (transport = fakeWsTransport(), onPush = () => {}) =>
        new ColonDriver(DEF, new WsLink(transport), quietLog, onPush);

    it('maps the captured WebSocket replies to the same states as telnet', async () => {
        const updates = Object.fromEntries(await make().poll());
        assert.deepEqual(updates, {
            'control.source': 5,
            'control.volume': -20,
            'control.muteHdmi': false,
            'control.muteAnalog': false,
            'control.display': true,
            'control.matrixMode': 0,
            'outputs.1.source': 5,
            'outputs.2.source': 5,
            'inputs.1.signal': false,
            'inputs.2.signal': true,
            'inputs.3.signal': false,
            'inputs.4.signal': false,
            // inputs.5.signal (BYOD) comes only from pushed events over the WebSocket
            'inputs.1.hdcp': true,
            'inputs.2.hdcp': true,
            'inputs.3.hdcp': true,
            'inputs.4.hdcp': true,
            'info.temperature': 56,
        });
    });

    it('reads model and firmware from the flat WebSocket format', async () => {
        assert.deepEqual(Object.fromEntries(await make().identify()), {
            'info.model': 'AT-UHD-SW-510W',
            'info.firmware': '2.9.8 (MCU 1.1.41)',
        });
    });

    it('sends the parameter names found on hardware', async () => {
        const run = async (id, val) => {
            const transport = fakeWsTransport();
            await make(transport).command(id, val);
            return transport.sent;
        };
        assert.deepEqual(await run('control.source', 2), [{ method: 'Display:Input:Set', params: { input: 1 } }]);
        assert.deepEqual(await run('control.volume', -21), [{ method: 'Audio:Volume:Set', params: { volume: -21 } }]);
        assert.deepEqual(await run('control.muteHdmi', true), [{ method: 'Audio:Mute:Set', params: { hdmi: true } }]);
        assert.deepEqual(await run('control.muteAnalog', false), [
            { method: 'Audio:Mute:Set', params: { analog: false } },
        ]);
        assert.deepEqual(await run('control.display', false), [
            { method: 'Display:Minimal:Set', params: { state: 0 } },
        ]);
        assert.deepEqual(await run('control.matrixMode', 1), [
            { method: 'Display:Matrix:Mode:Set', params: { mode: 1 } },
        ]);
        assert.deepEqual(await run('outputs.1.source', 2), [
            { method: 'Display:Matrix:Set', params: { input: 1, output: 0 } },
        ]);
        assert.deepEqual(await run('inputs.1.hdcp', false), [
            { method: 'Display:Input:HDCP:State:Set', params: { input: 0, state: 0 } },
        ]);
        assert.deepEqual(await run('commands.byodKick', true), [{ method: 'Display:BYOD:Kick', params: {} }]);
    });

    it('refuses the audio source, whose WebSocket parameters are unknown, without sending', async () => {
        const transport = fakeWsTransport();
        const driver = make(transport);
        driver.activeInput = 2;
        await assert.rejects(driver.command('control.audioSource', 'analog'), /not available over the WebSocket/);
        assert.deepEqual(transport.sent, []);
    });

    it('treats a reply with neither result nor error as unsupported, and stops asking', async () => {
        const transport = fakeWsTransport({ 'Display:Input:All:Get {}': {} });
        const driver = make(transport);
        assert.equal(Object.fromEntries(await driver.poll())['inputs.1.signal'], undefined);
        await driver.poll();
        assert.equal(transport.sent.filter(r => r.method === 'Display:Input:All:Get').length, 1);
    });

    it('reports a Set the device refused', async () => {
        const transport = fakeWsTransport({
            'Display:Matrix:Set {"input":1,"output":0}': { error: 'Command Failure' },
        });
        await assert.rejects(make(transport).command('outputs.1.source', 2), /Command Failure\. Is matrix mode on\?/);
    });

    it('passes pushed events to onPush', () => {
        const pushed = [];
        const transport = fakeWsTransport();
        make(transport, updates => pushed.push(...updates));
        transport.push(WS.EVENT.event);
        assert.deepEqual(pushed.slice(0, 2), [
            ['outputs.1.source', 5],
            ['outputs.2.source', 5],
        ]);
    });
});
