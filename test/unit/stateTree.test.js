'use strict';

const assert = require('node:assert/strict');
const { MODELS } = require('../../lib/models');
const { buildObjects } = require('../../lib/stateTree');

// Role → [types, read, write]. Every role the tree may use, checked against ioBroker's stateroles.
const ROLES = {
    'info.model': [['string'], true, false],
    'info.firmware': [['string'], true, false],
    'value.temperature': [['number'], true, false],
    'switch.power': [['boolean'], true, true],
    'switch.enable': [['boolean'], true, true],
    'media.input': [['number', 'string'], true, true],
    'level.volume': [['number'], true, true],
    level: [['number'], true, true],
    'media.mute': [['boolean'], true, true],
    indicator: [['boolean'], true, false],
    button: [['boolean'], false, true],
};

// A synthetic matrix with every optional feature, so the audit covers all code paths.
const FULL_MATRIX = {
    name: 'Test matrix',
    dialect: 'ascii',
    port: 23,
    verified: false,
    inputs: ['In 1', 'In 2', 'In 3'],
    outputs: ['Out 1', 'Out 2'],
    routing: 'matrix',
    volume: { scope: 'output', min: -90, max: 10, unit: 'dB' },
    mute: 'output',
    power: true,
    inputSignal: true,
    temperature: true,
};

const DEFS = { ...MODELS, 'test-matrix': FULL_MATRIX };

for (const [key, def] of Object.entries(DEFS)) {
    describe(`State tree: ${key}`, () => {
        const objects = buildObjects(def);
        const byId = new Map(objects.map(obj => [obj._id, obj]));

        it('has unique, valid ids', () => {
            assert.equal(byId.size, objects.length);
            for (const { _id } of objects) {
                assert.match(_id, /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
            }
        });

        it('has an object for every parent segment, created before its children (E3009)', () => {
            const seen = new Set();
            for (const { _id } of objects) {
                const segments = _id.split('.');
                for (let n = 1; n < segments.length; n++) {
                    const parent = segments.slice(0, n).join('.');
                    assert.ok(seen.has(parent), `${_id}: parent ${parent} missing or created later`);
                    assert.notEqual(byId.get(parent).type, 'state', `${_id} sits below a state`);
                }
                seen.add(_id);
            }
        });

        it('has no device below a channel and no empty parents', () => {
            for (const obj of objects) {
                assert.notEqual(obj.type, 'device');
                if (obj.type !== 'state') {
                    assert.ok(
                        objects.some(o => o._id.startsWith(`${obj._id}.`)),
                        `${obj._id} has no children`,
                    );
                }
            }
        });

        it('uses valid roles matching type and read/write', () => {
            for (const { _id, type, common } of objects.filter(o => o.type === 'state')) {
                assert.ok(ROLES[common.role], `${_id}: unexpected role ${common.role}`);
                const [types, read, write] = ROLES[common.role];
                assert.ok(types.includes(common.type), `${_id} type ${common.type}`);
                assert.equal(common.read, read, `${_id} read`);
                assert.equal(common.write, write, `${_id} write`);
                assert.equal(typeof common.name, 'string', `${_id} name`);
                assert.equal(type, 'state');
            }
        });

        it('gives every string and boolean state a def', () => {
            for (const { _id, common } of objects.filter(o => o.type === 'state')) {
                if (common.type !== 'number') {
                    assert.notEqual(common.def, undefined, `${_id} has no def`);
                }
            }
        });

        it('numbers inputs from 1 and lists them as source states', () => {
            const source = objects.find(o => o.common.role === 'media.input' && o.common.type === 'number');
            assert.deepEqual(
                Object.keys(source.common.states).map(Number),
                def.inputs.map((_, i) => i + 1),
            );
            assert.equal(source.common.min, 1);
            assert.equal(source.common.max, def.inputs.length);
        });
    });
}

describe('State tree layout', () => {
    it('SW-510W: active input plus matrix routes, HDCP on wired inputs only', () => {
        const ids = buildObjects(MODELS['sw-510w']).map(o => o._id);
        for (const id of ['control.source', 'control.volume', 'control.display', 'control.matrixMode']) {
            assert.ok(ids.includes(id), id);
        }
        for (const id of ['outputs.1.source', 'outputs.2.source', 'inputs.5.signal', 'inputs.4.hdcp']) {
            assert.ok(ids.includes(id), id);
        }
        assert.ok(!ids.includes('inputs.5.hdcp'));
        assert.ok(ids.includes('commands.reboot'));
    });

    it('matrix: a source per output and no global source', () => {
        const ids = buildObjects(FULL_MATRIX).map(o => o._id);
        assert.ok(ids.includes('outputs.2.source'));
        assert.ok(ids.includes('outputs.2.volume'));
        assert.ok(ids.includes('outputs.2.mute'));
        assert.ok(!ids.includes('control.source'));
    });
});

describe('Model definitions', () => {
    for (const [key, def] of Object.entries(MODELS)) {
        it(`${key} is complete`, () => {
            assert.ok(['ascii', 'colon', 'jsonrpc'].includes(def.dialect));
            assert.ok(['switcher', 'matrix', 'both'].includes(def.routing));
            assert.equal(typeof def.name, 'string');
            assert.equal(typeof def.verified, 'boolean');
            assert.ok(Number.isInteger(def.port));
            assert.ok(def.inputs.length > 0);
        });
    }
});
