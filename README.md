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

**Status: early development.** The connection layer and state tree are in place; device commands follow.

### Supported models

| Model | Protocol | Tested on hardware |
|---|---|---|
| AT-UHD-SW-510W | Colon/JSON | not yet |

Models marked "not yet" are built from Atlona's published API documents and have not been tested on a
real device. Reports from owners are welcome in the [issue tracker](https://github.com/AlanSRU/ioBroker.atlona/issues).

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

The adapter keeps one telnet session open and sends at most one command every 500 ms. Atlona devices
allow only a few simultaneous telnet sessions and answer `Full Connections` when all are taken, so close
other telnet clients if the adapter reports that.

At startup the adapter only queries the device. It never changes inputs, volume or power by itself.

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

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- Initial version: telnet transport with login handling, command pacing and reconnect; model-driven state tree

## License

MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Released under the MIT License. See [LICENSE](LICENSE) for the full text.
