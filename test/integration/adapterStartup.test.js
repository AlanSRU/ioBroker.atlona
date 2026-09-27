'use strict';

const path = require('path');
const net = require('node:net');
const { once } = require('node:events');
const { tests } = require('@iobroker/testing');

const call = (client, method, ...args) =>
    new Promise((resolve, reject) =>
        client[method](...args, (err, result) => (err ? reject(err) : resolve(result))),
    );

tests.integration(path.join(__dirname, '../..'), {
    defineAdditionalTests({ suite }) {
        suite('Connection to a device', getHarness => {
            let server;
            let received;

            before(async () => {
                received = '';
                // A device that asks for a login (Omega style) and then stays silent
                server = net.createServer(socket => {
                    socket.on('error', () => {});
                    socket.write('Username: ');
                    socket.on('data', chunk => {
                        received += chunk.toString();
                        if (received === 'admin\r') {
                            socket.write('\r\nPassword: ');
                        } else if (received === 'admin\rAtlona\r') {
                            socket.write('\r\nWelcome to TELNET.\r\n');
                        }
                    });
                });
                server.listen(0, '127.0.0.1');
                await once(server, 'listening');
            });

            after(() => server.close());

            it('logs in, sets info.connection and creates the model state tree', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig('atlona', {
                    native: { host: '127.0.0.1', port: server.address().port, model: 'sw-510w' },
                });
                await harness.startAdapterAndWait();

                let connected = null;
                for (let i = 0; i < 40 && !connected?.val; i++) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    connected = await call(harness.states, 'getState', 'atlona.0.info.connection');
                }
                if (!connected?.val) {
                    throw new Error('info.connection never became true');
                }
                if (received !== 'admin\rAtlona\r') {
                    throw new Error(`Unexpected login traffic: ${JSON.stringify(received)}`);
                }

                const model = await call(harness.states, 'getState', 'atlona.0.info.model');
                if (model?.val !== 'AT-UHD-SW-510W') {
                    throw new Error(`info.model is ${model?.val}`);
                }
                for (const id of ['control', 'control.source', 'control.volume', 'inputs', 'inputs.1.signal']) {
                    if (!(await call(harness.objects, 'getObject', `atlona.0.${id}`))) {
                        throw new Error(`Object ${id} missing`);
                    }
                }
            });
        });
    },
});
