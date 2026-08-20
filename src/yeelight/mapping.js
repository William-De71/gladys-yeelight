// -----------------------------------------------------------------------------
// Yeelight bulb -> Gladys feature mapping.
//
// A Yeelight is always a LIGHT, so there is no category table to maintain here.
// What varies is which DIMENSIONS a given model exposes, and that is read from
// the `support` header the bulb itself advertises rather than from a hardcoded
// product list — so a model released after this code was written still gets
// exactly the features its firmware implements (see models.js).
//
// Pure module: no client, no SDK instance, no I/O.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS, LIGHT_TYPES } from './convert.js';
import { BRIGHTNESS_MIN, BRIGHTNESS_MAX, RGB_MIN, RGB_MAX } from './constants.js';
import {
  parseSupport,
  temperatureRange,
  supportsBrightness,
  supportsColor,
  supportsTemperature,
  supportsBackgroundLight,
  supportsNightLight,
} from './models.js';

/**
 * Build the Gladys feature descriptors of one bulb.
 *
 * The on/off feature is unconditional: a bulb that cannot be switched is not a
 * bulb. Everything else is gated on what the firmware advertises.
 * @param {object} bulb - The discovered bulb (`model`, `support`…).
 * @returns {object[]} The feature descriptors.
 * @example
 * describeBulb({ model: 'color', support: 'set_power set_bright set_rgb' });
 */
export function describeBulb(bulb) {
  const support = parseSupport(bulb.support);
  const features = [];

  features.push({
    key: FEATURE_KEYS.POWER,
    category: DEVICE_FEATURE_CATEGORIES.LIGHT,
    type: LIGHT_TYPES.BINARY,
    readOnly: false,
    keepHistory: true,
    min: 0,
    max: 1,
  });

  if (supportsBrightness(support)) {
    features.push({
      key: FEATURE_KEYS.BRIGHTNESS,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.BRIGHTNESS,
      readOnly: false,
      keepHistory: true,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      // The floor is 1, not 0: Yeelight has no 0% brightness (see convert.js).
      min: BRIGHTNESS_MIN,
      max: BRIGHTNESS_MAX,
    });
  }

  if (supportsColor(support)) {
    features.push({
      key: FEATURE_KEYS.COLOR,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.COLOR,
      readOnly: false,
      keepHistory: true,
      // Both sides store a colour as a single 0xRRGGBB integer.
      min: RGB_MIN,
      max: RGB_MAX,
    });
  }

  if (supportsTemperature(support)) {
    const range = temperatureRange(bulb.model);
    features.push({
      key: FEATURE_KEYS.TEMPERATURE,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.TEMPERATURE,
      readOnly: false,
      keepHistory: true,
      // Kelvin, the unit Yeelight speaks natively. The Gladys slider is driven
      // by these bounds, so no mired round-trip is needed.
      unit: DEVICE_FEATURE_UNITS.KELVIN,
      min: range.min,
      max: range.max,
    });
  }

  // Ambient/background light of the ceiling lights and screen bars, driven by
  // the parallel `bg_*` method family.
  if (supportsBackgroundLight(support)) {
    features.push({
      key: FEATURE_KEYS.BACKGROUND_POWER,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.BINARY,
      readOnly: false,
      keepHistory: true,
      min: 0,
      max: 1,
    });
    if (support.has('bg_set_bright')) {
      features.push({
        key: FEATURE_KEYS.BACKGROUND_BRIGHTNESS,
        category: DEVICE_FEATURE_CATEGORIES.LIGHT,
        type: LIGHT_TYPES.BRIGHTNESS,
        readOnly: false,
        keepHistory: true,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: BRIGHTNESS_MIN,
        max: BRIGHTNESS_MAX,
      });
    }
    if (support.has('bg_set_rgb')) {
      features.push({
        key: FEATURE_KEYS.BACKGROUND_COLOR,
        category: DEVICE_FEATURE_CATEGORIES.LIGHT,
        type: LIGHT_TYPES.COLOR,
        readOnly: false,
        keepHistory: true,
        min: RGB_MIN,
        max: RGB_MAX,
      });
    }
  }

  // Moonlight mode, ceiling lights only.
  if (supportsNightLight(bulb.model, support)) {
    features.push({
      key: FEATURE_KEYS.NIGHT_LIGHT,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.BINARY,
      readOnly: false,
      keepHistory: true,
      min: 0,
      max: 1,
    });
  }

  return features;
}

// Human-readable suffix per feature key, appended to the bulb name so a device
// carrying five features stays readable in the Gladys UI.
const FEATURE_LABELS = {
  [FEATURE_KEYS.POWER]: 'on/off',
  [FEATURE_KEYS.BRIGHTNESS]: 'brightness',
  [FEATURE_KEYS.COLOR]: 'color',
  [FEATURE_KEYS.TEMPERATURE]: 'color temperature',
  [FEATURE_KEYS.BACKGROUND_POWER]: 'ambient light',
  [FEATURE_KEYS.BACKGROUND_BRIGHTNESS]: 'ambient brightness',
  [FEATURE_KEYS.BACKGROUND_COLOR]: 'ambient color',
  [FEATURE_KEYS.NIGHT_LIGHT]: 'night light',
};

/**
 * Build the display name of one feature.
 * @param {string} bulbName - The device name.
 * @param {object} descriptor - The feature descriptor.
 * @returns {string} The feature name.
 * @example
 * featureName('Living room', { key: 'brightness' }); // 'Living room - brightness'
 */
export function featureName(bulbName, descriptor) {
  const label = FEATURE_LABELS[descriptor.key] || descriptor.key;
  return `${bulbName} - ${label}`;
}

/**
 * Build the display name of a bulb: the name the user set through the Yeelight
 * app when there is one, otherwise a readable fallback built from the model.
 *
 * The bulb id is NOT used as a fallback name: `0x000000000015243f` tells the
 * user nothing, while "Yeelight color" at least says which lamp it is.
 * @param {object} bulb - The discovered bulb.
 * @returns {string} The device name.
 * @example
 * deviceName({ name: '', model: 'color' }); // 'Yeelight color'
 */
export function deviceName(bulb) {
  const name = String(bulb.name || '').trim();
  if (name) {
    return name;
  }
  const model = String(bulb.model || '').trim();
  return model ? `Yeelight ${model}` : 'Yeelight';
}
