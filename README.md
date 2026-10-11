# gladys-yeelight

Gladys Assistant external integration for **Yeelight** Wi-Fi lights — bulbs, LED strips, bedside lamps and ceiling lights — over the local network.

![Yeelight integration for Gladys Assistant](cover.jpg)

Installable in one click from [Gladys Assistant](https://gladysassistant.com), it talks to your lights directly on your local network, through the official Yeelight LAN control protocol — no cloud account, no gateway, no runtime dependency beyond the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js). Lights are found by a network scan, their features follow what each firmware advertises, and every state change is pushed to Gladys the moment it happens — wall switch and Yeelight app included.

📖 User documentation: [English](docs/en.md) — [Français](docs/fr.md) — [Deutsch](docs/de.md) — [Español](docs/es.md)

> **Prerequisite:** "LAN Control" must be enabled on each light, in the Yeelight app. A light without it refuses every local command and is not discoverable. It is the first cause of "no light found".

## How it works

![Gladys, the integration and your Yeelight lights: lights push their states over one open connection each, commands leave from Gladys, and discovery goes through the broadcast Gladys sends on UDP 1982](docs/images/overview.svg)

| Capability                | Exposed when the light advertises                                     |
| ------------------------- | --------------------------------------------------------------------- |
| On / off                  | always                                                                |
| Brightness (1-100 %)      | `set_bright`                                                          |
| Color (0xRRGGBB)          | `set_rgb`                                                             |
| Color temperature (mired) | `set_ct_abx` — except RGB-only strips (`strip6`)                      |
| Ambient light             | `bg_set_power`, plus `bg_set_bright` / `bg_set_rgb` / `bg_set_ct_abx` |
| Night light (moonlight)   | ceiling models                                                        |

Features are keyed on the `support` header each light advertises, not on a hardcoded model table — so a model released after this code was written still gets exactly the features its firmware implements. The model only decides the Kelvin range of the temperature slider, and the few firmwares known to advertise a method they ignore.

The color temperature is published in **mired**, like the core's Philips Hue and Tasmota integrations: Gladys draws the slider with a cold→warm gradient, which mired follows and Kelvin runs against. Values are converted at the boundary, within the range of the model.

## Discovery: why not SSDP

![Two sources feed the Discover screen: the network scan, whose replies carry the factory id, the model, the capabilities and the state, and the lights added by hand, probed over TCP; both end up as one device per light](docs/images/discovery.svg)

Yeelight uses an SSDP-_like_ protocol on **port 1982**, not standard SSDP on 1900 — the spec explains they moved off 1900 to spare battery-powered devices the generic multicast flood. The core's generic `ssdp` scanner would therefore never see a light.

Discovery goes through the `udp-active-broadcast` capture instead: the integration forges the M-SEARCH, the core broadcasts it from the host network (a bridge container cannot) and relays the raw unicast replies.

```json
"network_discovery": [{ "type": "udp-active-broadcast", "ports": [1982] }]
```

A single reply already carries the id, the model, the support list **and** the full state, so a scan alone builds a complete device with no TCP round-trip.

Lights on another subnet or VLAN — which no broadcast reaches — are declared by hand and probed over TCP. The factory id cannot be read that way, so such a light is identified by its address (`manual-<ip>`), and the docs ask for a DHCP reservation. A hand-declared address the scan also found is not probed: the scan identity wins and the light is listed once.

## Commands and protocol constraints

![When you pick a colour on a light that is off, the integration switches it on first, then sends the colour; the light pushes its new state back](docs/images/commands.svg)

Three limits from the spec shape the code, and all three fail _silently_ when violated:

- **4 simultaneous connections** per light — hence one shared connection per light, never one per command. Concurrent callers (startup refresh, poll, command) share the connection being opened instead of racing to open several;
- **60 commands per minute** per connection — enforced by the light going quiet, not by an error, so the client rate-limits itself over a sliding window (bursts stay instant, only a genuine flood waits). A slider step costs one command: the power state is cached from the pushes instead of being queried each time;
- **color, temperature and brightness are refused while the light is off** — those commands are flagged `requiresPower`, and the light is switched on first (connecting if needed), but only when it is actually off, since a needless `set_power` restarts the fade.

Power commands are read back after the fade: they move features nothing pushes (an ambient ring following the main light, night light changing the brightness).

## Push model

This is not a polling integration. Yeelight lights **push** their state changes over a connection kept open, so:

- states reach Gladys from the manager's `onProps` callback, through `publishStates()`;
- a light dimmed at the wall switch or from the Yeelight app updates Gladys immediately;
- the created devices are read once at startup, since a light only pushes what _changes_;
- `onPoll` is only a safety net: it reconnects a light whose session dropped and re-reads its properties.

## External-id scheme

The platform id is the light **id** reported in discovery (`0x000000000015243f`), burned in at the factory. An IP address is a DHCP lease, so it lives in a device param instead.

```
device : ext:<selector>:yeelight:<bulbId>
feature: ext:<selector>:yeelight:<bulbId>:<featureKey>
```

## Architecture

```
index.js                       SDK wiring: handlers + manifest actions
src/config.js                  config normalization, hand-declared lights, addresses
src/devices.js                 discovery / state publishing / commands orchestration
src/messages.js                every user-facing message, in en / fr / de / es
src/yeelight/
  YeelightManager.js           one live connection per light, reconnection backoff
  YeelightClient.js            the LAN protocol: framing, correlation, quota
  discovery.js                 M-SEARCH forging and reply parsing
  mapping.js                   bulb capabilities -> Gladys feature descriptors
  models.js                    support list parsing, per-model Kelvin ranges
  convert.js                   value translation, both directions
  constants.js                 protocol constants, external-id scheme
```

## Languages

The manifest (configuration screen, actions), the messages shown in Gladys and the user documentation are available in the four languages of Gladys: English, French, German and Spanish. A test fails if any text is missing one of them.

## Local development

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
npm start
```

```bash
npm run lint          # ESLint
npm run format:check  # Prettier
npm test              # node --test
```

The control channel is plain text, so a light can be driven by hand while developing:

```bash
telnet <light-ip> 55443
{"id":1,"method":"set_power","params":["on","smooth",500]}
```

## Releasing

Actions → **Release** → pick patch / minor / major. The workflow bumps the version everywhere (package.json, manifest, image tag), regenerates `CHANGELOG.md` from the Conventional Commits, pushes the release commit and its tag in one atomic push, publishes the GitHub release and builds the multi-arch image (linux/amd64 + linux/arm64) on ghcr.io, with the manifest shipped as an image label.

## License

[Apache-2.0](LICENSE)
