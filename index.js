// -----------------------------------------------------------------------------
// Entry point of the Yeelight external integration.
//
// Role of this file: wire the Gladys SDK to the connection manager and the
// device orchestration (src/devices.js). It:
//   1. instantiates the SDK (connection, auth, reconnection handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. exposes the manifest actions (test / reconnect);
//   4. discovers the bulbs and publishes them once connected.
//
// Push model: Yeelight bulbs send their state changes over a connection kept
// open, so states reach Gladys from the manager's `onProps` callback, and
// `onPoll` only serves as a safety net for a bulb Gladys asks to refresh.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { YeelightManager } from './src/yeelight/YeelightManager.js';
import { normalizeConfig } from './src/config.js';
import {
  buildDiscoveredDevices,
  publishBulbState,
  publishBulbTransport,
  refreshAllDevices,
  refreshDevice,
  setDeviceValue,
} from './src/devices.js';

const gladys = new GladysIntegration();
const manager = new YeelightManager();

let config = normalizeConfig();

// --- State push: a bulb reports a change -------------------------------------
manager.onProps((bulbId, props) => {
  publishBulbState(gladys, bulbId, props).catch((e) => {
    logger.warn(`Publishing a state of "${bulbId}" failed: ${e.message}`);
    logger.debug(e);
  });
});

// --- Reachability: a bulb connects or drops ----------------------------------
manager.onConnectionChange((bulbId, connected) => {
  publishBulbTransport(gladys, bulbId, connected).catch(() => {});
});

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
    await gladys
      .setConnectionStatus(false, {
        en: 'No Yeelight bulb found. Check that "LAN Control" is enabled in the Yeelight app.',
        fr: "Aucune ampoule Yeelight trouvée. Vérifiez que « Contrôle LAN » est activé dans l'application Yeelight.",
      })
      .catch(() => {});
  }
  return devices;
}

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> discovering the Yeelight bulbs');
  await publishDevices();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  await setDeviceValue(gladys, manager, device, feature, value, config);
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Bulbs push their state, so this is only a safety net: it reconnects a bulb
// whose session dropped and re-reads its properties.
gladys.onPoll(async (device) => {
  await refreshDevice(gladys, manager, device);
});

// --- Device created by the user ----------------------------------------------
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

// --- Device updated or deleted by the user -----------------------------------
// Same reason: the cached list must not keep describing devices that changed.
gladys.onDeviceUpdated(async () => {
  await gladys.getDevices();
});

gladys.onDeviceDeleted(async () => {
  await gladys.getDevices();
});

// --- Manifest action: test the connection ------------------------------------
gladys.onAction('test_connection', async () => {
  try {
    const devices = await publishDevices();
    if (devices.length === 0) {
      return {
        en: 'No Yeelight bulb answered. Check that they are powered on and that "LAN Control" is enabled in the Yeelight app.',
        fr: "Aucune ampoule Yeelight n'a répondu. Vérifiez qu'elles sont allumées et que « Contrôle LAN » est activé dans l'application Yeelight.",
      };
    }
    const featureCount = devices.reduce((total, device) => total + device.features.length, 0);
    return {
      en: `Connection OK: ${devices.length} bulb(s), ${featureCount} feature(s) available.`,
      fr: `Connexion OK : ${devices.length} ampoule(s), ${featureCount} fonctionnalité(s) disponible(s).`,
    };
  } catch (e) {
    logger.error('Yeelight connection test failed', e);
    return {
      en: `Connection failed: ${e.message}`,
      fr: `Échec de la connexion : ${e.message}`,
    };
  }
});

// --- Manifest action: reconnect every bulb -----------------------------------
gladys.onAction('reconnect', async () => {
  logger.info('Action reconnect -> closing every connection and reconnecting');
  try {
    await manager.disconnectAll();
    const devices = await publishDevices();
    return {
      en: `Reconnected: ${devices.length} bulb(s) available.`,
      fr: `Reconnexion effectuée : ${devices.length} ampoule(s) disponible(s).`,
    };
  } catch (e) {
    logger.error('Yeelight reconnection failed', e);
    return {
      en: `Reconnection failed: ${e.message}`,
      fr: `Échec de la reconnexion : ${e.message}`,
    };
  }
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async () => {
  logger.info('onConfigUpdated -> reconnecting with the new configuration');
  await manager.disconnectAll();
  await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // Load the devices the user created, so a pushed state finds its feature.
    await gladys.getDevices();
    await publishDevices();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  // Closing cleanly frees a connection slot on each bulb right away: a Yeelight
  // accepts only 4 simultaneous connections.
  await manager.disconnectAll({ permanent: true });
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Yeelight integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
