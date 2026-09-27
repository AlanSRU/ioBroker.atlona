# Model Expansion Plan — Universal Atlona Adapter (`iobroker.atlona`)

> Status: **planning** (2026-09-27). Goal: one ioBroker adapter covering Atlona's controllable
> switcher / matrix / scaler / amplifier range, current and discontinued, replacing the
> single-model `iobroker.atlona-sw510w` (which stays as-is).
> AV-over-IP (OmniStream) is **out of scope** — separate adapter, same reasoning as Blustream ACM.

All command references live in `docs/` (gitignored, local only). `docs/pdf/` holds the official
Atlona API PDFs and manuals recovered for this work.

## 1. What we learned

### Ownership and sources
- **Hall Technologies (Hall Research) bought the Atlona range from Panduit** (announced 1 Jul 2025).
  `atlona.com` and `atlona.com/pdf/*` now redirect to `hallresearch.com`, and the PDFs there
  return 404. The old site is still up at **`https://ts.atlona.com/`**, and the Wayback Machine
  (`web.archive.org/web/2024id_/https://atlona.com/pdf/<MODEL>_API.pdf`) has most API PDFs.
  Keep the local copies.
- **The AT-UHD-SW-510W and AT-OME-MS52W are discontinued** (notice 13 Oct 2025, EOL 13 Nov 2025,
  **support ends 13 Nov 2026**). Atlona's named replacement is the AT-OME-MS42, which uses the ASCII dialect.
- Field-tested third-party clients used as cross-checks:
  - BYU OIT AV's Go drivers (`docs/byu-go-drivers.txt`);
  - the openHAB Atlona binding (PRO3);
  - the Bitfocus Companion Omega module (MS42).

### Command dialects
| Dialect | Form | Transport | Used by | Existing code |
|---|---|---|---|---|
| **ASCII** | `x3AVx1`, `Status`, `VOUT1 -20`, `VOUTMute1 on`, `PWSTA`, `Type` | Telnet 23 (+ TCP 9000 on Omega/M2C/DISP-CTRL), RS-232; CR terminated | Almost the whole range (§3a) | BYU Go only |
| **Colon/JSON** | `Display:Input:Set 2` → `{"methodreturn":…,"result":{…}}` | Telnet 23, RS-232, REST `http://ip/API?method=` | SW-510W, OME-MS52W only (both EOL) | ✅ `iobroker.atlona-sw510w` |
| **JSON-RPC 2.0 / WebSocket** | `{"jsonrpc":"2.0","method":"VideoSwitch.Set","params":{"in":"in5","out":"out1"}}` | `ws://<ip>/ws` | PRO5-MX810, OME-CS31-SA*, USB-EX350, WAVE-101 | ❌ new |
| *Legacy WP_* | `WP_Input[Hdmi2]$` | RS-232 only | HDVS-RX / HDVS-150-RX | ❌ skip |

**Design implication:** one adapter, one shared state tree, and **three pluggable drivers**
selected by the model definition (`dialect: 'ascii' | 'colon' | 'jsonrpc'`). The ASCII driver
carries most of the range. Its per-model differences are small and fit in def flags (§4),
the same pattern as Blustream's `commandStyle`.

## 2. Architecture

```
main.js                 adapter lifecycle, state tree creation from model def, onStateChange → driver
lib/models.js           MODEL_DEFINITIONS (pure data, dependency-free, unit-testable)
lib/transport/telnet.js ONE persistent TCP session, IAC stripping, login prompt handling,
                        500 ms inter-command pacing, line framing, reconnect/backoff
lib/transport/ws.js     WebSocket client (JSON-RPC)
lib/drivers/ascii.js    build commands from def flags; parse replies (pure functions)
lib/drivers/colon.js    port of the SW-510W logic (fixed, see §6)
lib/drivers/jsonrpc.js  JSON-RPC request/response + id correlation
test/unit/              replay parsers against doc examples / captured replies
```

Shared rules taken from the research:
- **One persistent session per device.** Devices limit concurrent telnet sessions and reply
  `Full Connections` when the limit is reached. Don't open a connection per command, which BYU does.
- **At least 500 ms between commands** (stated in several ASCII docs and the SW-510W doc).
- **Login:** when `IPLogin` is on, the device prompts with `Login:`/`Password:` (PRO3) or
  `Username:`/`Password:` → `Welcome to TELNET.` (Omega). Detect the prompt rather than assuming it.
  Defaults are `admin`/`Atlona` (Omega, Gain, DISP-CTRL) or `root`/`Atlona` (JUNO-451,
  SW-5000ED, older UIs). The PRO5 has no default and forces a password to be set. Credentials
  go in encrypted native config.
- **Feedback:** use `Broadcast on` where the model supports it, so front-panel changes are pushed
  to us. Otherwise poll `Status` / `sta`. Always poll as a fallback.

## 3. In-scope model catalogue

Legend: **✱** = supported by an existing adapter; **EOL** = discontinued. Sources are in
`docs/*.txt` (each file header lists URLs); PDFs are in `docs/pdf/`.

### 3a. ASCII dialect
| Family | Models | Status | Notable variations | Ref |
|---|---|---|---|---|
| UHD-PRO3 matrices | PRO3-44M/66M/88M/1616M, UHD-H2H-88M | EOL | case-sensitive; `IPLogin` default on; `x2All`, `All#`; `Statusx8`; VOUT −79..15; `x3$ off` = output disable | `uhd-pro3-matrix.txt` |
| HDR-H2H matrices | HDR-H2H-44M/44MA/88MA | current | `Status` uses comma+space; `Command FAILED: <cmd>`; no VOUT | `hdr-h2h-opus-matrix.txt` |
| Opus | OPUS-810M/68M/46M, OPUS-RX41 | mixed | audio/video breakaway `x2Vx7`, `x5Ax4`; `Status A\|V\|AV` | `hdr-h2h-opus-matrix.txt` |
| Omega | OME-PS62, MS42, SW32, ST31/ST31A, SR21, MH21, RX21/31, TX21-WP-E | mostly current | `InputStatus 0100`; PS62 VOUT1..4 −90..10; `Status` shows `x3Vx1` in the PDFs but BYU parses `x3AVx1`, so accept both; no Broadcast documented on PS62/MS42/SW32; PS62 has no power commands | `omega-ascii.txt` |
| Juno | JUNO-451, JUNO-451-HDBT | current / EOL | `InputBroadcast`; no volume | `juno-sw-switchers.txt` |
| UHD-SW | UHD-SW-51/52/52ED, SW-5000ED | EOL / current | VOUT1 −80..15 | `juno-sw-switchers.txt` |
| HDR-SW | HDR-SW-51/52/52ED | current | **not** case-sensitive; **UPPER-case replies** (`X1AVX2`); pushes Input/OutputStatus; `x1$ on` = **mute** (the opposite of PRO3); VOUT −90..10 | `juno-sw-switchers.txt` |
| CLSO matrix scalers | UHD-CLSO-824, 840 | EOL | 840 has `x6Ax2` breakaway; `VINx` | `clso-scalers-hdvs.txt` |
| Input-style scalers | UHD-CLSO-601/612, HD-SC-500, HDVS-200-TX/RX | mixed | `Input HDMI 2` instead of `xYAVxZ`; `VOL(-23)`, `VOLMute on`; `PWSTA` → `ON` | `clso-scalers-hdvs.txt` |
| HDVS wall-plates | HDVS-210H/U-TX-WP, UHD-HDVS-300-KIT, HDVS-SC-RX | mixed | `PWSTA` → `ON` | `clso-scalers-hdvs.txt` |
| Distribution amps | HDR-CAT-2/4/4ED/8, UHD-CAT-xx | current | `InputBroadcast` | `catalogue.txt` |
| Gain amps | GAIN-60, GAIN-120 | current / EOL | not case-sensitive; `Unknown command`; routing `11AV`/`1AV`; `VOL 0..100`; `VOUTMute` has no index; Broadcast on by default | `gain-audio.txt` |
| Gain mixer amps | GAIN-M120/M240 | current | **Telnet off by default**, TCP 9000 | `gain-mixer-amps.txt` |
| Audio converter | HDR-M2C / M2C-QUAD | current | VOUT1 −80..6; `BASS1`/`TREBLE1`; broadcasts on 9000 | `gain-audio.txt` |
| Display controller | DISP-CTRL | current | TCP 9000/9001 | `catalogue.txt` |

### 3b. Colon/JSON dialect
| Model | Status | Notes | Ref |
|---|---|---|---|
| ✱ AT-UHD-SW-510W | EOL (support ends Nov 2026) | port of the existing adapter | `sw-510w-json.txt` |
| AT-OME-MS52W | EOL | superset: CEC:Trig, USBRouting:*, bass/treble, `SetBroadcast` pushes on TCP 9000 | `ome-ms52w-json.txt` |

### 3c. JSON-RPC 2.0 over WebSocket
| Model | Status | Ref |
|---|---|---|
| AT-PRO5-MX810 (+ PRO5-101 receivers) | current | `jsonrpc-websocket.txt` |
| AT-OME-CS31-SA / -SA-HDBT / -SA-C | current | `jsonrpc-websocket.txt` |
| AT-USB-EX350 | current | `jsonrpc-websocket.txt` |
| AT-WAVE-101 | EOL (uses a login cookie) | `jsonrpc-websocket.txt` |

Unverified: whether `/ws` needs auth on PRO5/CS31 (not documented), and whether it pushes events.

## 4. Model-definition flags (ASCII driver)

| Flag | Values | Why |
|---|---|---|
| `inputs` / `outputs` | numbers (+ optional names) | state tree size |
| `routeStyle` | `xav` (`x3AVx1`) \| `input` (`Input HDMI 2`) \| `gain` (`11AV`) | how inputs are selected |
| `breakaway` | bool | adds `audioSource`/`videoSource` per output (`xYVx`, `xYAx`) |
| `caseSensitive` | bool (default true) | HDR-SW / Gain are not |
| `upperCaseReplies` | bool | HDR-SW; normalise before parsing anyway |
| `volume` | `{cmd:'VOUT'\|'VOL'\|'VOL()', indexed, min, max}` or null | range differs per model |
| `muteCmd` | `VOUTMute` \| `VOLMute`, indexed? | |
| `outputDollar` | `mute` \| `disable` \| null | `x1$` means different things per model |
| `power` | `{on:'PWON', off:'PWOFF', sta:'PWSTA', reply:'PWON'\|'ON'}` or null | PS62 has none |
| `broadcast` | `none` \| `off` \| `on` (default state) | whether to send `Broadcast on` |
| `inputStatus` | bool | per-input signal detection (`InputStatus 0100`) |
| `presets` | count or 0 | `Save n` / `Recall n` |
| `errorRe` | regex | `Command FAILED`, `Unknown command` |
| `extraPorts` | e.g. `{cmd:9000}` | TCP 9000 command port alternative |

Parser rules that come straight from the docs:
- routes: `/x(\d+)(AV|V|A)x(\d+)/gi` on the reply split by `/,\s*/`;
- replies are `<cmd> <value>`;
- normalise case.

## 5. Model detection

1. **Probe telnet 23 with `Type\r`.** ASCII devices reply with the model (`AT-GAIN-120`; OmniStream
   replies `at-omni-112`, which we reject as out of scope).
2. If the reply is `Unknown command`, send **`Misc:Model:Get\r`**. A JSON reply means the colon dialect.
   That `Type` fails on SW-510W/MS52W is inferred, not documented.
3. If there's no telnet, try **`ws://<ip>/ws`** with `System.Get`; `result.model` means JSON-RPC.
4. Map the model string to a def; the admin model dropdown overrides detection.
5. Atlona's MAC OUI is **B8:98:B0**. That could drive a "find devices" button from ARP/DHCP later
   (not v1). No SSDP/mDNS service is documented.

## 6. Lessons from `iobroker.atlona-sw510w` (don't carry these over)
- **Startup side effects:** it sends `Display:Input:Set 1` 15 s after start (simulated state change),
  and sends test commands on a timer and on connect. **This switches a live device's input.**
- Almost everything is logged at `warn`. Use `debug`, and keep `info` for connect/disconnect.
- An unused `telnet-client` require that isn't a dependency; `adapter-core ^2.6`; placeholder package metadata.
- `Display:Minimal:Get` replies with plain `on`/`off`. The current non-JSON fallback sets
  `control.display` from *any* non-JSON line containing "on". Correlate replies to the pending command instead.
- The doc shows multi-line JSON. Send `OutputMode j` (single-line JSON) on connect, or buffer
  until braces balance. Verify on hardware.
- The terminator should be CR, not CR LF.
- Colon commands we don't expose yet: `Display:Input:All:Get` (per-input signal), `Moderator:*`,
  `Relay:State`, `Zone:SendCmd` (RS-232 to the display), `Net:GetInfo`, `GetHostName`.

## 7. Out of scope
| Line | Reason |
|---|---|
| OmniStream AT-OMNI-1xx/5xx | AV-over-IP fleet with multicast routing, so a separate adapter (`omnistream-api.txt` kept) |
| OMNI-311/324 (binary UDP 6137), OMNI-232/238 (UDP 49494) | niche and part of OmniStream |
| Cameras HDVS-CAM | VISCA on 1259, so use a generic PTZ/VISCA adapter (`cameras-visca.txt`) |
| Velocity VGW/VTP/VKP/VDM | only triggers macros; cannot report device state. Possible later add-on (`velocity-api.txt`) |
| OCS-900N occupancy sensor | different domain; MQTT is available natively (`ocs-900n.txt`) |
| GAIN-M50-LZ | RS-232 only; could come later via a serial transport |
| HDVS-RX / HDVS-150-RX | legacy WP_ dialect, RS-232 only |
| AMS, CAP-series, Rondo | monitoring only or no API |

## 8. Phasing
1. **Scaffold + shared transport.** Current `@iobroker/create-adapter` template (as used for
   blustream-mfp): jsonConfig admin, encrypted credentials, the telnet transport, login handling,
   pacing, and the model-def-driven state tree. → verify: repochecker clean; unit tests for the transport framing.
   **Done 2026-09-27** apart from repochecker, which needs the GitHub repo, and the icon.
2. **Colon driver.** Port SW-510W (+MS52W) with the §6 fixes. This comes first because the SW-510W
   is the only test hardware (decided 2026-09-27), so it proves the shared transport, state tree and
   release pipeline on a real device. → verify on the SW-510W; old adapter can then be deprecated.
   **2026-09-27:** driver done over telnet. Polls fw 2.9.8 correctly; no-op Sets verified. Still to do: real (state-changing)
   Set tests with the user present, MS52W def, and the first release.
3. **ASCII driver, first families.** Omega (PS62/MS42), UHD/HDR-SW-5x, GAIN-60. These are the
   families with the best cross-checked sources. → verify: parsers unit-tested against doc examples.
   Mark them unverified until tested on hardware.
4. **Remaining ASCII families.** Matrices (PRO3, HDR-H2H, Opus with breakaway), CLSO/HDVS
   input-style scalers, CAT, M2C, DISP-CTRL.
5. **JSON-RPC driver.** PRO5-MX810, OME-CS31-SA.
6. **Auto-detection** (§5) and the migration note for existing `atlona-sw510w` users.

## 9. Open questions
- ~~Which hardware can we test against?~~ **The SW-510W, to start with.** Everything else is built
  from docs and must be marked unverified in the README.
- Does the SW-510W accept `Type`? Does it push on TCP 9000 like the MS52W? (Check both in phase 2.)
- PRO3 / Omega: are front-panel changes broadcast? What are the exact PRO3 login prompt bytes?
- ~~Deprecate `iobroker.atlona-sw510w`?~~ **Yes**, once phase 2 is running on the SW-510W.
