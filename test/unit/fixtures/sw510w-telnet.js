'use strict';

// Telnet replies captured from an AT-UHD-SW-510W, firmware 2.9.8 (MCU 1.1.41), on 2026-09-27.
// Each reply is followed on the wire by "\n#\n". HDCP inputs 1-3 were not captured over telnet and
// reuse the input 0 format.

const BANNER =
    '\n***************************************************\n' +
    '*                                                 *\n' +
    '* Welcome to the Atlona Telnet Interface          *\n' +
    '*                                                 *\n' +
    '* Type "quit" to end the session                  *\n' +
    '*      "?" for a list of commands                 *\n' +
    '*                                                 *\n' +
    '***************************************************\n\n';

const REPLIES = {
    Type: "Error: Unknown Command - 'Type'",
    'Misc:Model:Get': '{"result":{"model":"AT-UHD-SW-510W"},"methodreturn":"Misc:Model:Get"}',
    'Misc:Versions:Get': '{"result":{"versions":{"mcu":"1.1.41","master":"2.9.8"}},"methodreturn":"Misc:Versions:Get"}',
    'Instruments:Temperature:Get':
        '{"result":{"scale":"Celcius","value":57},"methodreturn":"Instruments:Temperature:Get"}',
    'Display:Input:Get': '{"result":{"input":4,"type":"unknown"},"methodreturn":"Display:Input:Get","jsonrpc":"2.0"}',
    'Display:Input:All:Get':
        '{"result":{"0":{"status":false},"1":{"status":true},"2":{"status":false},"3":{"status":false},' +
        '"4":{"type":"unknown","status":false}},"methodreturn":"Display:Input:All:Get","jsonrpc":"2.0"}',
    'Audio:Volume:Get': '{"result":{"volume":{"units":"dB","value":-20}},"methodreturn":"Audio:Volume:Get"}',
    'Audio:Mute:Get': '{"result":{"outputmute":{"analog":false,"hdmi":false}},"methodreturn":"Audio:Mute:Get"}',
    'Display:Minimal:Get': 'on ',
    'Display:Matrix:Mode:Get': '{"result":{"mode":false},"methodreturn":"Display:Matrix:Mode:Get","jsonrpc":"2.0"}',
    'Display:Matrix:Get 0': '{"result":{"input":4},"methodreturn":"Display:Matrix:Get 0","jsonrpc":"2.0"}',
    'Display:Matrix:Get 1': '{"result":{"input":4},"methodreturn":"Display:Matrix:Get 1","jsonrpc":"2.0"}',
    'Display:Input:HDCP:State:Get 0': '{"result":{"state":true},"methodreturn":"Display:Input:HDCP:State:Get 0"}',
    'Display:Input:HDCP:State:Get 1': '{"result":{"state":true},"methodreturn":"Display:Input:HDCP:State:Get 1"}',
    'Display:Input:HDCP:State:Get 2': '{"result":{"state":true},"methodreturn":"Display:Input:HDCP:State:Get 2"}',
    'Display:Input:HDCP:State:Get 3': '{"result":{"state":true},"methodreturn":"Display:Input:HDCP:State:Get 3"}',
    'Display:Input:HDCP:State:Get 4': '{"methodreturn":"Display:Input:HDCP:State:Get 4","error":{"success":false}}',
    'Audio:GetSource': '{"result":{"audiosource":"digital"},"methodreturn":"Audio:GetSource"}',
    'Audio:GetSource 0': '{"methodreturn":"Audio:GetSource 0","error":{"success":false}}',
    'Display:InputState:Get 1':
        '{"result":{"input":1,"state":true},"methodreturn":"Display:InputState:Get 1","jsonrpc":"2.0"}',
};

// Replies to no-op Sets (each re-sent the value the device already had), captured 2026-09-27.
const SET_REPLIES = {
    'Display:Input:Set 4': '{"result":{"activeinput":4},"methodreturn":"Display:Input:Set 4","jsonrpc":"2.0"}',
    'Audio:Volume:Set -20': '{"result":{"success":true},"methodreturn":"Audio:Volume:Set -20"}',
    'Audio:Mute:Set hdmi false': '{"result":{"success":true},"methodreturn":"Audio:Mute:Set hdmi false"}',
    'Display:Minimal:Set 1': '{"result":{"success":true},"methodreturn":"Display:Minimal:Set 1"}',
    'Display:Matrix:Mode:Set 0': '{"result":{"success":true},"methodreturn":"Display:Matrix:Mode:Set 0"}',
    'Display:Input:HDCP:State:Set 0 1': '{"result":{"success":true},"methodreturn":"Display:Input:HDCP:State:Set 0 1"}',
    // matrix mode was off
    'Display:Matrix:Set 4 0': '{"methodreturn":"Display:Matrix:Set 4 0","jsonrpc":"2.0","error":"Command Failure"}',
};

// Events pushed after Sets; each is followed by a "#" prompt, and one arrived before the reply.
const EVENTS = {
    full:
        '{"jsonrpc":"2.0","event":{"output":{"0":{"input":4,"state":true},"1":{"input":4,"state":false}},' +
        '"input":{"0":{"status":false},"1":{"status":true},"2":{"status":false},"3":{"status":false},' +
        '"4":{"type":"unknown","status":false}}}}',
    routes: '{"jsonrpc":"2.0","event":{"output":[4,4]}}',
};

module.exports = { BANNER, REPLIES, SET_REPLIES, EVENTS };
