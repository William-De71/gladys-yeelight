import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevice,
  publishBulbState,
  setDeviceValue,
  featureKeyOf,
  parseDeviceExternalId,
  publishBulbTransport,
  refreshAllDevices,
} from '../src/devices.js';
import { fakeGladys } from './helpers/fakeGladys.js';
import { FEATURE_KEYS } from '../src/yeelight/convert.js';
import { normalizeConfig } from '../src/config.js';

const BULB = {
  id: '0x000000000015243f',
  host: '192.168.1.239',
  port: 55443,
  model: 'color',
  firmwareVersion: '18',
  support: 'get_prop set_power toggle set_bright set_rgb set_ct_abx',
  name: 'Living room',
};

/**
 * Build a fake manager recording the commands it is asked to send.
 * @param {object} [props] - Properties the fake client reports.
 * @returns {object} The fake manager, with a `commands` log.
 */
function fakeManager(props = {}, cachedProps = {}) {
  const commands = [];
  return {
    commands,
    addresses: [],
    rememberAddress(bulb) {
      this.addresses.push(bulb);
    },
    getClient: () => ({
      getProps: async (names) => {
        const result = {};
        names.forEach((name) => {
          if (props[name] !== undefined) {
            result[name] = props[name];
          }
        });
        return result;
      },
      // Nothing cached by default, so the callers fall back to `getProps` and
      // the tests keep exercising the querying path. `cachedProps` is what the
      // tests that DO care about the cache set.
      cached: (name) => cachedProps[name],
    }),
    command: async (bulbId, method, params) => {
      commands.push({ bulbId, method, params });
      return ['ok'];
    },
    connect: async () => ({}),
  };
}

test('a device carries one feature per supported dimension', () => {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);

  assert.equal(device.name, 'Living room');
  assert.equal(device.external_id, `ext:ext-dev-yeelight:yeelight:${BULB.id}`);
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    [FEATURE_KEYS.POWER, FEATURE_KEYS.BRIGHTNESS, FEATURE_KEYS.COLOR, FEATURE_KEYS.TEMPERATURE],
  );
});

test('the address lives in a param, never in the external id', () => {
  // A DHCP lease changes; the bulb id does not. Putting the address in the id
  // would create a duplicate device on every lease renewal.
  const device = buildDevice(fakeGladys(), BULB);
  assert.ok(!device.external_id.includes('192.168.1.239'));
  const address = device.params.find((param) => param.name === 'ADDRESS');
  assert.equal(address.value, '192.168.1.239:55443');
});

test('states are published only for the features the user actually created', async () => {
  // A discovered-but-not-added bulb has no feature to publish to, and the core
  // would reject the unknown external id.
  const gladys = fakeGladys({ devices: [] });
  await publishBulbState(gladys, BULB.id, { power: 'on', bright: '40' });
  assert.equal(gladys.published.states.length, 0);
});

test('a pushed notification becomes the matching Gladys states', async () => {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);
  gladys.devices = [device];

  await publishBulbState(gladys, BULB.id, { power: 'on', bright: '40', color_mode: '2' });

  const states = gladys.published.states;
  assert.equal(states.length, 2, 'power and brightness, but not the stale colour');
  assert.deepEqual(
    states.map((state) => state.state),
    [1, 40],
  );
});

test('a partial notification publishes only what it carries', async () => {
  // Bulbs push just what changed; the untouched features must keep their value.
  const gladys = fakeGladys();
  gladys.devices = [buildDevice(gladys, BULB)];

  await publishBulbState(gladys, BULB.id, { bright: '15' });

  assert.equal(gladys.published.states.length, 1);
  assert.equal(gladys.published.states[0].state, 15);
});

test('a command reaches the bulb as the right Yeelight method', async () => {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);
  const manager = fakeManager({ power: 'on' });
  const power = device.features.find((feature) => feature.external_id.endsWith(FEATURE_KEYS.POWER));

  await setDeviceValue(gladys, manager, device, power, 1, normalizeConfig());

  assert.deepEqual(manager.commands, [
    { bulbId: BULB.id, method: 'set_power', params: ['on', 'smooth', 500] },
  ]);
});

test('a colour set on a light that is off turns it on first', async () => {
  // The bulb refuses `set_rgb` while off, so without this the click would do
  // nothing at all.
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);
  const manager = fakeManager({ power: 'off' });
  const color = device.features.find((feature) => feature.external_id.endsWith(FEATURE_KEYS.COLOR));

  await setDeviceValue(gladys, manager, device, color, 16711680, normalizeConfig());

  assert.deepEqual(
    manager.commands.map((command) => command.method),
    ['set_power', 'set_rgb'],
  );
});

test('a colour set on a light already on does not restart its fade', async () => {
  // An unconditional power command would be visible in the room.
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);
  const manager = fakeManager({ power: 'on' });
  const color = device.features.find((feature) => feature.external_id.endsWith(FEATURE_KEYS.COLOR));

  await setDeviceValue(gladys, manager, device, color, 16711680, normalizeConfig());

  assert.deepEqual(
    manager.commands.map((command) => command.method),
    ['set_rgb'],
  );
});

test('the configured transition duration is applied to the commands', async () => {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);
  const manager = fakeManager({ power: 'on' });
  const power = device.features.find((feature) => feature.external_id.endsWith(FEATURE_KEYS.POWER));

  await setDeviceValue(
    gladys,
    manager,
    device,
    power,
    1,
    normalizeConfig({ transition_duration: 1200 }),
  );

  assert.deepEqual(manager.commands[0].params, ['on', 'smooth', 1200]);
});

test('external ids round-trip back to their bulb id and feature key', () => {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, BULB);

  assert.equal(parseDeviceExternalId(gladys, device.external_id), BULB.id);
  assert.equal(
    featureKeyOf(gladys, device.features[1].external_id, BULB.id),
    FEATURE_KEYS.BRIGHTNESS,
  );
  // A feature belonging to another bulb must not match.
  assert.equal(featureKeyOf(gladys, device.features[1].external_id, '0xOTHER'), null);
});

test('an external id from another integration is rejected', () => {
  const gladys = fakeGladys();
  assert.throws(() => parseDeviceExternalId(gladys, 'ext:other:zwave:3'), /invalid/);
});

test('reachability is published as a transport badge', async () => {
  const gladys = fakeGladys();
  await publishBulbTransport(gladys, BULB.id, true);
  await publishBulbTransport(gladys, BULB.id, false);

  assert.deepEqual(
    gladys.published.transports.map((transport) => transport.transport),
    ['local', 'unreachable'],
  );
});

test('a command publishes the state the lamp actually landed on', async () => {
  // A Yeelight does not push a property it considers unchanged, and a power
  // command has side effects the push channel never reports (the ambient ring
  // following the main light, night light moving the brightness). Reading back
  // is what keeps the on/off button from snapping back to its old value.
  const device = buildDevice(fakeGladys(), BULB);
  const gladys = fakeGladys({ devices: [device] });
  const manager = fakeManager({ power: 'on', bright: '42', ct: '4000', color_mode: '2' });
  const feature = device.features.find((f) => f.external_id.endsWith(FEATURE_KEYS.POWER));

  await setDeviceValue(gladys, manager, device, feature, 1, normalizeConfig());

  assert.equal(manager.commands[0].method, 'set_power');
  const power = gladys.published.states.find((state) =>
    state.device_feature_external_id.endsWith(FEATURE_KEYS.POWER),
  );
  assert.equal(power.state, 1);
  const brightness = gladys.published.states.find((state) =>
    state.device_feature_external_id.endsWith(FEATURE_KEYS.BRIGHTNESS),
  );
  assert.equal(brightness.state, 42, 'a power command re-reads the whole lamp');
});

test('a slider costs one single command against the quota', async () => {
  // The bulb allows 60 commands a minute per connection and enforces it by
  // going silent. A slider used to spend three per step — a `get_prop` for the
  // power state, the setter, then a read-back — so about 18 moves a minute
  // saturated it and the logs filled with "Command quota reached".
  const device = buildDevice(fakeGladys(), BULB);
  const gladys = fakeGladys({ devices: [device] });
  // The lamp is known to be on, so no power query and no power-on are needed.
  const manager = fakeManager({ power: 'on' }, { power: 'on' });
  const feature = device.features.find((f) => f.external_id.endsWith(FEATURE_KEYS.TEMPERATURE));

  await setDeviceValue(gladys, manager, device, feature, 250, normalizeConfig());

  assert.deepEqual(
    manager.commands.map((command) => command.method),
    ['set_ct_abx'],
  );
});

test('a slider still powers on a lamp the cache knows to be off', async () => {
  // The saving must not cost the power-on: a cached 'off' is as good a reason
  // to switch the lamp on as a queried one.
  const device = buildDevice(fakeGladys(), BULB);
  const gladys = fakeGladys({ devices: [device] });
  const manager = fakeManager({ power: 'off' }, { power: 'off' });
  const feature = device.features.find((f) => f.external_id.endsWith(FEATURE_KEYS.TEMPERATURE));

  await setDeviceValue(gladys, manager, device, feature, 250, normalizeConfig());

  assert.deepEqual(
    manager.commands.map((command) => command.method),
    ['set_power', 'set_ct_abx'],
  );
});

test('the state of the created devices is published without waiting for a push', async () => {
  // The bug users saw after (re)adding a lamp: it is physically on, but every
  // feature stays empty in Gladys until that feature happens to be moved once,
  // because a bulb only ever pushes what CHANGES.
  const device = buildDevice(fakeGladys(), BULB);
  const gladys = fakeGladys({ devices: [device] });
  const manager = fakeManager({ power: 'on', bright: '80', ct: '4000', color_mode: '2' });

  await refreshAllDevices(gladys, manager);

  const published = gladys.published.states.map((state) => [
    state.device_feature_external_id.split(':').pop(),
    state.state,
  ]);
  assert.deepEqual(published.sort(), [
    [FEATURE_KEYS.BRIGHTNESS, 80],
    [FEATURE_KEYS.POWER, 1],
    [FEATURE_KEYS.TEMPERATURE, 250],
  ]);
});

test('one unreachable lamp does not stop the others from publishing', async () => {
  const device = buildDevice(fakeGladys(), BULB);
  const gladys = fakeGladys({ devices: [device] });
  const manager = fakeManager();
  manager.getClient = () => ({
    getProps: async () => {
      throw new Error('bulb is unplugged');
    },
  });
  manager.connect = async () => {
    throw new Error('bulb is unplugged');
  };

  await refreshAllDevices(gladys, manager);
  assert.deepEqual(gladys.published.states, []);
});
