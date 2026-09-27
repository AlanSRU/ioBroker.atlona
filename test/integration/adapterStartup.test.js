'use strict';

const path = require('path');
const net = require('node:net');
const { once } = require('node:events');
const { tests } = require('@iobroker/testing');
const { BANNER, REPLIES } = require('../unit/fixtures/sw510w-telnet');

const call = (client, method, ...args) =>
    new Promise((resolve, reject) => client[method](...args, (err, result) => (err ? reject(err) : resolve(result))));

tests.integration(path.join(__dirname, '../..'), {
    defineAdditionalTests({ suite }) {
        suite('Connection to a simulated SW-510W', getHarness => {
            let server;
            let received;

            before(async () => {
                received = [];
                // Answers from the replies captured on a real SW-510W (LF endings, "#" prompt after each reply)
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
                            received.push(cmd);
                            socket.write(`${REPLIES[cmd] ?? `Error: Unknown Command - '${cmd}'`}\n#\n`);
                        }
                    });
                });
                server.listen(0, '127.0.0.1');
                await once(server, 'listening');
            });

            after(() => server.close());

            it('connects, polls the device and fills the state tree', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig('atlona', {
                    native: { host: '127.0.0.1', port: server.address().port, model: 'sw-510w' },
                });
                await harness.startAdapterAndWait();

                const read = id => call(harness.states, 'getState', `atlona.0.${id}`);
                let temperature = null;
                for (let i = 0; i < 80 && temperature?.val !== 57; i++) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    temperature = await read('info.temperature'); // the last query of a poll
                }
                const expected = {
                    'info.connection': true,
                    'info.model': 'AT-UHD-SW-510W',
                    'info.firmware': '2.9.8 (MCU 1.1.41)',
                    'info.temperature': 57,
                    'control.source': 5,
                    'control.volume': -20,
                    'control.display': true,
                    'inputs.2.signal': true,
                    'outputs.1.source': 5,
                };
                for (const [id, val] of Object.entries(expected)) {
                    const state = await read(id);
                    if (state?.val !== val || state.ack !== true) {
                        throw new Error(`${id} is ${JSON.stringify(state?.val)} (ack ${state?.ack}), expected ${val}`);
                    }
                }
                const sets = received.filter(cmd => /:Set|SetSource|Restart|Kick/i.test(cmd));
                if (sets.length) {
                    throw new Error(`The adapter sent commands at startup: ${sets.join(', ')}`);
                }
            });
        });
    },
});
