# gladys-yeelight

External [Gladys Assistant](https://gladysassistant.com) integration to control your **Yeelight** Wi-Fi lights over the local network, through the official Yeelight LAN control protocol.

Built on the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js), from the [official template](https://github.com/GladysAssistant/integration-template-js).

> **Prerequisite:** "LAN Control" must be enabled on each light, in the Yeelight app. A light without it refuses every local command and is not discoverable.

## What it does

| Capability            | Exposed when the light advertises               |
| --------------------- | ----------------------------------------------- |
| On / off              | always                                          |
| Brightness (1-100 %)  | `set_bright`                                    |
| Color (0xRRGGBB)      | `set_rgb`                                       |
| Color temperature (K) | `set_ct_abx`                                    |
| Ambient light         | `bg_set_power` / `bg_set_bright` / `bg_set_rgb` |
| Night light           | ceiling models                                  |

Features are keyed on the `support` header each light advertises, not on a hardcoded model table — so a model released after this code was written still gets exactly the features its firmware implements.

## Architecture

```
index.js                       SDK wiring: handlers + manifest actions
src/config.js                  config normalization, hand-declared lights
src/devices.js                 discovery / state publishing / commands orchestration
src/yeelight/
  YeelightManager.js           one live connection per light, reconnection backoff
  YeelightClient.js            the LAN protocol: framing, correlation, quota
  discovery.js                 M-SEARCH forging and reply parsing
  mapping.js                   bulb capabilities -> Gladys feature descriptors
  models.js                    support list parsing, per-model Kelvin ranges
  convert.js                   value translation, both directions
  constants.js                 protocol constants, external-id scheme
```

## Push model

This is not a polling integration. Yeelight lights **push** their state changes over a connection kept open, so:

- states reach Gladys from the manager's `onProps` callback, through `publishStates()`;
- a light dimmed at the wall switch or from the Yeelight app updates Gladys immediately;
- `onPoll` is only a safety net: it reconnects a light whose session dropped and re-reads its properties.

## Discovery: why not SSDP

Yeelight uses an SSDP-_like_ protocol on **port 1982**, not standard SSDP on 1900 — the spec explains they moved off 1900 to spare battery-powered devices the generic multicast flood. The core's generic `ssdp` scanner would therefore never see a light.

Discovery goes through the `udp-active-broadcast` capture instead: the integration forges the M-SEARCH, the core broadcasts it from the host network (a bridge container cannot) and relays the raw unicast replies.

```json
"network_discovery": [{ "type": "udp-active-broadcast", "ports": [1982] }]
```

A single reply already carries the id, the model, the support list **and** the full state, so a scan alone builds a complete device with no TCP round-trip.

## Protocol constraints

Three limits from the spec shape the code, and all three fail _silently_ when violated:

- **4 simultaneous connections** per light — hence one shared connection per light, never one per command;
- **60 commands per minute** per connection — enforced by the light going quiet, not by an error, so the client rate-limits itself over a sliding window (bursts stay instant, only a genuine flood waits);
- **color, temperature and brightness are refused while the light is off** — those commands are flagged `requiresPower`, and the light is switched on first.

## External-id scheme

The platform id is the light **id** reported in discovery (`0x000000000015243f`), burned in at the factory. An IP address is a DHCP lease, so it lives in a device param instead.

```
device : ext:<selector>:yeelight:<bulbId>
feature: ext:<selector>:yeelight:<bulbId>:<featureKey>
```

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

Actions → **Release** → pick patch / minor / major. The workflow bumps the version everywhere (package.json, manifest, image tag), regenerates `CHANGELOG.md` from the Conventional Commits, tags, publishes the GitHub release and pushes the multi-arch image to ghcr.io.

## License

Apache-2.0
