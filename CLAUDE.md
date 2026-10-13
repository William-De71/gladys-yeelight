# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Yeelight Wi-Fi lights (bulbs,
LED strips, bedside lamps, ceiling lights): a Node.js service (Node 22+, ESM,
no build step) running in its own sandboxed Docker container, talking to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to the lights through the Yeelight LAN protocol (JSON lines over TCP
55443, implemented on Node's `net`, no other runtime dependency).
`type: "device"`, local only, Gladys >= 5.1.0. Lights are found through the
`udp-active-broadcast` capture Gladys performs on UDP 1982 (not standard SSDP),
push their states over a connection kept open, and their outages become scene
triggers; light effects are scene actions.

## Commands

```bash
npm install
npm test                                  # node --test, never touches the network
node --test test/app.test.js              # one file
node --test --test-name-pattern "scene"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store . --skip-image-check
```

## Architecture

```
index.js                         SDK wiring only: createApp(new GladysIntegration()) + connect
src/app.js                       every handler, registered before connect(); the tests drive
                                 it with the fake Gladys of the SDK (test/app.test.js)
src/events.js                    scene triggers light_offline, light_online (30 s grace)
src/scenes.js                    scene actions start_effect, stop_effect
src/devices.js                   discovery, state publishing (publishChangedStates), commands
src/config.js                    config normalization, hand-declared lights, addresses
src/messages.js                  runtime messages, en / fr / de / es
src/yeelight/YeelightManager.js  one connection per light, reconnection backoff, heartbeat
src/yeelight/YeelightClient.js   LAN protocol: framing, id correlation, sliding-window quota
src/yeelight/discovery.js        M-SEARCH forging and reply parsing
src/yeelight/effects.js          light effects as colour flows (set_scene cf)
src/yeelight/mapping.js          bulb capabilities -> Gladys feature descriptors and labels
src/yeelight/models.js           support list parsing, per-model Kelvin ranges
src/yeelight/convert.js          values both ways (temperature in mired on the Gladys side)
.github/scripts/release.mjs      version, changelog, version files, PR title checks
```

## Rules

- **Forever fields**: device and feature external ids
  (`ext:<selector>:yeelight:<bulbId>[:<featureKey>]`, `bulbId` being the
  factory id, or `manual-<ip>` for a light added by hand), and for each
  feature its `category`, `type`, `unit`, `min`, `max`, `read_only`,
  `has_feedback`; the device params; the `config_schema` and action keys; the
  scene trigger keys (`light_offline`, `light_online`), their field `light`
  and variables; the scene action keys (`start_effect`, `stop_effect`), their
  fields, the effect values (`EFFECTS` in `src/yeelight/effects.js`) and the
  output `light_name`. `test/structure.test.js` checks the discovery against
  `test/fixtures/discovery.baseline.json` (built from
  `test/fixtures/discovery.bulbs.json`) and the manifest against
  `test/fixtures/manifest.baseline.json` (v1.2.1). A change needs an entry in
  its `ALLOWED_CHANGES` with the migration, in the changelog, the docs and the
  forum message: users would have to delete and recreate their devices.
- **Features follow the `support` header** the light advertises, never a model
  table; the model only gives the Kelvin range and the known firmware quirks.
  The colour temperature is in mired on the Gladys side, with no unit.
- **4 connections, 60 commands per minute per light**, enforced by the light
  going silent: never open a second connection to a light, go through
  `YeelightManager.ensureClient` / `command`, which share the attempt in
  flight; every command goes through the client's sliding-window quota (55).
  The heartbeat (one `get_prop` per minute for a silent light) and the
  read-back after a power command count against it.
- **Colour, temperature and brightness are refused while a light is off**:
  those commands carry `requiresPower`; switch on first, only when the light
  is really off (a needless `set_power` restarts the fade).
- **States**: only the changed ones, through `publishChangedStates` (heartbeat
  1 h). A device created receives its current state right away
  (`onDeviceCreated`), as a light only pushes changes.
- **Scene events** on transitions only, flat scalar data limited to the
  declared variables, for created devices only. `light_offline` waits 30 s
  (a light switched off and on again fires nothing), `light_online` only
  follows a fired `light_offline`. Never fire an event caused by an action of
  the integration: an effect changes states, never the reachability.
- **Language**: Gladys does not send it with a command or a scene action.
  Error messages are in English (they also go to the logs); every text Gladys
  shows comes from the manifest or `src/messages.js`, in four languages.
  Feature labels (`src/yeelight/mapping.js`) are English only: the docs say
  so.
- **The container rootfs is read-only** and the integration stores nothing:
  the light addresses live in the device params.
- **User-facing text** exists in en, fr, de and es: manifest,
  `src/messages.js`, `docs/*.md`, `README*.md`. `test/i18n.test.js` checks it.
  Images in `docs/*.md` use `raw.githubusercontent.com` URLs (the store
  re-hosts the docs), relative paths in the READMEs.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, `package-lock.json` or the manifest, nor the `docker_image`
  tag.
- **Changelog**: Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Style**: Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
