# ioBroker.atlona

[![NPM version](https://img.shields.io/npm/v/iobroker.atlona.svg)](https://www.npmjs.com/package/iobroker.atlona)
[![Downloads](https://img.shields.io/npm/dm/iobroker.atlona.svg)](https://www.npmjs.com/package/iobroker.atlona)
![Test and Release](https://github.com/AlanSRU/ioBroker.atlona/workflows/Test%20and%20Release/badge.svg)

## Atlona adapter for ioBroker

Controls [Atlona](https://atlona.com/) AV switchers, matrix switchers, scalers and amplifiers over the
network. Atlona products use three control protocols; this adapter covers all three with one state tree:

| Protocol | Transport | Example models |
|---|---|---|
| ASCII | Telnet (TCP 23) | Omega, UHD-PRO3, HDR-H2H, Opus, Juno, UHD/HDR-SW, CLSO, GAIN |
| Colon/JSON | Telnet (TCP 23), or JSON-RPC WebSocket (`ws://<ip>/API`) | AT-UHD-SW-510W, AT-OME-MS52W |
| JSON-RPC 2.0 | WebSocket (`ws://<ip>/ws`) | AT-PRO5-MX810, AT-OME-CS31-SA |

**Status: early development.** The AT-UHD-SW-510W is supported; further models follow.

### Supported models

| Model | Protocol | Tested on hardware |
|---|---|---|
| AT-UHD-SW-510W | Colon/JSON (WebSocket or telnet) | Yes, firmware 2.9.8, over both connections: status, volume, both mutes, display output, HDCP, input switching, matrix mode and routes changed and restored on a real unit. Audio source unverified; reboot not tested |

Anything not tested on hardware is built from Atlona's published API documents and the device's own help text. Reports from owners are welcome in the [issue tracker](https://github.com/AlanSRU/ioBroker.atlona/issues).

## Requirements

- Node.js 22 or newer
- js-controller 6.0.11 or newer, admin 7.6.20 or newer
- Telnet control enabled on the device (the default on most models)

## Configuration

| Option | Default | Description |
|---|---|---|
| Device address | | IP address or host name of the device |
| Connection | Automatic | Automatic uses the WebSocket where the model has one (AT-UHD-SW-510W), otherwise telnet. Telnet or WebSocket can also be chosen explicitly |
| Telnet port | `23` | TCP port of the telnet control interface |
| WebSocket port | `80` | HTTP port of the JSON-RPC WebSocket (`ws://<ip>:<port>/API`) |
| Device model | AT-UHD-SW-510W | The connected model |
| Username | `admin` | Sent only if the device asks for a telnet login (telnet only) |
| Password | (Atlona default) | Sent only if the device asks for a telnet login (telnet only). Stored encrypted |
| Polling interval | `30000` | How often the status is read, in ms (15000 to 3600000) |

The adapter keeps one session open and sends at most one command every 500 ms. Atlona devices allow only
a few simultaneous telnet sessions (the AT-UHD-SW-510W only one) and answer `Full Connections` when all are
taken, so close other telnet clients if the adapter reports that. The AT-UHD-SW-510W's WebSocket accepts
several clients at once, answers faster, and pushes routing changes immediately; it is used by default.

At startup the adapter only queries the device. It never changes inputs, volume or power by itself.

If the device has an **IP whitelist** for telnet, add the ioBroker host to it. Otherwise the device closes
the telnet connection straight away and the adapter logs "Device closed the connection straight away".

## States

| State | Description |
|---|---|
| `info.connection` | The connection to the device (WebSocket or telnet) is open and answering |
| `info.model`, `info.firmware` | Device model and firmware version |
| `info.temperature` | Internal temperature (models that report it) |
| `control.source` | Active input (switchers) |
| `control.volume`, `control.mute` | Volume and mute (models with one audio output) |
| `control.power` | Power (models with power control) |
| `inputs.<n>.signal` | A signal is present on input `<n>` |
| `outputs.<n>.source` | Input routed to output `<n>` (matrix switchers) |
| `outputs.<n>.volume`, `outputs.<n>.mute` | Per-output volume and mute |

Inputs and outputs are numbered from 1 in the order the device labels them. Each model creates only the
states it supports.

### AT-UHD-SW-510W

Inputs: 1 USB-C, 2 DisplayPort, 3 HDMI 1, 4 HDMI 2, 5 Wireless (BYOD). Outputs: 1 HDBaseT, 2 HDMI.

| State | Description |
|---|---|
| `control.source` | Active input (1 to 5) |
| `control.volume` | Volume, -80 to 0 dB |
| `control.muteHdmi`, `control.muteAnalog` | Mute the HDMI or the analog audio output |
| `control.display` | Display output on; off mutes audio and video |
| `control.audioSource` | Write `digital` (audio from the video input) or `analog` (analog audio in) to set the active input's audio source. Telnet connection only. Not read back: the device's `Audio:GetSource` did not reflect the change in testing. Cannot be set while the wireless input is active. Unverified |
| `control.matrixMode` | 0 off, 1 matrix, 2 matrix with static route |
| `outputs.<n>.source` | Input shown on output `<n>`. Only settable while matrix mode is on |
| `inputs.<n>.signal` | A signal is present on input `<n>`. Over the WebSocket, the wireless input's signal is taken from the device's change notifications only, because its status query reports the wireless input as active with no client connected |
| `inputs.<n>.hdcp` | HDCP enabled on wired input `<n>` (1 to 4) |
| `commands.reboot`, `commands.byodKick` | Reboot the device; disconnect all wireless clients |

Routes and input signals are updated immediately when the device reports a change; everything else is
read at the polling interval.

#### Moving from `iobroker.atlona-sw510w`

This adapter replaces `atlona-sw510w`. With the default WebSocket connection both adapters can run at the
same time, so scripts can be moved over one by one. With a telnet connection, stop the old instance first:
the device accepts only one telnet client. State ids have changed, and inputs and outputs are now numbered
from 1:

| `atlona-sw510w` | `atlona` |
|---|---|
| `control.input` (0 to 4) | `control.source` (1 to 5) |
| `control.mute.hdmi`, `control.mute.analog` | `control.muteHdmi`, `control.muteAnalog` |
| `control.hdcp.input0` … `input3` | `inputs.1.hdcp` … `inputs.4.hdcp` |
| `control.matrix.hdbasetOutput`, `control.matrix.hdmiOutput` (0 to 4) | `outputs.1.source`, `outputs.2.source` (1 to 5) |
| `control.volume`, `control.display`, `control.matrixMode`, `control.audioSource` | unchanged ids |
| `commands.reboot`, `commands.byodKick` | unchanged ids |
| `commands.factoryReset` | removed |

Scripts and visualisations that use the old ids need updating.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- AT-UHD-SW-510W support (replaces `iobroker.atlona-sw510w`): input, volume, mutes, display, HDCP, matrix mode and routing, over the WebSocket (default) or telnet

### 0.0.1 (2026-09-27)

- Initial release

## License

MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Released under the MIT License. See [LICENSE](LICENSE) for the full text.
