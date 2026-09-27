'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { TelnetClient, TelnetDecoder, LineFramer } = require('../../lib/transport/telnet');

const IAC = 255;
const DO = 253;
const WILL = 251;
const WONT = 252;
const DONT = 254;
const SB = 250;
const SE = 240;

describe('TelnetDecoder', () => {
    it('passes plain bytes through', () => {
        const { data, replies } = new TelnetDecoder().decode(Buffer.from('Status\r\n'));
        assert.equal(data.toString(), 'Status\r\n');
        assert.equal(replies.length, 0);
    });

    it('refuses DO with WONT and WILL with DONT', () => {
        const { data, replies } = new TelnetDecoder().decode(Buffer.from([IAC, DO, 1, IAC, WILL, 3, 65]));
        assert.equal(data.toString(), 'A');
        assert.deepEqual([...replies], [IAC, WONT, 1, IAC, DONT, 3]);
    });

    it('keeps state when a sequence is split across chunks', () => {
        const decoder = new TelnetDecoder();
        const a = decoder.decode(Buffer.from([65, IAC]));
        const b = decoder.decode(Buffer.from([DO]));
        const c = decoder.decode(Buffer.from([24, 66]));
        assert.equal(Buffer.concat([a.data, b.data, c.data]).toString(), 'AB');
        assert.deepEqual([...c.replies], [IAC, WONT, 24]);
    });

    it('unescapes IAC IAC and skips subnegotiation', () => {
        const input = [IAC, IAC, IAC, SB, 24, 1, IAC, SE, 67];
        const { data } = new TelnetDecoder().decode(Buffer.from(input));
        assert.deepEqual([...data], [255, 67]);
    });
});

describe('LineFramer', () => {
    it('splits on CR LF, CR and LF and drops empty lines', () => {
        assert.deepEqual(new LineFramer().push('a\r\nb\rc\n\r\n'), ['a', 'b', 'c']);
    });

    it('does not produce an empty line when CR LF is split across chunks', () => {
        const framer = new LineFramer();
        assert.deepEqual(framer.push('x1AVx2\r'), ['x1AVx2']);
        assert.deepEqual(framer.push('\nx3AVx1\r\n'), ['x3AVx1']);
    });

    it('keeps an unterminated prompt in partial', () => {
        const framer = new LineFramer();
        assert.deepEqual(framer.push('Password: '), []);
        assert.equal(framer.partial, 'Password: ');
    });
});

/**
 * A scripted device. `script(socket, lines)` runs per connection; `lines` yields each CR-terminated
 * line the client sends.
 */
async function startDevice(script) {
    const connections = [];
    const server = net.createServer(socket => {
        const received = [];
        let buffer = '';
        let waiter = null;
        socket.on('data', chunk => {
            buffer += chunk.toString('latin1');
            let idx;
            while ((idx = buffer.indexOf('\r')) >= 0) {
                received.push({ line: buffer.slice(0, idx), at: Date.now() });
                buffer = buffer.slice(idx + 1);
            }
            waiter?.();
        });
        socket.on('error', () => {});
        const nextLine = async () => {
            while (connection.read >= received.length) {
                await new Promise(resolve => (waiter = resolve));
            }
            return received[connection.read++].line;
        };
        const connection = { socket, received, read: 0, nextLine, raw: [] };
        socket.on('data', chunk => connection.raw.push(...chunk));
        connections.push(connection);
        void script(socket, nextLine, connection);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        port: server.address().port,
        connections,
        close: () => {
            connections.forEach(c => c.socket.destroy());
            server.close();
        },
    };
}

function client(port, overrides = {}) {
    return new TelnetClient({
        host: '127.0.0.1',
        port,
        username: 'admin',
        password: 'Atlona',
        timers: { setTimeout, clearTimeout },
        log: { debug: () => {} },
        pacingMs: 100,
        loginQuietMs: 100,
        requestTimeoutMs: 300,
        reconnectMinMs: 50,
        ...overrides,
    });
}

describe('TelnetClient', function () {
    this.timeout(5000);
    let device;
    let telnet;

    afterEach(() => {
        telnet?.stop();
        device?.close();
    });

    it('becomes ready without a login prompt and matches a reply to its command', async () => {
        device = await startDevice(async (socket, nextLine) => {
            assert.equal(await nextLine(), 'Type');
            socket.write('AT-GAIN-120\r\n');
        });
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        assert.deepEqual(await telnet.request('Type'), ['AT-GAIN-120']);
    });

    it('answers option negotiation with refusals', async () => {
        device = await startDevice(async socket => {
            socket.write(Buffer.from([IAC, DO, 1, IAC, WILL, 3]));
        });
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        assert.deepEqual(device.connections[0].raw.slice(0, 6), [IAC, WONT, 1, IAC, DONT, 3]);
    });

    it('logs in on Username:/Password: prompts (Omega style)', async () => {
        device = await startDevice(async (socket, nextLine) => {
            socket.write('Username: ');
            assert.equal(await nextLine(), 'admin');
            socket.write('\r\nPassword: ');
            assert.equal(await nextLine(), 'Atlona');
            socket.write('\r\nWelcome to TELNET.\r\n');
        });
        telnet = client(device.port, { loginQuietMs: 2000 });
        telnet.start();
        const started = Date.now();
        await once(telnet, 'ready');
        assert.ok(Date.now() - started < 1500, 'ready on the welcome line, not on the quiet timer');
    });

    it('logs in on Login:/Password prompts (PRO3 style)', async () => {
        device = await startDevice(async (socket, nextLine) => {
            socket.write('\r\nLogin: ');
            assert.equal(await nextLine(), 'admin');
            socket.write('\r\nPassword\r\n');
            assert.equal(await nextLine(), 'Atlona');
            socket.write('\r\n');
        });
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        assert.deepEqual(
            device.connections[0].received.map(r => r.line),
            ['admin', 'Atlona'],
        );
    });

    it('reports a rejected login when the prompt repeats', async () => {
        device = await startDevice(async (socket, nextLine) => {
            socket.write('Username: ');
            await nextLine();
            socket.write('Password: ');
            await nextLine();
            socket.write('\r\nUsername: ');
        });
        telnet = client(device.port);
        telnet.start();
        const [reason, wasReady] = await once(telnet, 'disconnected');
        assert.match(reason, /Login rejected/);
        assert.equal(wasReady, false);
    });

    it('reports Full Connections', async () => {
        device = await startDevice(async socket => {
            socket.write('Full Connections\r\n');
        });
        telnet = client(device.port);
        telnet.start();
        const [reason] = await once(telnet, 'disconnected');
        assert.match(reason, /Full Connections/);
    });

    it('never sends a password to a device that did not ask for one', async () => {
        device = await startDevice(async () => {});
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        assert.equal(device.connections[0].received.length, 0);
    });

    it('keeps at least pacingMs between commands', async () => {
        device = await startDevice(async (socket, nextLine) => {
            for (;;) {
                const line = await nextLine();
                socket.write(`${line} ok\r\n`);
            }
        });
        telnet = client(device.port, { pacingMs: 200 });
        telnet.start();
        await once(telnet, 'ready');
        const replies = await Promise.all([telnet.request('A'), telnet.request('B'), telnet.request('C')]);
        assert.deepEqual(replies, [['A ok'], ['B ok'], ['C ok']]);
        const times = device.connections[0].received.map(r => r.at);
        assert.ok(times[1] - times[0] >= 190, `gap ${times[1] - times[0]} ms`);
        assert.ok(times[2] - times[1] >= 190, `gap ${times[2] - times[1]} ms`);
    });

    it('passes lines the command does not accept on as unsolicited', async () => {
        device = await startDevice(async (socket, nextLine) => {
            await nextLine();
            socket.write('x2AVx1\r\nVOUT1 -20\r\n');
        });
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        const unsolicited = [];
        telnet.on('line', line => unsolicited.push(line));
        const reply = await telnet.request('VOUT1 sta', { accept: line => line.startsWith('VOUT1') && 'done' });
        assert.deepEqual(reply, ['VOUT1 -20']);
        assert.deepEqual(unsolicited, ['x2AVx1']);
    });

    it('collects a multi-line reply', async () => {
        device = await startDevice(async (socket, nextLine) => {
            await nextLine();
            socket.write('{\r\n  "result": {"input": 2}\r\n}\r\n');
        });
        telnet = client(device.port);
        telnet.start();
        await once(telnet, 'ready');
        let depth = 0;
        const accept = line => {
            depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
            return depth === 0 ? 'done' : 'more';
        };
        const reply = await telnet.request('Display:Input:Get', { accept });
        assert.equal(JSON.parse(reply.join('')).result.input, 2);
    });

    it('drops and re-opens the session after consecutive unanswered commands', async () => {
        device = await startDevice(async () => {});
        telnet = client(device.port, { maxTimeouts: 2, requestTimeoutMs: 150 });
        telnet.start();
        await once(telnet, 'ready');
        const first = telnet.request('A');
        const second = telnet.request('B').catch(err => err);
        await assert.rejects(first, { code: 'ETIMEDOUT' });
        const [reason, wasReady] = await once(telnet, 'disconnected');
        assert.match(reason, /No reply to 2 commands/);
        assert.equal(wasReady, true);
        assert.equal((await second).code, 'ETIMEDOUT');
        await once(telnet, 'ready');
        assert.equal(device.connections.length, 2);
    });

    it('rejects commands when not connected and after stop()', async () => {
        device = await startDevice(async () => {});
        telnet = client(device.port);
        await assert.rejects(telnet.request('Type'), /Not connected/);
        telnet.start();
        await once(telnet, 'ready');
        const pending = telnet.request('Type');
        telnet.stop();
        await assert.rejects(pending, /Connection closed/);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(device.connections.length, 1, 'no reconnect after stop()');
    });

    it('backs off between failed connection attempts', async () => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = server.address().port;
        server.close(); // nothing listens on this port now
        telnet = client(port, { reconnectMinMs: 100, reconnectMaxMs: 400 });
        const at = [];
        telnet.on('disconnected', () => at.push(Date.now()));
        telnet.start();
        while (at.length < 4) {
            await once(telnet, 'disconnected');
        }
        const gaps = at.slice(1).map((t, i) => t - at[i]);
        assert.ok(gaps[0] >= 90 && gaps[1] >= 190 && gaps[2] >= 390, `gaps ${gaps.join(', ')}`);
    });
});
