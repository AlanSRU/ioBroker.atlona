'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { WsClient } = require('../../lib/transport/ws');

/** A local WebSocket device; `handler(msg, socket)` answers each request. */
async function startDevice(handler) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/API' });
    await once(server, 'listening');
    const received = [];
    const sockets = [];
    server.on('connection', socket => {
        sockets.push(socket);
        socket.on('message', data => {
            const msg = JSON.parse(String(data));
            received.push({ msg, at: Date.now() });
            handler(msg, socket);
        });
    });
    return {
        port: server.address().port,
        received,
        sockets,
        close: () => {
            sockets.forEach(s => s.terminate());
            server.close();
        },
    };
}

function client(port, overrides = {}) {
    return new WsClient({
        host: '127.0.0.1',
        port,
        timers: { setTimeout, clearTimeout },
        log: { debug: () => {} },
        pacingMs: 50,
        requestTimeoutMs: 300,
        reconnectMinMs: 50,
        ...overrides,
    });
}

const answer = (socket, msg, result) => socket.send(JSON.stringify({ result, id: String(msg.id), jsonrpc: '2.0' }));

describe('WsClient', function () {
    this.timeout(5000);
    let device;
    let ws;

    afterEach(() => {
        ws?.stop();
        device?.close();
    });

    it('sends JSON-RPC 2.0 with a params object and matches the reply by id', async () => {
        device = await startDevice((msg, socket) => answer(socket, msg, { model: 'AT-UHD-SW-510W' }));
        ws = client(device.port);
        ws.start();
        await once(ws, 'ready');
        const reply = await ws.request('Misc:Model:Get');
        assert.deepEqual(reply.result, { model: 'AT-UHD-SW-510W' });
        const sent = device.received[0].msg;
        assert.equal(sent.jsonrpc, '2.0');
        assert.equal(sent.method, 'Misc:Model:Get');
        assert.deepEqual(sent.params, {});
    });

    it('ignores a late reply with an old id and waits for its own', async () => {
        let first = true;
        device = await startDevice((msg, socket) => {
            if (first) {
                first = false; // never answer the first request in time
                setTimeout(() => answer(socket, msg, { stale: true }), 400);
                return;
            }
            setTimeout(() => answer(socket, msg, { fresh: msg.method }), 200);
        });
        ws = client(device.port, { requestTimeoutMs: 300, maxTimeouts: 5 });
        ws.start();
        await once(ws, 'ready');
        await assert.rejects(ws.request('A'), { code: 'ETIMEDOUT' });
        const reply = await ws.request('B'); // the stale reply to A arrives while B is pending
        assert.deepEqual(reply.result, { fresh: 'B' });
    });

    it('emits pushed events, also while a request is pending', async () => {
        device = await startDevice((msg, socket) => {
            socket.send(JSON.stringify({ jsonrpc: '2.0', event: { output: [1, 1] } }));
            answer(socket, msg, { success: true });
        });
        ws = client(device.port);
        ws.start();
        await once(ws, 'ready');
        const events = [];
        ws.on('event', e => events.push(e));
        await ws.request('Display:Input:Set', { input: 1 });
        assert.deepEqual(events, [{ output: [1, 1] }]);
    });

    it('keeps at least pacingMs between requests', async () => {
        device = await startDevice((msg, socket) => answer(socket, msg, {}));
        ws = client(device.port, { pacingMs: 200 });
        ws.start();
        await once(ws, 'ready');
        await Promise.all([ws.request('A'), ws.request('B'), ws.request('C')]);
        const t = device.received.map(r => r.at);
        assert.ok(t[1] - t[0] >= 190 && t[2] - t[1] >= 190, `gaps ${t[1] - t[0]}, ${t[2] - t[1]}`);
    });

    it('drops and re-opens the session after consecutive unanswered requests', async () => {
        device = await startDevice(() => {});
        ws = client(device.port, { requestTimeoutMs: 150 });
        ws.start();
        await once(ws, 'ready');
        const a = ws.request('A').catch(e => e);
        const b = ws.request('B').catch(e => e);
        const [reason, wasReady] = await once(ws, 'disconnected');
        assert.match(reason, /No reply to 2 requests/);
        assert.equal(wasReady, true);
        assert.equal((await a).code, 'ETIMEDOUT');
        assert.equal((await b).code, 'ETIMEDOUT');
        await once(ws, 'ready');
        assert.equal(device.sockets.length, 2);
    });

    it('reports a device that closes the connection, and reconnects', async () => {
        device = await startDevice(() => {});
        ws = client(device.port);
        ws.start();
        await once(ws, 'ready');
        device.sockets[0].close();
        const [reason, wasReady] = await once(ws, 'disconnected');
        assert.match(reason, /closed by device/);
        assert.equal(wasReady, true);
        await once(ws, 'ready');
    });

    it('backs off between failed connection attempts', async () => {
        const probe = await startDevice(() => {});
        const port = probe.port;
        probe.close();
        await new Promise(r => setTimeout(r, 50));
        ws = client(port, { reconnectMinMs: 100, reconnectMaxMs: 400 });
        const at = [];
        ws.on('disconnected', (_, wasReady) => {
            assert.equal(wasReady, false);
            at.push(Date.now());
        });
        ws.start();
        while (at.length < 4) {
            await once(ws, 'disconnected');
        }
        const gaps = at.slice(1).map((t, i) => t - at[i]);
        assert.ok(gaps[0] >= 90 && gaps[1] >= 190 && gaps[2] >= 390, `gaps ${gaps.join(', ')}`);
    });

    it('rejects requests when not connected and after stop()', async () => {
        device = await startDevice(() => {});
        ws = client(device.port);
        await assert.rejects(ws.request('A'), /Not connected/);
        ws.start();
        await once(ws, 'ready');
        const pending = ws.request('A');
        ws.stop();
        await assert.rejects(pending, /Connection closed/);
        await new Promise(r => setTimeout(r, 200));
        assert.equal(device.sockets.length, 1, 'no reconnect after stop()');
    });
});
