'use strict';

/**
 * Model definitions. Pure data: the state tree and the driver are both derived from these.
 *
 * - dialect: 'ascii' | 'colon' | 'jsonrpc' (selects the driver)
 * - port: telnet port; wsPort: WebSocket port, for models that also offer a JSON-RPC WebSocket
 * - verified: tested on real hardware (shown in the README)
 * - inputs / outputs: port names, in device order; state ids are numbered from 1
 * - routing: 'switcher' (one active input, `control.source`), 'matrix' (`outputs.<n>.source`)
 *   or 'both' (a switcher with an optional matrix mode)
 * - volume: { scope: 'global' | 'output', min, max, unit } or null
 * - mute: 'global' | 'output' | null
 * - power, inputSignal, temperature: booleans
 * - hdcpInputs: input numbers with a switchable HDCP setting (`inputs.<n>.hdcp`)
 * - extraStates: model-specific states under `control` or `commands`, as { id: common }
 */
const MODELS = {
    'sw-510w': {
        name: 'AT-UHD-SW-510W',
        dialect: 'colon',
        port: 23,
        wsPort: 80, // JSON-RPC WebSocket at ws://<ip>/API
        verified: false,
        inputs: ['USB-C', 'DisplayPort', 'HDMI 1', 'HDMI 2', 'Wireless (BYOD)'],
        outputs: ['HDBaseT', 'HDMI'],
        routing: 'both',
        volume: { scope: 'global', min: -80, max: 0, unit: 'dB' },
        mute: null,
        power: false,
        inputSignal: true,
        temperature: true,
        hdcpInputs: [1, 2, 3, 4],
        extraStates: {
            'control.display': {
                name: 'Display output on (off mutes audio and video)',
                type: 'boolean',
                role: 'switch.enable',
                write: true,
                def: false,
            },
            'control.muteHdmi': {
                name: 'Mute HDMI audio',
                type: 'boolean',
                role: 'media.mute',
                write: true,
                def: false,
            },
            'control.muteAnalog': {
                name: 'Mute analog audio',
                type: 'boolean',
                role: 'media.mute',
                write: true,
                def: false,
            },
            'control.audioSource': {
                name: 'Set the audio source of the active input (not read back from the device)',
                type: 'string',
                role: 'media.input',
                write: true,
                def: '',
                states: { digital: 'From the video input', analog: 'Analog audio in' },
            },
            'control.matrixMode': {
                name: 'Matrix mode',
                type: 'number',
                role: 'level',
                write: true,
                min: 0,
                max: 2,
                states: { 0: 'Off', 1: 'Matrix', 2: 'Matrix with static route' },
            },
            'commands.reboot': {
                name: 'Reboot the device',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            'commands.byodKick': {
                name: 'Disconnect all wireless (BYOD) clients',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
        },
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
