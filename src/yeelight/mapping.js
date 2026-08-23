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
import { FEATURE_KEYS, LIGHT_TYPES, kelvinRangeToMired } from './convert.js';
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
    // The model gives the range in Kelvin; Gladys wants mired. The bounds swap
    // in the conversion (coldest Kelvin = smallest mired), which is what keeps
    // the slider running the same way as its cold→warm gradient.
    const range = kelvinRangeToMired(temperatureRange(bulb.model));
    features.push({
      key: FEATURE_KEYS.TEMPERATURE,
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: LIGHT_TYPES.TEMPERATURE,
      readOnly: false,
      keepHistory: true,
      // No unit is declared, deliberately: mired is the scale the core's
      // `light.temperature` features are built on (Philips Hue exposes 153-500,
      // Tasmota 123-500) and neither declares a unit, because the SDK has no
      // mired constant. Declaring KELVIN here was the bug — it labelled a mired
      // value as Kelvin and ran the slider backwards.
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
    // The ambient ring of a ceiling light tunes its white independently of the
    // main light — the Yeelight app offers a warm/cold slider next to the colour
    // wheel — so a device advertising `bg_set_ct_abx` gets its own temperature
    // feature rather than sharing the main one.
    if (support.has('bg_set_ct_abx')) {
      const bgRange = kelvinRangeToMired(temperatureRange(bulb.model));
      features.push({
        key: FEATURE_KEYS.BACKGROUND_TEMPERATURE,
        category: DEVICE_FEATURE_CATEGORIES.LIGHT,
        type: LIGHT_TYPES.TEMPERATURE,
        readOnly: false,
        keepHistory: true,
        min: bgRange.min,
        max: bgRange.max,
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

// Name of each feature, as shown in the Gladys UI.
//
// The device name is NOT repeated here. Gladys already displays a feature under
// its device — in the device list, in a dashboard box, in the scene editor — so
// prefixing every label with the bulb name produced rows reading "Salon - Salon
// - brightness". The label alone says which dimension it is; the surrounding UI
// says which lamp.
//
// A device carrying a background light gets two of everything, so those labels
// are explicit about WHICH light they drive: the plain ones are the main light,
// the `bg_*` ones say "ambient". Leaving "Colour" and "Colour" side by side was
// unusable on a ceiling light with an ambient ring.
const FEATURE_LABELS = {
  [FEATURE_KEYS.POWER]: 'Main light',
  [FEATURE_KEYS.BRIGHTNESS]: 'Main brightness',
  [FEATURE_KEYS.COLOR]: 'Main colour',
  [FEATURE_KEYS.TEMPERATURE]: 'Main colour temperature',
  [FEATURE_KEYS.BACKGROUND_POWER]: 'Ambient light',
  [FEATURE_KEYS.BACKGROUND_BRIGHTNESS]: 'Ambient brightness',
  [FEATURE_KEYS.BACKGROUND_COLOR]: 'Ambient colour',
  [FEATURE_KEYS.BACKGROUND_TEMPERATURE]: 'Ambient colour temperature',
  [FEATURE_KEYS.NIGHT_LIGHT]: 'Night light',
};

// Labels used when the bulb has no ambient light at all. Saying "Main" only
// makes sense when there is something else to tell it apart from; on a plain
// colour bulb it is noise.
const SINGLE_LIGHT_LABELS = {
  [FEATURE_KEYS.POWER]: 'On/Off',
  [FEATURE_KEYS.BRIGHTNESS]: 'Brightness',
  [FEATURE_KEYS.COLOR]: 'Colour',
  [FEATURE_KEYS.TEMPERATURE]: 'Colour temperature',
};

/**
 * Build the display name of one feature.
 *
 * `hasAmbient` switches between the two label sets: a bulb with a background
 * light needs "Main"/"Ambient" to be readable, a plain bulb does not.
 * @param {object} descriptor - The feature descriptor.
 * @param {object} [options] - Naming options.
 * @param {boolean} [options.hasAmbient] - True when the bulb also has an ambient light.
 * @returns {string} The feature name.
 * @example
 * featureName({ key: 'brightness' }); // 'Brightness'
 * featureName({ key: 'brightness' }, { hasAmbient: true }); // 'Main brightness'
 */
export function featureName(descriptor, { hasAmbient = false } = {}) {
  if (!hasAmbient && SINGLE_LIGHT_LABELS[descriptor.key]) {
    return SINGLE_LIGHT_LABELS[descriptor.key];
  }
  return FEATURE_LABELS[descriptor.key] || descriptor.key;
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
