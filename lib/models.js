'use strict';

/**
 * Model definitions. Pure data: the state tree and the driver are both derived from these.
 *
 * - dialect: 'ascii' | 'colon' | 'jsonrpc' (selects the driver)
 * - verified: tested on real hardware (shown in the README)
 * - inputs / outputs: port names, in device order; state ids are numbered from 1
 * - routing: 'switcher' (one active input, `control.source`) or 'matrix' (`outputs.<n>.source`)
 * - volume: { scope: 'global' | 'output', min, max, unit } or null
 * - mute: 'global' | 'output' | null
 * - power, inputSignal, temperature: booleans
 */
const MODELS = {
    'sw-510w': {
        name: 'AT-UHD-SW-510W',
        dialect: 'colon',
        port: 23,
        verified: false,
        inputs: ['USB-C', 'DisplayPort', 'HDMI 1', 'HDMI 2', 'Wireless (BYOD)'],
        outputs: ['HDBaseT', 'HDMI'],
        routing: 'switcher',
        volume: { scope: 'global', min: -80, max: 0, unit: 'dB' },
        mute: null,
        power: false,
        inputSignal: true,
        temperature: true,
    },
};

/**
 * @param {string} key model key from the instance config
 * @returns {object | undefined} the model definition
 */
function getModel(key) {
    return Object.hasOwn(MODELS, key) ? MODELS[key] : undefined;
}

module.exports = { MODELS, getModel };
