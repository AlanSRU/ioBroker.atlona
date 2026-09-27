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
| Colon/JSON | Telnet (TCP 23) | AT-UHD-SW-510W, AT-OME-MS52W |
| JSON-RPC 2.0 | WebSocket (`ws://<ip>/ws`) | AT-PRO5-MX810, AT-OME-CS31-SA |

**Status: early development.** The AT-UHD-SW-510W is supported; further models follow.

### Supported models

| Model | Protocol | Tested on hardware |
|---|---|---|
| AT-UHD-SW-510W | Colon/JSON | Partly, firmware 2.9.8: all status values, and every setting written back with its current value. Audio source, reboot and BYOD disconnect not yet tested |

Anything not tested on hardware is built from Atlona's published API documents and the device's own help text. Reports from owners are welcome in the [issue tracker](https://github.com/AlanSRU/ioBroker.atlona/issues).

## Requirements

- Node.js 22 or newer
- js-controller 6.0.11 or newer, admin 7.6.20 or newer
- Telnet control enabled on the device (the default on most models)

## Configuration

| Option | Default | Description |
|---|---|---|
| Device address | | IP address or host name of the device |
| Telnet port | `23` | TCP port of the telnet control interface |
| Device model | AT-UHD-SW-510W | The connected model |
| Username | `admin` | Sent only if the device asks for a telnet login |
| Password | (Atlona default) | Sent only if the device asks for a telnet login. Stored encrypted |
| Polling interval | `30000` | How often the status is read, in ms (15000 to 3600000) |

The adapter keeps one telnet session open and sends at most one command every 500 ms. Atlona devices
allow only a few simultaneous telnet sessions and answer `Full Connections` when all are taken, so close
other telnet clients if the adapter reports that.

At startup the adapter only queries the device. It never changes inputs, volume or power by itself.

If the device has an **IP whitelist** for telnet, add the ioBroker host to it. Otherwise the device closes
the connection straight away and the adapter logs "Device closed the connection straight away".

## States

| State | Description |
|---|---|
| `info.connection` | The telnet session is open and logged in |
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
| `control.audioSource` | `digital` (audio from the video input) or `analog` (analog audio in) for the active input. Cannot be set while the wireless input is active |
| `control.matrixMode` | 0 off, 1 matrix, 2 matrix with static route |
| `outputs.<n>.source` | Input shown on output `<n>`. Only settable while matrix mode is on |
| `inputs.<n>.signal` | A signal is present on input `<n>` |
| `inputs.<n>.hdcp` | HDCP enabled on wired input `<n>` (1 to 4) |
| `commands.reboot`, `commands.byodKick` | Reboot the device; disconnect all wireless clients |

Routes and input signals are updated immediately when the device reports a change; everything else is
read at the polling interval.

#### Moving from `iobroker.atlona-sw510w`

This adapter replaces `atlona-sw510w`. The device accepts only one telnet client, so stop the old instance
before starting this one. State ids have changed, and inputs and outputs are now numbered from 1:

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

- Initial version: telnet transport with login handling, command pacing and reconnect; model-driven state tree
- AT-UHD-SW-510W support (replaces `iobroker.atlona-sw510w`)

## License

MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Released under the MIT License. See [LICENSE](LICENSE) for the full text.
