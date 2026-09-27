'use strict';

/**
 * Builds the object tree for a model definition. Pure function. A parent object is created only
 * when a state below it exists, and it always precedes its children, so every dotted id has an
 * object for each parent segment.
 *
 * @param {object} def model definition from lib/models.js
 * @returns {Array<{_id: string, type: string, common: object, native: object}>} objects to create
 */
function buildObjects(def) {
    const parents = {
        info: { type: 'channel', name: 'Information' },
        control: { type: 'channel', name: 'Control' },
        inputs: { type: 'folder', name: 'Inputs' },
        outputs: { type: 'folder', name: 'Outputs' },
    };
    def.inputs.forEach((name, i) => (parents[`inputs.${i + 1}`] = { type: 'channel', name }));
    def.outputs.forEach((name, i) => (parents[`outputs.${i + 1}`] = { type: 'channel', name }));

    const objects = [];
    const created = new Set();
    const state = (_id, common) => {
        const segments = _id.split('.');
        for (let n = 1; n < segments.length; n++) {
            const parentId = segments.slice(0, n).join('.');
            if (!created.has(parentId)) {
                const { type, name } = parents[parentId];
                objects.push({ _id: parentId, type, common: { name }, native: {} });
                created.add(parentId);
            }
        }
        objects.push({ _id, type: 'state', common: { read: true, ...common }, native: {} });
    };

    const inputStates = Object.fromEntries(def.inputs.map((name, i) => [i + 1, name]));
    const source = name => ({
        name,
        type: 'number',
        role: 'media.input',
        write: true,
        min: 1,
        max: def.inputs.length,
        states: inputStates,
    });
    const volume = name => ({
        name,
        type: 'number',
        role: 'level.volume',
        write: true,
        min: def.volume.min,
        max: def.volume.max,
        unit: def.volume.unit,
    });
    const mute = name => ({ name, type: 'boolean', role: 'media.mute', write: true, def: false });

    state('info.model', { name: 'Device model', type: 'string', role: 'info.model', write: false, def: '' });
    state('info.firmware', { name: 'Firmware version', type: 'string', role: 'info.firmware', write: false, def: '' });
    if (def.temperature) {
        state('info.temperature', {
            name: 'Device temperature',
            type: 'number',
            role: 'value.temperature',
            write: false,
            unit: '°C',
        });
    }

    if (def.power) {
        state('control.power', { name: 'Power', type: 'boolean', role: 'switch.power', write: true, def: false });
    }
    if (def.routing === 'switcher') {
        state('control.source', source('Active input'));
    }
    if (def.volume?.scope === 'global') {
        state('control.volume', volume('Volume'));
    }
    if (def.mute === 'global') {
        state('control.mute', mute('Mute'));
    }

    def.inputs.forEach((name, i) => {
        if (def.inputSignal) {
            state(`inputs.${i + 1}.signal`, {
                name: `${name} signal`,
                type: 'boolean',
                role: 'indicator',
                write: false,
                def: false,
            });
        }
    });

    def.outputs.forEach((name, i) => {
        const id = `outputs.${i + 1}`;
        if (def.routing === 'matrix') {
            state(`${id}.source`, source(`${name} source`));
        }
        if (def.volume?.scope === 'output') {
            state(`${id}.volume`, volume(`${name} volume`));
        }
        if (def.mute === 'output') {
            state(`${id}.mute`, mute(`${name} mute`));
        }
    });

    return objects;
}

module.exports = { buildObjects };
