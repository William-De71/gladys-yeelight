// -----------------------------------------------------------------------------
// Yeelight model capabilities.
//
// Two sources say what a bulb can do, and they are not redundant:
//
//   1. the `support` header of the discovery reply — the authoritative list of
//      METHODS the firmware accepts (`set_rgb`, `set_ct_abx`, `bg_set_power`…).
//      The spec states that any method absent from it is rejected, so it is
//      what we key the writable features on;
//   2. the `model` string (`color`, `mono`, `ceiling`…) — which tells us the
//      color TEMPERATURE RANGE, a value the support list cannot express and
//      that differs per product (a ceiling light goes down to 2700K, a colour
//      bulb to 1700K).
//
// Keying features on the support list rather than on a model table is what
// makes this integration work with models released after it was written: an
// unknown model still exposes exactly the methods its firmware advertises, and
// only falls back to the spec's default temperature range.
// -----------------------------------------------------------------------------

import { COLOR_TEMPERATURE_MIN, COLOR_TEMPERATURE_MAX } from './constants.js';

// Color temperature ranges per model, in Kelvin. Only the models whose range
// differs from the spec default are listed; anything unknown gets the default.
// Sourced from the Yeelight product descriptions the spec points to.
const MODEL_TEMPERATURE_RANGES = {
  // White-only bulbs: no tunable temperature at all (see supportsTemperature,
  // which keys on the method list, so these never expose the feature anyway).
  mono: { min: 2700, max: 2700 },
  mono1: { min: 2700, max: 2700 },
  // Colour bulbs and strips: the full range.
  color: { min: 1700, max: 6500 },
  color1: { min: 1700, max: 6500 },
  color2: { min: 1700, max: 6500 },
  color4: { min: 1700, max: 6500 },
  colorb: { min: 1700, max: 6500 },
  colorc: { min: 1700, max: 6500 },
  stripe: { min: 1700, max: 6500 },
  strip1: { min: 1700, max: 6500 },
  strip4: { min: 1700, max: 6500 },
  strip6: { min: 1700, max: 6500 },
  // Bedside lamps.
  bslamp: { min: 1700, max: 6500 },
  bslamp1: { min: 1700, max: 6500 },
  bslamp2: { min: 1700, max: 6500 },
  bslamp3: { min: 1700, max: 6500 },
  // Ceiling lights: tunable white only, over a narrower range.
  ceiling: { min: 2700, max: 6500 },
  ceiling1: { min: 2700, max: 6500 },
  ceiling2: { min: 2700, max: 6500 },
  ceiling3: { min: 2700, max: 6500 },
  ceiling4: { min: 2700, max: 6500 },
  ceiling10: { min: 2700, max: 6500 },
  ceiling11: { min: 2700, max: 6500 },
  ceiling13: { min: 2700, max: 6500 },
  ceiling15: { min: 2700, max: 6500 },
  ceiling20: { min: 2700, max: 6500 },
  // Desk lamps.
  desklamp: { min: 2700, max: 6500 },
  lamp: { min: 2700, max: 6500 },
  lamp1: { min: 2700, max: 6500 },
  lamp15: { min: 2700, max: 6500 },
};

// Models whose firmware advertises `set_ct_abx` without owning a white LED.
// They accept the command, answer `ok`, and change nothing: `ct` stays pinned at
// 6500 and `color_mode` stays in colour mode whatever Kelvin value is sent.
// Verified on a LED Lightstrip 1S (`strip6`, firmware 20) by sweeping the whole
// range and reading the properties back after each step.
//
// The plain colour bulbs and the older strips are deliberately NOT here: they do
// have a real tunable white.
const NO_REAL_TEMPERATURE = new Set([
  // LED Lightstrip 1S — RGB only, no white channel.
  'strip6',
]);

/**
 * Resolve the color temperature range of a model, in Kelvin.
 * @param {string|undefined} model - The `model` header of the discovery reply.
 * @returns {{ min: number, max: number }} The usable Kelvin range.
 * @example
 * temperatureRange('ceiling1'); // { min: 2700, max: 6500 }
 */
export function temperatureRange(model) {
  const known = MODEL_TEMPERATURE_RANGES[String(model || '').toLowerCase()];
  return known || { min: COLOR_TEMPERATURE_MIN, max: COLOR_TEMPERATURE_MAX };
}

/**
 * Parse the `support` header into a Set of method names. The spec separates the
 * methods by white space, and a bulb rejects any method missing from it.
 * @param {string|undefined} support - The raw `support` header.
 * @returns {Set<string>} The supported method names.
 * @example
 * parseSupport('set_power toggle set_bright'); // Set { 'set_power', ... }
 */
export function parseSupport(support) {
  return new Set(
    String(support || '')
      .split(/\s+/)
      .map((method) => method.trim().toLowerCase())
      .filter((method) => method.length > 0),
  );
}

/**
 * Whether the bulb can change its color temperature.
 *
 * The support list alone is NOT enough here, and this is the one place where it
 * has to be second-guessed. An RGB-only strip has no white LED at all, yet its
 * firmware advertises `set_ct_abx`, answers `ok` to it and leaves `ct` frozen at
 * 6500 while staying in colour mode — the command is accepted and discarded.
 * Trusting the advertisement gave Gladys a temperature slider that could not
 * move the light, so those models are excluded by name.
 * @param {Set<string>} support - The parsed support set.
 * @param {string|undefined} [model] - The `model` header, when it is known.
 * @returns {boolean} True when the bulb really has a tunable white.
 */
export function supportsTemperature(support, model) {
  if (NO_REAL_TEMPERATURE.has(String(model || '').toLowerCase())) {
    return false;
  }
  return support.has('set_ct_abx');
}

/**
 * Whether the bulb can change its color.
 * @param {Set<string>} support - The parsed support set.
 * @returns {boolean} True when `set_rgb` is supported.
 */
export function supportsColor(support) {
  return support.has('set_rgb');
}

/**
 * Whether the bulb can change its brightness.
 * @param {Set<string>} support - The parsed support set.
 * @returns {boolean} True when `set_bright` is supported.
 */
export function supportsBrightness(support) {
  return support.has('set_bright');
}

/**
 * Whether the device carries a separate background light (the ambient ring of
 * some ceiling lights and screen bars), controlled by the `bg_*` methods.
 * @param {Set<string>} support - The parsed support set.
 * @returns {boolean} True when the background light can be switched.
 */
export function supportsBackgroundLight(support) {
  return support.has('bg_set_power');
}

/**
 * Whether the device has a night light ("moonlight") mode. Only ceiling lights
 * expose it, through mode 5 of `set_power`, and it is reported by `nl_br`.
 * @param {string|undefined} model - The model reported by the bulb.
 * @param {Set<string>} support - The parsed support set.
 * @returns {boolean} True when the night light can be activated.
 */
export function supportsNightLight(model, support) {
  // `set_scene` is what we use to enter moonlight without a power cycle, and
  // only ceiling lights implement the mode at all (spec, set_power mode 5).
  return (
    String(model || '')
      .toLowerCase()
      .startsWith('ceiling') && support.has('set_power')
  );
}
