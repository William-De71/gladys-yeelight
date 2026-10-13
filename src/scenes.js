// -----------------------------------------------------------------------------
// Scene actions: operations a scene runs on a light, beyond its features.
//
//   start_effect  play a light effect (sunrise, sunset, alert, notify, candle),
//                 built by src/yeelight/effects.js;
//   stop_effect   stop the effect in progress, the light keeps its current
//                 colour.
//
// The `light` field is a select of the devices of the integration: its value is
// the device external id. Both actions are idempotent (no queue, no retry): a
// scene that runs twice plays the effect twice.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { effectScene, EFFECTS } from './yeelight/effects.js';
import { parseSupport, supportsColor, temperatureRange } from './yeelight/models.js';
import { parseDeviceExternalId, rememberDeviceAddress } from './devices.js';
import { PARAM_MODEL, PARAM_SUPPORT } from './yeelight/constants.js';

const logger = createLogger({ name: 'yeelight-scenes' });

export const SCENE_ACTIONS = {
  START_EFFECT: 'start_effect',
  STOP_EFFECT: 'stop_effect',
};

/**
 * Find the created device a scene field points to, and make its light reachable.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The light manager.
 * @param {string} externalId - The `light` field: a device external id.
 * @returns {{ bulbId: string, device: object }} The light.
 */
function resolveLight(gladys, manager, externalId) {
  if (typeof externalId !== 'string' || !externalId) {
    throw new Error('Choose a Yeelight light.');
  }
  const device = (gladys.devices || []).find((entry) => entry.external_id === externalId);
  if (!device) {
    throw new Error(`The light "${externalId}" is not a device of this integration.`);
  }
  const bulbId = parseDeviceExternalId(gladys, externalId);
  rememberDeviceAddress(manager, bulbId, device);
  return { bulbId, device };
}

/**
 * The value of one param of a device.
 * @param {object} device - The Gladys device.
 * @param {string} name - The param name.
 * @returns {string} Its value, or an empty string.
 */
function paramOf(device, name) {
  const param = (device.params || []).find((entry) => entry.name === name);
  return param ? String(param.value || '') : '';
}

/**
 * Register the scene action handlers.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} manager - The light manager.
 * @returns {void}
 * @example
 * registerSceneActions(gladys, manager);
 */
export function registerSceneActions(gladys, manager) {
  gladys.onSceneAction(SCENE_ACTIONS.START_EFFECT, async (fields) => {
    const { bulbId, device } = resolveLight(gladys, manager, fields.light);
    const effect = String(fields.effect || '');
    if (!EFFECTS.includes(effect)) {
      throw new Error(`Unknown effect "${effect}" (expected one of ${EFFECTS.join(', ')}).`);
    }
    const support = parseSupport(paramOf(device, PARAM_SUPPORT));
    // A light added by hand carries a support list inferred from its
    // properties, which never lists `set_scene`: only a scanned light's own
    // list can rule it out.
    if (support.has('get_prop') && !support.has('set_scene') && !bulbId.startsWith('manual-')) {
      throw new Error(`The light "${device.name}" does not support effects.`);
    }

    const client = await manager.ensureClient(bulbId);
    const known = client.cached('power');
    const power = known === undefined ? (await client.getProps(['power'])).power : known;
    const params = effectScene(effect, {
      color: supportsColor(support),
      kelvin: temperatureRange(paramOf(device, PARAM_MODEL)),
      minutes: fields.duration_minutes,
      wasOn: power !== 'off',
    });
    logger.info(`Scene: effect "${effect}" on "${device.name}"`);
    await manager.command(bulbId, 'set_scene', params);
    return { light_name: device.name };
  });

  gladys.onSceneAction(SCENE_ACTIONS.STOP_EFFECT, async (fields) => {
    const { bulbId, device } = resolveLight(gladys, manager, fields.light);
    logger.info(`Scene: stop the effect of "${device.name}"`);
    await manager.command(bulbId, 'stop_cf', []);
    return { light_name: device.name };
  });
}
