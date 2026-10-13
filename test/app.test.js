// -----------------------------------------------------------------------------
// The handlers of src/app.js, driven by the fake Gladys of the SDK: the real
// GladysIntegration with an in-memory Gladys, so the payloads are checked the
// way the core checks them. The lights are a fake manager; nothing touches the
// network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp } from '../src/app.js';
import { discoveryPayload } from './helpers/fakeGladys.js';

const BULB_ID = '0x000000000015243f';
const DEVICE_ID = `ext:ext-yeelight:yeelight:${BULB_ID}`;

/**
 * A stand-in for the YeelightManager: one colour light at 192.168.1.239 that
 * answers every command and reports the properties it was given.
 */
export class FakeManager {
  constructor() {
    this.addresses = new Map();
    this.commands = [];
    this.props = { power: 'on', bright: '40', color_mode: '2', ct: '4000', rgb: '16711680' };
    this.client = {
      connected: true,
      cached: (name) => this.props[name],
      getProps: async (names) => Object.fromEntries(names.map((name) => [name, this.props[name]])),
    };
    this.heartbeat = false;
  }

  onProps(callback) {
    this.propsCallback = callback;
  }

  onConnectionChange(callback) {
    this.connectionCallback = callback;
  }

  rememberAddress(bulb, { ifUnknown = false } = {}) {
    if (!ifUnknown || !this.addresses.has(bulb.id)) {
      this.addresses.set(bulb.id, { host: bulb.host, port: bulb.port || 55443 });
    }
  }

  async connect(bulb) {
    this.rememberAddress(bulb);
    this.connectionCallback(bulb.id, true);
    return this.client;
  }

  getClient() {
    return this.client;
  }

  async ensureClient() {
    return this.client;
  }

  async command(bulbId, method, params) {
    this.commands.push({ bulbId, method, params });
    return ['ok'];
  }

  startHeartbeat() {
    this.heartbeat = true;
  }

  async disconnectAll() {}

  /** The light pushes a change, as the real manager would relay it. */
  push(props) {
    Object.assign(this.props, props);
    this.propsCallback(BULB_ID, props);
  }

  /** The light drops or comes back. */
  drop() {
    this.connectionCallback(BULB_ID, false);
  }

  back() {
    this.connectionCallback(BULB_ID, true);
  }
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A connected fake Gladys running the integration, its light found by the scan.
 * @param {object} [options] - `devices` the user created, `appOptions`.
 * @returns {Promise<{ gladys: object, manager: FakeManager, app: object }>} The parts.
 */
export async function start({ devices = [], appOptions = {} } = {}) {
  const gladys = createFakeGladys({
    selector: 'ext-yeelight',
    devices,
    config: { scan_duration: 3, transition_duration: 0 },
    scanResults: { 'udp-active-broadcast': [{ payload_base64: discoveryPayload() }] },
  });
  const manager = new FakeManager();
  const app = createApp(gladys, { manager, ...appOptions });
  await gladys.connect();
  await settle();
  return { gladys, manager, app };
}

/**
 * The device the discovery published, as the user would create it.
 * @param {object} gladys - The fake Gladys.
 * @returns {object} The created device.
 */
export function createdDevice(gladys) {
  const [device] = gladys.fake.discoveredDevices;
  return { ...device, id: 'device-1', selector: 'yeelight-salon' };
}

test('the light found by the scan is published, and the integration reports itself connected', async () => {
  const { gladys, manager, app } = await start();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE_ID);
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['power', 'brightness', 'color', 'temperature'],
  );
  assert.equal(gladys.fake.scans[0].type, 'udp-active-broadcast');
  assert.equal(gladys.fake.scans[0].port, 1982);
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.ok(manager.heartbeat, 'the heartbeat runs once connected');
  await app.shutdown();
});

test('a device created by the user receives the current state of the light', async () => {
  const { gladys, app } = await start();
  await gladys.fake.deviceCreated(createdDevice(gladys));
  await settle();
  assert.equal(gladys.fake.lastState(`${DEVICE_ID}:power`), 1);
  assert.equal(gladys.fake.lastState(`${DEVICE_ID}:brightness`), 40);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE_ID,
    transport: 'local',
  });
  await app.shutdown();
});

test('a pushed change reaches the created device', async () => {
  const { gladys, manager, app } = await start();
  await gladys.fake.deviceCreated(createdDevice(gladys));
  manager.push({ bright: '75' });
  await settle();
  assert.equal(gladys.fake.lastState(`${DEVICE_ID}:brightness`), 75);
  await app.shutdown();
});

test('a command from Gladys reaches the light', async () => {
  const { gladys, manager, app } = await start();
  const device = createdDevice(gladys);
  await gladys.fake.deviceCreated(device);
  const brightness = device.features.find((feature) => feature.external_id.endsWith(':brightness'));
  const ack = await gladys.fake.setValue(device, brightness, 30);
  assert.equal(ack.success, true);
  assert.deepEqual(manager.commands.at(-1), {
    bulbId: BULB_ID,
    method: 'set_bright',
    // The spec sets a 30 ms floor on the duration, even for a sudden change.
    params: [30, 'sudden', 30],
  });
  await app.shutdown();
});

test('a light that drops is shown unreachable', async () => {
  const { gladys, manager, app } = await start();
  await gladys.fake.deviceCreated(createdDevice(gladys));
  manager.drop();
  await settle();
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE_ID,
    transport: 'unreachable',
  });
  await app.shutdown();
});

test('the connection test reports the lights found, in four languages', async () => {
  const { gladys, app } = await start();
  const ack = await gladys.fake.action('test_connection');
  assert.equal(ack.success, true);
  assert.deepEqual(Object.keys(ack.data.message).sort(), ['de', 'en', 'es', 'fr']);
  assert.match(ack.data.message.en, /1/);
  await app.shutdown();
});
