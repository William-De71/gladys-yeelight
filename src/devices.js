// -----------------------------------------------------------------------------
// Device orchestration: discovery, state publishing and commands.
//
// Bridges the YeelightManager (raw protocol) and the Gladys SDK. It holds no
// connection state of its own — the manager owns that.
//
// The push model is what makes this integration different from a polling one:
// bulbs send their state changes over the open connection, so states reach
// Gladys from the manager's `onProps` callback, and `onPoll` is only a safety
// net for a bulb whose session dropped.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { describeBulb, featureName, deviceName } from './yeelight/mapping.js';
import { buildCommand, readState, propsForFeatures } from './yeelight/convert.js';
import { discoverBulbs } from './yeelight/discovery.js';
import { YeelightClient } from './yeelight/YeelightClient.js';
import {
  EXTERNAL_ID_TYPE,
  DEFAULT_CONTROL_PORT,
  PARAM_ADDRESS,
  PARAM_MODEL,
  PARAM_FIRMWARE,
  PARAM_SUPPORT,
} from './yeelight/constants.js';

const logger = createLogger({ name: 'yeelight-devices' });

// Settling time added on top of the transition before reading a state back. The
// lamp needs a moment past the end of its fade to report the value it landed on.
const READ_BACK_MARGIN_MS = 250;

// Ceiling on that wait. `transition_duration` is user-supplied and unbounded,
// and Gladys acks `onSetValue` within 5 s: a long fade must not turn a working
// command into a timeout. Past this point the read-back is simply skipped — the
// push channel still reports the change when the fade ends.
const READ_BACK_MAX_WAIT_MS = 1500;

// A scan in flight, shared by concurrent callers. The core rate-limits network
// scans (1 per 10 s per integration), and a user clicking "Scan" twice must not
// turn the second click into a 429 that empties the Discover screen.
let inFlightScan = null;

/**
 * Discover the bulbs: the ones that answer the network scan, plus the ones the
 * user declared by hand. Manual entries are probed directly over TCP, since a
 * bulb the scan cannot see is exactly the case they exist for.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The discovered bulbs.
 * @example
 * const bulbs = await discoverAllBulbs(gladys, config);
 */
export async function discoverAllBulbs(gladys, config) {
  /** @type {Map<string, object>} */
  const bulbs = new Map();

  if (!inFlightScan) {
    inFlightScan = discoverBulbs(gladys, config.scan_duration).finally(() => {
      inFlightScan = null;
    });
  }
  const found = await inFlightScan;
  found.forEach((bulb) => bulbs.set(bulb.id, bulb));

  // Manual bulbs: ask each one who it is, since the scan never told us.
  for (const manual of config.bulbs) {
    try {
      const bulb = await probeBulb(manual.host, manual.port);
      // A bulb found BOTH ways must not appear twice; the probe wins because
      // its address is the one the user insisted on.
      bulbs.set(bulb.id, bulb);
    } catch (e) {
      logger.warn(`Yeelight bulb declared at ${manual.host} is unreachable: ${e.message}`);
    }
  }

  return [...bulbs.values()];
}

/**
 * Identify a bulb by connecting to it directly.
 *
 * Used for the hand-declared bulbs: discovery is what normally carries the id,
 * the model and the support list, so without it they must be read over the
 * control channel instead.
 * @param {string} host - The bulb address.
 * @param {number} [port] - The control port.
 * @returns {Promise<object>} The bulb descriptor.
 * @example
 * const bulb = await probeBulb('192.168.1.42');
 */
export async function probeBulb(host, port = DEFAULT_CONTROL_PORT) {
  const client = new YeelightClient({ host, port });
  try {
    await client.connect();
    // `get_prop` cannot return the id nor the support list, so the identity
    // comes from the properties that do exist, and the support list is inferred
    // from which of them the bulb actually knows about.
    // `model` and `fw_ver` ARE readable over the control channel, even though
    // the spec only documents them as discovery headers — which is what lets a
    // hand-declared bulb get the colour temperature range of its real model
    // instead of the generic fallback.
    const props = await client.getProps([
      'power',
      'bright',
      'ct',
      'rgb',
      'hue',
      'sat',
      'color_mode',
      'name',
      'model',
      'fw_ver',
      'bg_power',
      'bg_ct',
    ]);

    return {
      // No id available over the control channel: the address is the only
      // stable handle we have for such a bulb. Documented as the reason a
      // hand-declared bulb should get a DHCP reservation.
      id: `manual-${host.replace(/[^a-zA-Z0-9]/g, '-')}`,
      host,
      port,
      model: props.model || '',
      firmwareVersion: props.fw_ver || '',
      // Infer the capabilities from the properties the bulb reports: a bulb
      // answering `rgb` does colour, one answering `ct` does temperature.
      support: [
        'get_prop',
        'set_power',
        'toggle',
        props.bright !== undefined ? 'set_bright' : '',
        props.rgb !== undefined ? 'set_rgb' : '',
        props.ct !== undefined ? 'set_ct_abx' : '',
        // A bulb answering `bg_power` carries a background light.
        props.bg_power !== undefined ? 'bg_set_power' : '',
        props.bg_power !== undefined ? 'bg_set_bright' : '',
        props.bg_power !== undefined ? 'bg_set_rgb' : '',
        props.bg_ct !== undefined ? 'bg_set_ct_abx' : '',
      ]
        .filter(Boolean)
        .join(' '),
      name: props.name || '',
      state: props,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Build the Gladys devices of every discovered bulb.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The YeelightManager instance.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The Gladys devices, ready to publish.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, manager, config);
 */
export async function buildDiscoveredDevices(gladys, manager, config) {
  const bulbs = await discoverAllBulbs(gladys, config);
  const devices = [];

  for (const bulb of bulbs) {
    // Remember where the bulb lives even if we do not connect right now: a
    // command issued later needs an address, and so does a reconnection.
    manager.rememberAddress(bulb);

    const device = buildDevice(gladys, bulb);
    if (device.features.length === 0) {
      logger.info(`Yeelight bulb "${bulb.id}" exposes no usable feature`);
      continue;
    }
    devices.push(device);

    // Open the push channel. A failure here is not fatal: the device is still
    // published, and the manager retries in the background.
    try {
      await manager.connect(bulb);
    } catch (e) {
      logger.warn(`Yeelight bulb "${bulb.id}" (${bulb.host}) unreachable: ${e.message}`);
    }
  }

  logger.info(`Yeelight discovery: ${devices.length} device(s) built`);
  return devices;
}

/**
 * Build the Gladys device of one bulb.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} bulb - The discovered bulb.
 * @returns {object} The Gladys device.
 * @example
 * const device = buildDevice(gladys, bulb);
 */
export function buildDevice(gladys, bulb) {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, bulb.id);
  const name = deviceName(bulb);

  const descriptors = describeBulb(bulb);
  // A bulb with a background light needs its labels disambiguated
  // ("Main brightness" / "Ambient brightness"); a plain bulb does not.
  const hasAmbient = descriptors.some((descriptor) => String(descriptor.key).startsWith('bg_'));

  const features = descriptors.map((descriptor) => ({
    name: featureName(descriptor, { hasAmbient }),
    external_id: ids.feature(descriptor.key),
    category: descriptor.category,
    type: descriptor.type,
    read_only: descriptor.readOnly,
    keep_history: descriptor.keepHistory,
    has_feedback: true,
    min: descriptor.min,
    max: descriptor.max,
    ...(descriptor.unit ? { unit: descriptor.unit } : {}),
  }));

  return {
    name,
    external_id: ids.device,
    params: [
      // The address is a param, not part of the id: a DHCP lease changes, the
      // bulb id does not.
      { name: PARAM_ADDRESS, value: `${bulb.host}:${bulb.port || DEFAULT_CONTROL_PORT}` },
      { name: PARAM_MODEL, value: String(bulb.model || '') },
      { name: PARAM_FIRMWARE, value: String(bulb.firmwareVersion || '') },
      { name: PARAM_SUPPORT, value: String(bulb.support || '') },
    ],
    features,
  };
}

/**
 * Publish the states carried by a `props` notification.
 *
 * Only the devices the USER created are considered: a bulb discovered but never
 * added has no feature to publish to, and the core would reject the unknown
 * external id.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {string} bulbId - The bulb id.
 * @param {Record<string, string>} props - The properties the bulb reported.
 * @returns {Promise<void>} Resolves once published (no-op if nothing to send).
 * @example
 * await publishBulbState(gladys, '0x1', { power: 'on', bright: '40' });
 */
export async function publishBulbState(gladys, bulbId, props) {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, bulbId);
  const device = (gladys.devices || []).find((d) => d.external_id === ids.device);
  if (!device) {
    return;
  }

  const states = [];
  (device.features || []).forEach((feature) => {
    const key = featureKeyOf(gladys, feature.external_id, bulbId);
    if (!key) {
      return;
    }
    const value = readState({ key }, props);
    if (value === undefined || value === null) {
      return;
    }
    states.push({ device_feature_external_id: feature.external_id, state: value });
  });

  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}

/**
 * Read and publish the CURRENT state of every device the user created.
 *
 * A Yeelight only pushes a property when that property CHANGES, so a lamp that
 * is simply on says nothing when we connect to it — and says nothing about the
 * dimensions the user did not touch. Without an explicit read at startup the
 * dashboard stays empty until each feature happens to be moved once, which is
 * exactly what a freshly (re)created device looks like to the user.
 *
 * Failures are per-device and non-fatal: one unreachable lamp must not keep the
 * others from publishing their state.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The YeelightManager instance.
 * @returns {Promise<void>} Resolves once every reachable device is published.
 * @example
 * await refreshAllDevices(gladys, manager);
 */
export async function refreshAllDevices(gladys, manager) {
  const devices = gladys.devices || [];
  for (const device of devices) {
    try {
      await refreshDevice(gladys, manager, device);
    } catch (e) {
      logger.debug(`Initial state of "${device.external_id}" unavailable: ${e.message}`);
    }
  }
}

/**
 * Refresh a device by reading its properties over the control channel. Used by
 * `onPoll`, which is the safety net of the push model.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The YeelightManager instance.
 * @param {object} device - The Gladys device.
 * @returns {Promise<void>} Resolves once the state is published.
 * @example
 * await refreshDevice(gladys, manager, device);
 */
export async function refreshDevice(gladys, manager, device) {
  const bulbId = parseDeviceExternalId(gladys, device.external_id);

  const keys = (device.features || [])
    .map((feature) => featureKeyOf(gladys, feature.external_id, bulbId))
    .filter(Boolean);
  const names = propsForFeatures(keys.map((key) => ({ key })));
  if (names.length === 0) {
    return;
  }

  let client = manager.getClient(bulbId);
  if (!client) {
    // Restore the address from the device params: after a restart the manager
    // knows nothing, and a poll must not depend on a fresh scan.
    const address = (device.params || []).find((param) => param.name === PARAM_ADDRESS);
    if (!address) {
      return;
    }
    const [host, port] = String(address.value).split(':');
    client = await manager.connect({ id: bulbId, host, port: Number(port) });
  }

  const props = await client.getProps(names);
  await publishBulbState(gladys, bulbId, props);
}

/**
 * Apply a Gladys command on a bulb.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The YeelightManager instance.
 * @param {object} device - The Gladys device.
 * @param {object} feature - The Gladys feature being actioned.
 * @param {number} value - The requested value.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<void>} Resolves once the command is sent.
 * @example
 * await setDeviceValue(gladys, manager, device, feature, 1, config);
 */
export async function setDeviceValue(gladys, manager, device, feature, value, config) {
  const bulbId = parseDeviceExternalId(gladys, device.external_id);
  const key = featureKeyOf(gladys, feature.external_id, bulbId);
  if (!key) {
    throw new Error(`Yeelight feature external_id is invalid: "${feature.external_id}"`);
  }

  const command = buildCommand({ key, min: feature.min, max: feature.max }, value, {
    transitionMs: config.transition_duration,
  });
  if (!command) {
    throw new Error(`Yeelight: feature "${feature.external_id}" is not commandable`);
  }

  // Yeelight refuses colour, temperature and brightness while the bulb is off
  // (spec section 4.1). Powering it on first is what makes dragging a slider on
  // a light that is off do what the user meant, instead of silently failing.
  if (command.requiresPower) {
    await ensurePoweredOn(manager, bulbId, key, config);
  }

  logger.debug(`Yeelight command ${bulbId}: ${command.method} ${JSON.stringify(command.params)}`);
  await manager.command(bulbId, command.method, command.params);

  // Read back what the lamp actually did, and publish it.
  //
  // A Yeelight does not push a property it considers unchanged, and a power
  // command has SIDE EFFECTS the push channel never reports: switching the main
  // light also drives the ambient ring when the lamp is configured to follow it,
  // and `set_power` mode 5 (night light) moves the brightness. Relying on the
  // push alone left those features showing a value the lamp had already left —
  // the on/off button snapping back was this, not a lost command.
  //
  // Scoped to the power commands, and that scope is the whole point: they are
  // the ones with side effects nothing reports. A slider (colour, temperature,
  // brightness) only moves the property it names, and the bulb PUSHES that
  // property itself once the fade ends — reading it back spent a third command
  // per step to learn what the push was already carrying.
  if (movesOtherFeatures(key)) {
    await readBackState(gladys, manager, bulbId, key, config.transition_duration).catch((e) =>
      logger.debug(`Could not read back the state of "${bulbId}": ${e.message}`),
    );
  }
}

/**
 * Re-read the properties a command may have moved, and publish them.
 *
 * The scope is deliberately wider than the feature that was commanded: the one
 * case that matters is precisely the one where the lamp changed something the
 * user did not ask for.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The YeelightManager instance.
 * @param {string} bulbId - The bulb id.
 * @param {string} key - The feature key that was commanded.
 * @returns {Promise<void>} Resolves once the fresh state is published.
 */
async function readBackState(gladys, manager, bulbId, key, transitionMs = 0) {
  const client = manager.getClient(bulbId);
  if (!client) {
    return;
  }

  // A `smooth` command returns as soon as it is ACCEPTED, while the lamp is
  // still fading. Reading straight away would report the value it is leaving,
  // and publish the very state the user just changed.
  const fade = Number.isFinite(Number(transitionMs)) ? Number(transitionMs) : 0;
  const wait = Math.min(fade + READ_BACK_MARGIN_MS, READ_BACK_MAX_WAIT_MS);
  await new Promise((resolve) => setTimeout(resolve, wait));

  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, bulbId);
  const device = (gladys.devices || []).find((d) => d.external_id === ids.device);
  if (!device) {
    return;
  }

  const keys = (device.features || [])
    .map((feature) => featureKeyOf(gladys, feature.external_id, bulbId))
    .filter(Boolean);
  // A power command can move any other feature, so everything is re-read; a
  // colour or brightness command only ever moves its own light.
  const scope = movesOtherFeatures(key)
    ? keys
    : keys.filter((candidate) => candidate.startsWith('bg_') === key.startsWith('bg_'));

  const names = propsForFeatures(scope.map((candidate) => ({ key: candidate })));
  if (names.length === 0) {
    return;
  }

  const props = await client.getProps(names);
  await publishBulbState(gladys, bulbId, props);
}

/**
 * Whether a command can move features other than the one it names.
 *
 * The power family is what this exists for: switching the main light also drives
 * an ambient ring configured to follow it, and `set_power` mode 5 (night light)
 * moves the brightness. Those changes reach nobody otherwise — a Yeelight does
 * not push a property it considers unchanged.
 * @param {string} key - The feature key that was commanded.
 * @returns {boolean} True when the whole device state has to be re-read.
 */
function movesOtherFeatures(key) {
  return key === 'power' || key === 'bg_power' || key === 'night_light';
}

/**
 * Turn the bulb on when it is off, before a command that needs it.
 *
 * Reads the CURRENT power state rather than sending `set_power` blindly: an
 * unconditional power command would restart the fade of a lamp that is already
 * on, which is visible in the room.
 * @param {object} manager - The YeelightManager instance.
 * @param {string} bulbId - The bulb id.
 * @param {string} key - The feature key being commanded.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<void>} Resolves once the bulb is on.
 */
async function ensurePoweredOn(manager, bulbId, key, config) {
  // The background light has its own power state and its own command family.
  const isBackground = key.startsWith('bg_');
  const property = isBackground ? 'bg_power' : 'power';
  const method = isBackground ? 'bg_set_power' : 'set_power';

  try {
    const client = manager.getClient(bulbId);
    if (!client) {
      return false;
    }
    // Ask the bulb only when nothing has told us the state yet. The client
    // caches what the pushes, the read-backs and our own power commands report,
    // and dragging a slider used to spend one `get_prop` per step on a value
    // that had not moved — three commands per step against a 60/minute quota.
    const known = client.cached(property);
    const value = known === undefined ? (await client.getProps([property]))[property] : known;
    if (value === 'off') {
      await manager.command(bulbId, method, ['on', 'smooth', config.transition_duration]);
      return true;
    }
  } catch (e) {
    // Never block the real command on this: the bulb may simply not expose the
    // property, and the command below may well succeed anyway.
    logger.debug(`Could not check the power state of "${bulbId}": ${e.message}`);
  }
  return false;
}

/**
 * Extract the feature key from a feature external id.
 *
 * Shape: `ext:<selector>:yeelight:<bulbId>:<featureKey>`. Matching on the
 * device prefix rather than splitting on ':' is what keeps a bulb id containing
 * a colon from breaking the parse.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {string} externalId - The feature external id.
 * @param {string} bulbId - The bulb id the feature belongs to.
 * @returns {string|null} The feature key, or null when it does not match.
 * @example
 * featureKeyOf(gladys, 'ext:sel:yeelight:0x1:brightness', '0x1'); // 'brightness'
 */
export function featureKeyOf(gladys, externalId, bulbId) {
  const prefix = `${gladys.externalIds(EXTERNAL_ID_TYPE, bulbId).device}:`;
  const id = String(externalId);
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/**
 * Extract the bulb id from a DEVICE external id
 * (`ext:<selector>:yeelight:<bulbId>`).
 * @param {object} gladys - The Gladys SDK instance.
 * @param {string} externalId - The device external id.
 * @returns {string} The bulb id.
 * @example
 * parseDeviceExternalId(gladys, 'ext:sel:yeelight:0x1'); // '0x1'
 */
export function parseDeviceExternalId(gladys, externalId) {
  const prefix = `${gladys.externalId(EXTERNAL_ID_TYPE)}:`;
  if (!String(externalId).startsWith(prefix)) {
    throw new Error(`Yeelight device external_id is invalid: "${externalId}"`);
  }
  return String(externalId).slice(prefix.length);
}

/**
 * Publish the reachability of a bulb as a Gladys transport badge. Yeelight is a
 * local protocol, so a connected bulb is `local` and a dropped one
 * `unreachable`.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {string} bulbId - The bulb id.
 * @param {boolean} connected - Whether the bulb is connected.
 * @returns {Promise<void>} Resolves once published.
 * @example
 * await publishBulbTransport(gladys, '0x1', true);
 */
export async function publishBulbTransport(gladys, bulbId, connected) {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, bulbId);
  try {
    await gladys.publishTransports([
      {
        external_id: ids.device,
        transport: connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ]);
  } catch (e) {
    // Unknown external ids are ignored by Gladys, but a transient API error
    // must not take the connection callback down with it.
    logger.debug(`Publishing the transport of "${bulbId}" failed: ${e.message}`);
  }
}
