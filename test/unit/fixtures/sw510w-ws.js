'use strict';

// JSON-RPC WebSocket (ws://<ip>/API) results captured from an AT-UHD-SW-510W, fw 2.9.8, on 2026-09-27.
// Keyed by "<method> <params JSON>". Each value is the `result` member; `null` means the device answered
// with neither result nor error (method not supported), and a string is the `error` member.

const RESULTS = {
    'Misc:Model:Get {}': { model: 'AT-UHD-SW-510W' },
    'Misc:Versions:Get {}': { mcu: '1.1.41', master: '2.9.8' },
    'Instruments:Temperature:Get {}': { temperature: { scale: 'celcius', value: 56 } },
    'Display:Input:Get {}': { input: 4, type: 'unknown' },
    'Display:Input:All:Get {}': {
        0: { status: false },
        1: { status: true },
        2: { status: false },
        3: { status: false },
        4: { type: 'unknown', status: true },
    },
    'Audio:Volume:Get {}': { volume: -20 },
    'Audio:Mute:Get {}': { muteanalog: false, mutehdmi: false },
    'Display:Minimal:Get {}': { state: true },
    'Display:Matrix:Mode:Get {}': { mode: false, subtype: 'NONE' },
    'Display:Matrix:Get {"output":0}': { input: 4 },
    'Display:Matrix:Get {"output":1}': { input: 4 },
    'Display:Input:HDCP:State:Get {"input":0}': { state: true },
    'Display:Input:HDCP:State:Get {"input":1}': { state: true },
    'Display:Input:HDCP:State:Get {"input":2}': { state: true },
    'Display:Input:HDCP:State:Get {"input":3}': { state: true },
    'Audio:GetSource {}': null,
    'GetHostName {}': null,
    'Display:Matrix:Get {}': 'Invalid parameter: output',
    'Display:Input:HDCP:State:Get {"input":4}': 'Invalid parameter: input',
};

// Pushed to a WebSocket client after a telnet Display:Input:Set (same format as on telnet)
const EVENT = {
    jsonrpc: '2.0',
    event: {
        output: { 0: { input: 4, state: true }, 1: { input: 4, state: false } },
        input: {
            0: { status: false },
            1: { status: true },
            2: { status: false },
            3: { status: false },
            4: { type: 'unknown', status: false },
        },
    },
};

/**
 * Builds the reply message the device sends for a request, from the capture table.
 *
 * @param {{method: string, params: object, id: number}} req JSON-RPC request
 * @returns {object} reply message
 */
function reply(req) {
    const key = `${req.method} ${JSON.stringify(req.params)}`;
    const id = String(req.id);
    if (Object.hasOwn(RESULTS, key)) {
        const r = RESULTS[key];
        if (r === null) {
            return { id, jsonrpc: '2.0' };
        }
        return typeof r === 'string' ? { id, jsonrpc: '2.0', error: r } : { result: r, id, jsonrpc: '2.0' };
    }
    if (/:Set$|Kick$|Restart$/.test(req.method)) {
        return { result: { success: true }, id, jsonrpc: '2.0' };
    }
    return { id, jsonrpc: '2.0' }; // unknown method
}

module.exports = { RESULTS, EVENT, reply };
