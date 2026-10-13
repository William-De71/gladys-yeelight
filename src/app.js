// -----------------------------------------------------------------------------
// Every handler of the Yeelight integration, wired on a Gladys SDK instance.
//
// index.js only builds the real SDK instance and connects; the tests build the
// SDK's fake Gladys (`@gladysassistant/integration-sdk/testing`) with a fake
// light manager and drive the very same handlers (test/app.test.js).
//
// Push model: Yeelight lights send their state changes over a connection kept
// open, so states reach Gladys from the manager's `onProps` callback, and
// `onPoll` only serves as a safety net for a light Gladys asks to refresh. The
// heartbeat of the manager is what notices a light cut at the wall switch.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { YeelightManager } from './yeelight/YeelightManager.js';
import { normalizeConfig } from './config.js';
import { MESSAGES, testOk, testFailed, reconnectOk, reconnectFailed } from './messages.js';
import {
  buildDiscoveredDevices,
  publishBulbState,
  publishBulbTransport,
  refreshAllDevices,
  refreshDevice,
  setDeviceValue,
} from './devices.js';
import { createSceneEvents } from './events.js';
import { registerSceneActions } from './scenes.js';

const logger = createLogger({ name: 'yeelight' });

/**
 * Register every handler on the SDK instance. Call it BEFORE `connect()`.
 * @param {object} gladys - The Gladys SDK instance (real or fake).
 * @param {object} [options] - Dependencies the tests replace.
 * @param {object} [options.manager] - The light manager (a YeelightManager by default).
 * @param {object} [options.sceneEvents] - Options of createSceneEvents (delay, clock).
 * @returns {object} `{ manager, publishDevices, shutdown }`.
 * @example
 * const app = createApp(new GladysIntegration());
 */
export function createApp(gladys, options = {}) {
  const manager = options.manager || new YeelightManager();
  const sceneEvents = createSceneEvents(gladys, options.sceneEvents);

  let config = normalizeConfig();

  // --- State push: a bulb reports a change -----------------------------------
  manager.onProps((bulbId, props) => {
    publishBulbState(gladys, bulbId, props).catch((e) => {
      logger.warn(`Publishing a state of "${bulbId}" failed: ${e.message}`);
      logger.debug(e);
    });
  });

  // --- Reachability: a bulb connects or drops --------------------------------
  manager.onConnectionChange((bulbId, connected) => {
    publishBulbTransport(gladys, bulbId, connected).catch(() => {});
    sceneEvents.connectionChange(bulbId, connected);
  });

  // --- Scene actions: light effects ------------------------------------------
  registerSceneActions(gladys, manager);

  /**
   * Refresh the configuration, discover the bulbs and publish them.
   * @returns {Promise<object[]>} The published devices.
   */
  async function publishDevices() {
    config = normalizeConfig(await gladys.getConfig());
    const devices = await buildDiscoveredDevices(gladys, manager, config);
    await gladys.publishDiscoveredDevices(devices);

    // Read the real state of the lamps the user already created. A Yeelight only
    // pushes a property when it CHANGES, so nothing at all would reach Gladys
    // until each feature happened to be moved once.
    await refreshAllDevices(gladys, manager).catch((e) =>
      logger.debug(`Initial state refresh failed: ${e.message}`),
    );

    if (devices.length > 0) {
      await gladys.setConnectionStatus(true).catch(() => {});
    } else {
      await gladys.setConnectionStatus(false, MESSAGES.noBulbFound).catch(() => {});
    }
    return devices;
  }

  // --- Discovery: the user asks for the list of devices ----------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> discovering the Yeelight bulbs');
    await publishDevices();
  });

  // --- Command: the user acts on a controllable feature ----------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await setDeviceValue(gladys, manager, device, feature, value, config);
  });

  // --- Polling: Gladys asks to refresh a device ------------------------------
  // Bulbs push their state, so this is only a safety net: it reconnects a bulb
  // whose session dropped and re-reads its properties.
  gladys.onPoll(async (device) => {
    await refreshDevice(gladys, manager, device);
  });

  // --- Device created by the user --------------------------------------------
  // `gladys.devices` is what publishBulbState looks a feature up in, and it is
  // only filled by getDevices(). A lamp created after startup would therefore
  // have every pushed state dropped until the next restart — so the list is
  // reloaded and the new device is given its current state right away.
  gladys.onDeviceCreated(async (device) => {
    logger.info(`onDeviceCreated -> ${device.external_id}`);
    await gladys.getDevices();
    await refreshDevice(gladys, manager, device).catch((e) =>
      logger.warn(`Initial state of "${device.external_id}" unavailable: ${e.message}`),
    );
  });

  // --- Device updated or deleted by the user ---------------------------------
  // Same reason: the cached list must not keep describing devices that changed.
  gladys.onDeviceUpdated(async () => {
    await gladys.getDevices();
  });

  gladys.onDeviceDeleted(async () => {
    await gladys.getDevices();
  });

  // --- Manifest action: test the connection ----------------------------------
  gladys.onAction('test_connection', async () => {
    try {
      const devices = await publishDevices();
      if (devices.length === 0) {
        return MESSAGES.testNoAnswer;
      }
      const featureCount = devices.reduce((total, device) => total + device.features.length, 0);
      return testOk(devices.length, featureCount);
    } catch (e) {
      logger.error('Yeelight connection test failed', e);
      return testFailed(e.message);
    }
  });

  // --- Manifest action: reconnect every bulb ---------------------------------
  gladys.onAction('reconnect', async () => {
    logger.info('Action reconnect -> closing every connection and reconnecting');
    try {
      await manager.disconnectAll();
      const devices = await publishDevices();
      return reconnectOk(devices.length);
    } catch (e) {
      logger.error('Yeelight reconnection failed', e);
      return reconnectFailed(e.message);
    }
  });

  // --- Configuration updated by the user -------------------------------------
  gladys.onConfigUpdated(async () => {
    logger.info('onConfigUpdated -> reconnecting with the new configuration');
    await manager.disconnectAll();
    await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
  });

  // --- Connection lifecycle --------------------------------------------------
  gladys.on('connected', async () => {
    try {
      // Load the devices the user created, so a pushed state finds its feature.
      await gladys.getDevices();
      await publishDevices();
      // A lamp cut at the wall keeps a half-open session: probe the silent ones.
      manager.startHeartbeat();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys.setConnectionStatus(false, MESSAGES.initFailed).catch(() => {});
    }
  });

  /**
   * Close every connection, freeing a slot on each light right away: a
   * Yeelight accepts only 4 simultaneous connections.
   * @returns {Promise<void>} Resolves once closed.
   */
  async function shutdown() {
    sceneEvents.stop();
    await manager.disconnectAll({ permanent: true });
  }

  return { manager, publishDevices, shutdown };
}
