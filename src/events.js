// -----------------------------------------------------------------------------
// Scene triggers: what HAPPENS to a light, as opposed to its state.
//
//   light_offline  a light the user created stayed unreachable for
//                  OFFLINE_GRACE_MS: cut at the wall switch, a power cut, a
//                  Wi-Fi problem;
//   light_online   that same light came back.
//
// One event per transition: a light that drops and is back within the grace
// period fires nothing, and `light_online` only follows a `light_offline` that
// was fired. A light never seen online in this process has no transition to
// report. Data is flat and limited to the declared variables. No event is ever
// fired by a scene action (an effect changes states, never the reachability).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, PARAM_ADDRESS } from './yeelight/constants.js';

const logger = createLogger({ name: 'yeelight-events' });

export const SCENE_TRIGGERS = {
  LIGHT_OFFLINE: 'light_offline',
  LIGHT_ONLINE: 'light_online',
};

// Long enough for a light switched off and on again at the wall, which reboots
// and reconnects within seconds.
export const OFFLINE_GRACE_MS = 30 * 1000;

/**
 * Create the scene event source of the integration.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} [options] - Options (the tests shorten the delay).
 * @param {number} [options.graceMs] - How long a light stays down before `light_offline`.
 * @param {() => number} [options.now] - Clock.
 * @returns {object} `{ connectionChange, stop }`.
 * @example
 * const events = createSceneEvents(gladys);
 * events.connectionChange('0x1', false);
 */
export function createSceneEvents(gladys, options = {}) {
  const graceMs = options.graceMs ?? OFFLINE_GRACE_MS;
  const now = options.now || Date.now;

  /** Lights seen connected in this process. */
  const seenOnline = new Set();
  /** Lights whose `light_offline` was fired, with the time they went down. */
  const reportedOffline = new Map();
  /** Grace timers of the lights currently down. */
  const offlineTimers = new Map();

  /**
   * The event data of a light, or null when the user did not create it.
   * @param {string} bulbId - The bulb id.
   * @returns {object|null} `{ light, name, address }`.
   */
  function describe(bulbId) {
    const externalId = gladys.externalIds(EXTERNAL_ID_TYPE, bulbId).device;
    const device = (gladys.devices || []).find((entry) => entry.external_id === externalId);
    if (!device) {
      return null;
    }
    const address = (device.params || []).find((param) => param.name === PARAM_ADDRESS);
    return { light: externalId, name: device.name, address: address ? address.value : '' };
  }

  /**
   * Fire one scene event, never throwing: a refused event (rate limit, Gladys
   * restarting) must not break the connection flow that called it.
   * @param {string} key - The trigger key.
   * @param {object} data - The flat event data.
   * @returns {Promise<void>} Resolves once sent or logged.
   */
  async function fire(key, data) {
    try {
      await gladys.publishSceneEvent(key, data);
      logger.debug(`Scene event ${key} sent: ${JSON.stringify(data)}`);
    } catch (e) {
      logger.warn(`Scene event ${key} refused: ${e.message}`);
    }
  }

  return {
    /**
     * A light connected or disconnected.
     * @param {string} bulbId - The bulb id.
     * @param {boolean} connected - Whether it is connected now.
     * @returns {void}
     */
    connectionChange(bulbId, connected) {
      if (connected) {
        seenOnline.add(bulbId);
        clearTimeout(offlineTimers.get(bulbId));
        offlineTimers.delete(bulbId);
        const since = reportedOffline.get(bulbId);
        if (since !== undefined) {
          reportedOffline.delete(bulbId);
          const data = describe(bulbId);
          if (data) {
            fire(SCENE_TRIGGERS.LIGHT_ONLINE, {
              ...data,
              offline_minutes: Math.round((now() - since) / 60000),
            });
          }
        }
        return;
      }
      if (!seenOnline.has(bulbId) || offlineTimers.has(bulbId) || reportedOffline.has(bulbId)) {
        return;
      }
      const downSince = now();
      const timer = setTimeout(() => {
        offlineTimers.delete(bulbId);
        const data = describe(bulbId);
        if (!data) {
          return;
        }
        reportedOffline.set(bulbId, downSince);
        fire(SCENE_TRIGGERS.LIGHT_OFFLINE, data);
      }, graceMs);
      // Never a reason to hold the process open.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      offlineTimers.set(bulbId, timer);
    },

    /**
     * Cancel the pending grace timers (shutdown).
     * @returns {void}
     */
    stop() {
      offlineTimers.forEach((timer) => clearTimeout(timer));
      offlineTimers.clear();
    },
  };
}
