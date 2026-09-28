<img src="admin/atlona.png" width="100" alt="Atlona logo" align="right">

# ioBroker.atlona

[![NPM version](https://img.shields.io/npm/v/iobroker.atlona.svg)](https://www.npmjs.com/package/iobroker.atlona)
[![Downloads](https://img.shields.io/npm/dm/iobroker.atlona.svg)](https://www.npmjs.com/package/iobroker.atlona)
![Test and Release](https://github.com/AlanSRU/ioBroker.atlona/workflows/Test%20and%20Release/badge.svg)

## Atlona adapter for ioBroker

Controls [Atlona](https://atlona.com/) AV switchers, matrix switchers, scalers and amplifiers over the
network: input selection and routing, volume and mute, display output, HDCP, and device status. The Atlona
range is now part of [Hall Technologies](https://hallresearch.com/).

Atlona products use three control protocols. This adapter is designed to cover all three with one state
tree, so scripts and visualisations work the same way across models:

| Protocol | Connection | Models |
|---|---|---|
| Colon/JSON | JSON-RPC WebSocket (`ws://<ip>/API`) or telnet | AT-UHD-SW-510W (supported), AT-OME-MS52W (planned) |
| ASCII | Telnet | Omega, UHD-PRO3, HDR-H2H, Opus, Juno, UHD-SW, HDR-SW, CLSO, HDVS, CAT, GAIN (planned) |
| JSON-RPC 2.0 | WebSocket | AT-PRO5-MX810, AT-OME-CS31-SA, AT-USB-EX350 (planned) |

## Status

**Version 0.1.0.** The AT-UHD-SW-510W is fully supported. The other models follow in stages.

| Model | Status | Tested on hardware |
|---|---|---|
| AT-UHD-SW-510W | Supported | Yes. Firmware 2.9.8, over both the WebSocket and telnet: status, volume, both mutes, display output, HDCP, input switching, matrix mode and routing were each changed and restored on a real unit. Audio source and reboot are not verified |
| AT-OME-MS52W | Planned | No |
| Omega (PS62, MS42, SW32), UHD-SW / HDR-SW, GAIN-60/120 | Planned next | No |
| UHD-PRO3, HDR-H2H, Opus, Juno, CLSO, HDVS, CAT, HDR-M2C, DISP-CTRL | Planned | No |
| AT-PRO5-MX810, AT-OME-CS31-SA | Planned | No |

Models not tested on hardware are built from Atlona's published API documents and are marked as such.
Owners who can test a model are very welcome to report in the
[issue tracker](https://github.com/AlanSRU/ioBroker.atlona/issues). AV-over-IP (OmniStream), cameras and
Velocity panels are not in scope.

## Requirements

- Node.js 22 or newer
- js-controller 6.0.11 or newer, admin 7.6.20 or newer
- Network control enabled on the device (the default). If the device restricts access by IP address, the
  ioBroker host must be allowed

## Configuration

| Option | Default | Description |
|---|---|---|
| Device address | | IP address or host name of the device |
| Device model | AT-UHD-SW-510W | The connected model |
| Connection | Automatic | Automatic uses the WebSocket where the model has one (AT-UHD-SW-510W), otherwise telnet. Telnet or WebSocket can also be chosen explicitly |
| Telnet port | `23` | TCP port of the telnet control interface |
| WebSocket port | `80` | HTTP port of the JSON-RPC WebSocket (`ws://<ip>:<port>/API`) |
| Username | `admin` | Sent only if the device asks for a telnet login |
| Password | (Atlona default) | Sent only if the device asks for a telnet login. Stored encrypted |
| Polling interval | `30000` | How often the full status is read, in ms (15000 to 3600000) |

Add one instance per device.

How the adapter talks to the device:

- It keeps one connection open, sends at most one command every 500 ms, and matches every reply to the
  command that caused it.
- At startup it only reads the device. It never changes an input, the volume or the power by itself.
- If the connection drops, or the device stops answering, `info.connection` turns false and the adapter
  reconnects in the background (5 s, doubling up to 60 s).
- Atlona devices allow only a few telnet sessions at a time (the AT-UHD-SW-510W only one). The
  AT-UHD-SW-510W's WebSocket accepts several clients, answers faster and reports routing changes
  immediately, so it is used by default.

## States

Every model creates only the states it supports. Inputs and outputs are numbered from 1, matching the
labels on the device.

| State | Description |
|---|---|
| `info.connection` | The connection to the device is open and answering |
| `info.model`, `info.firmware` | Model and firmware version reported by the device |
| `info.temperature` | Internal temperature in °C (models that report it) |
| `control.source` | Active input (switchers) |
| `control.volume`, `control.mute` | Volume and mute (models with one audio output) |
| `control.power` | Power (models with power control) |
| `inputs.<n>.signal` | A signal is present on input `<n>` |
| `outputs.<n>.source` | Input routed to output `<n>` (matrix switchers) |
| `outputs.<n>.volume`, `outputs.<n>.mute` | Per-output volume and mute |

Writes are checked before anything is sent: a value out of range, a blank value or a wrong type is refused
with a warning in the log; polled states show the device's real value again at the next poll. Buttons act
only when `true` is written.

### AT-UHD-SW-510W

Inputs: 1 USB-C, 2 DisplayPort, 3 HDMI 1, 4 HDMI 2, 5 Wireless (BYOD). Outputs: 1 HDBaseT, 2 HDMI.

| State | Description |
|---|---|
| `control.source` | Active input (1 to 5) |
| `control.volume` | Volume, -80 to 0 dB |
| `control.muteHdmi`, `control.muteAnalog` | Mute the HDMI or the analog audio output |
| `control.display` | Display output on; off mutes audio and video |
| `control.audioSource` | Write `digital` (audio from the video input) or `analog` (analog audio in) to set the active input's audio source. Telnet connection only, not available while the wireless input is active, and not read back (see known limitations) |
| `control.matrixMode` | 0 off, 1 matrix, 2 matrix with static route |
| `outputs.<n>.source` | Input shown on output `<n>`. Settable only while matrix mode is on |
| `inputs.<n>.signal` | A signal is present on input `<n>` |
| `inputs.<n>.hdcp` | HDCP enabled on wired input `<n>` (1 to 4) |
| `commands.reboot` | Reboot the device |
| `commands.byodKick` | Disconnect all wireless (BYOD) clients |

Routes and input signals update immediately when the device reports a change; the rest is read at the
polling interval.

## Troubleshooting

Set the instance's log level to `debug` to see every command and reply.

| Log message | Cause and fix |
|---|---|
| `Device closed the connection straight away` | The device refuses the connection, usually because of an IP whitelist, or telnet is disabled in the device's web interface. Allow the ioBroker host |
| `Full Connections` | All telnet sessions are in use by other clients. Close them, or use the WebSocket connection |
| `Login rejected: check username and password` | The device asks for a telnet login and the credentials are wrong. Use the device's web interface credentials |
| `Cannot connect to …` | The device is unreachable. The adapter keeps retrying in the background and logs the recovery |
| `Cannot set … : … Is matrix mode on?` | Output routes can be changed only in matrix mode. Set `control.matrixMode` to 1 first |

## Known limitations

- **Audio source (AT-UHD-SW-510W):** the device accepts the command, but its `Audio:GetSource` query did not
  reflect the change in testing, so the setting is not read back. Its WebSocket parameters are
  undocumented, so it is available over telnet only.
- **Wireless input signal (AT-UHD-SW-510W, WebSocket):** the device's status query reports the wireless
  input as active with no client connected, so this one signal is taken from the device's change
  notifications only.
- **Reboot** has not been tested on hardware.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.0 (2026-09-27)

- AT-UHD-SW-510W support: input, volume, mutes, display, HDCP, matrix mode and routing, over the WebSocket (default) or telnet

### 0.0.1 (2026-09-27)

- Initial release

## License

MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Released under the MIT License. See [LICENSE](LICENSE) for the full text.
