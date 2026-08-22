// -----------------------------------------------------------------------------
// Value translation between Gladys and Yeelight, both directions.
//
// Pure module: no socket, no SDK instance, no I/O. Everything here is a value
// transform, which is what makes the conversions testable one by one.
//
// The two vocabularies line up better than most, with three real mismatches:
//
//   1. BRIGHTNESS starts at 1, not 0. Yeelight has no "0%" state — off is the
//      power property — and `set_bright 0` is refused, so a 0 from Gladys must
//      become a power-off rather than a brightness write.
//   2. COLOR is one 0xRRGGBB integer on both sides, but the bulb reports it in
//      the `rgb` property ONLY while in colour mode; in CT mode the field holds
//      a stale value, so it must not be published.
//   3. Commands that change colour, CT or brightness are refused while the bulb
//      is OFF (spec: "Only accepted if the smart LED is currently in on state").
//      Those commands are flagged `requiresPower`, and the caller powers the
//      bulb on before sending them — so dragging a slider on a light that is
//      off turns it on, instead of doing nothing.
//   4. COLOR TEMPERATURE is Kelvin on the Yeelight side and MIRED on the Gladys
//      side. This is not a cosmetic choice: Gladys renders a `light.temperature`
//      slider with a fixed blue→orange gradient, i.e. it assumes the value grows
//      as the light gets WARMER. Kelvin runs the other way (2700K is warm, 6500K
//      is cold), so publishing Kelvin gives a slider that is visually reversed
//      and whose values land outside the range the core expects. Mired
//      (1e6/Kelvin) is what the native integrations use — Philips Hue exposes
//      153-500, Tasmota 123-500 — and it grows towards warm, matching the
//      gradient. Every value crossing this module is converted.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import {
  BRIGHTNESS_MIN,
  BRIGHTNESS_MAX,
  RGB_MIN,
  RGB_MAX,
  EFFECT_SMOOTH,
  EFFECT_SUDDEN,
  MIN_TRANSITION_MS,
} from './constants.js';

// Color modes reported in the `color_mode` property (spec table 4-2).
export const COLOR_MODE_RGB = 1;
export const COLOR_MODE_TEMPERATURE = 2;
export const COLOR_MODE_HSV = 3;

// Feature keys, the last segment of a feature external id. Kept here because
// both the mapping (which writes them) and the command builder (which reads
// them back) must agree on the exact strings.
export const FEATURE_KEYS = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  TEMPERATURE: 'temperature',
  BACKGROUND_POWER: 'bg_power',
  BACKGROUND_BRIGHTNESS: 'bg_brightness',
  BACKGROUND_COLOR: 'bg_color',
  NIGHT_LIGHT: 'night_light',
};

/**
 * Clamp a number into a range, rounding to the nearest integer. Yeelight
 * rejects out-of-range values outright, so clamping is what keeps a slider
 * dragged to its end from failing the whole command.
 * @param {number} value - The raw value.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The clamped integer.
 * @example
 * clamp(150, 1, 100); // 100
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value))));
}

/**
 * Convert a colour temperature between Kelvin and mired.
 *
 * The relation is its own inverse (mired = 1e6 / kelvin, and back), which is
 * exactly why one function serves both directions. Converting is what keeps the
 * Gladys slider — whose gradient runs cold→warm left to right — in the same
 * direction as the value, since mired grows as the light gets warmer while
 * Kelvin shrinks.
 * @param {number} value - A temperature in Kelvin, or in mired.
 * @returns {number} The same temperature in the other unit, rounded.
 * @example
 * kelvinMiredSwap(2700); // 370
 * kelvinMiredSwap(370); // 2703
 */
export function kelvinMiredSwap(value) {
  const number = Number(value);
  // A zero or negative temperature has no reciprocal; refuse it rather than
  // returning Infinity, which would poison a feature range.
  if (!Number.isFinite(number) || number <= 0) {
    return undefined;
  }
  return Math.round(1e6 / number);
}

/**
 * Convert a Kelvin range into the equivalent mired range.
 *
 * The bounds SWAP: the coldest Kelvin is the smallest mired, so a naive
 * per-bound conversion would produce a range whose min is above its max and a
 * slider the core rejects.
 * @param {{ min: number, max: number }} range - The Kelvin range.
 * @returns {{ min: number, max: number }} The mired range.
 * @example
 * kelvinRangeToMired({ min: 2700, max: 6500 }); // { min: 154, max: 370 }
 */
export function kelvinRangeToMired({ min, max }) {
  return { min: kelvinMiredSwap(max), max: kelvinMiredSwap(min) };
}

/**
 * Build the effect/duration pair every Yeelight setter takes as its last
 * arguments.
 * @param {number} transitionMs - The requested transition, in milliseconds.
 * @returns {[string, number]} The `[effect, duration]` pair.
 * @example
 * effectArgs(500); // ['smooth', 500]
 */
export function effectArgs(transitionMs) {
  const duration = Number(transitionMs);
  // Below the spec's 30 ms floor a smooth fade is meaningless: ask for the
  // instant change explicitly instead of sending an invalid duration.
  if (!Number.isFinite(duration) || duration < MIN_TRANSITION_MS) {
    return [EFFECT_SUDDEN, MIN_TRANSITION_MS];
  }
  return [EFFECT_SMOOTH, Math.round(duration)];
}

/**
 * Translate a Gladys command into the Yeelight method to call.
 *
 * Returns `null` for a feature that carries no command, which the caller turns
 * into an explicit error rather than a silent no-op.
 * @param {object} descriptor - `{ key, type }` of the target feature.
 * @param {number} value - The value Gladys sent.
 * @param {object} [options] - Extra options.
 * @param {number} [options.transitionMs] - Transition duration.
 * @returns {{ method: string, params: Array, requiresPower?: boolean }|null} The command,
 *   where `requiresPower` marks the ones the bulb refuses while it is off.
 * @example
 * buildCommand({ key: 'power' }, 1); // { method: 'set_power', params: ['on', ...] }
 */
export function buildCommand(descriptor, value, { transitionMs = 500 } = {}) {
  const [effect, duration] = effectArgs(transitionMs);
  const numeric = Number(value);

  switch (descriptor.key) {
    case FEATURE_KEYS.POWER:
      // No `mode` argument on purpose. Mode 1 would force the main light into
      // CT and drop whatever colour it was showing, and mode 5 is moonlight —
      // both are a state change the user did not ask for when they only pressed
      // on/off. Omitting it makes the bulb restore its own last state, which is
      // what every other controller does.
      return {
        method: 'set_power',
        params: [numeric ? 'on' : 'off', effect, duration],
      };

    case FEATURE_KEYS.BRIGHTNESS: {
      // 0% is not a brightness on a Yeelight, it is "off". Mapping it to
      // set_bright would be rejected by the bulb and leave the light on.
      if (numeric <= 0) {
        return { method: 'set_power', params: ['off', effect, duration] };
      }
      // No `set_scene` class sets brightness ALONE (`auto_delay_off` would also
      // arm a sleep timer, and the colour/ct classes would force a colour the
      // user did not ask for), so brightness stays on `set_bright`. The bulb
      // refuses it while off, which the caller handles by powering on first.
      return {
        method: 'set_bright',
        params: [clamp(numeric, BRIGHTNESS_MIN, BRIGHTNESS_MAX), effect, duration],
        requiresPower: true,
      };
    }

    case FEATURE_KEYS.COLOR: {
      const rgb = clamp(numeric, RGB_MIN, RGB_MAX);
      // `set_rgb` is refused while the bulb is off, so a light that is on keeps
      // the smooth transition and one that is off is powered on first by the
      // caller (`requiresPower`) rather than silently ignoring the click.
      return { method: 'set_rgb', params: [rgb, effect, duration], requiresPower: true };
    }

    case FEATURE_KEYS.TEMPERATURE: {
      // Gladys speaks mired, the bulb speaks Kelvin. Clamp on the MIRED side
      // first, using the descriptor bounds (which are mired too, see mapping.js)
      // — clamping after the conversion would compare a Kelvin value against
      // mired bounds and pin every request to one end of the range.
      const mired = clamp(numeric, descriptor.min, descriptor.max);
      const kelvin = kelvinMiredSwap(mired);
      return { method: 'set_ct_abx', params: [kelvin, effect, duration], requiresPower: true };
    }

    case FEATURE_KEYS.BACKGROUND_POWER:
      return {
        method: 'bg_set_power',
        params: [numeric ? 'on' : 'off', effect, duration],
      };

    case FEATURE_KEYS.BACKGROUND_BRIGHTNESS: {
      if (numeric <= 0) {
        return { method: 'bg_set_power', params: ['off', effect, duration] };
      }
      return {
        method: 'bg_set_bright',
        params: [clamp(numeric, BRIGHTNESS_MIN, BRIGHTNESS_MAX), effect, duration],
        requiresPower: true,
      };
    }

    case FEATURE_KEYS.BACKGROUND_COLOR:
      return {
        method: 'bg_set_rgb',
        params: [clamp(numeric, RGB_MIN, RGB_MAX), effect, duration],
        requiresPower: true,
      };

    case FEATURE_KEYS.NIGHT_LIGHT:
      // Mode 5 of set_power is the documented way into moonlight. Leaving it
      // means going back to the normal mode, which is mode 1 (CT).
      //
      // Both directions send `on` by design: `set_power` is the only way to
      // switch mode, and mode 5 IS the light being on in moonlight. Turning the
      // night light off therefore means "go back to normal white", not "switch
      // the lamp off" — the on/off feature is what switches the lamp.
      return {
        method: 'set_power',
        params: numeric ? ['on', effect, duration, 5] : ['on', effect, duration, 1],
      };

    default:
      return null;
  }
}

/**
 * Read the Gladys value of one feature from the properties a bulb reported.
 *
 * Returns `undefined` when the properties carry nothing for that feature, which
 * the caller treats as "nothing to publish" — publishing a placeholder would
 * write a wrong value into the history.
 * @param {object} descriptor - `{ key }` of the feature.
 * @param {Record<string, string>} props - The reported properties.
 * @returns {number|undefined} The Gladys value.
 * @example
 * readState({ key: 'power' }, { power: 'on' }); // 1
 */
export function readState(descriptor, props) {
  switch (descriptor.key) {
    case FEATURE_KEYS.POWER:
      return readPower(props.power);

    case FEATURE_KEYS.BRIGHTNESS:
      return readNumber(props.bright);

    case FEATURE_KEYS.TEMPERATURE: {
      // The bulb reports Kelvin; Gladys stores mired.
      const kelvin = readNumber(props.ct);
      return kelvin === undefined ? undefined : kelvinMiredSwap(kelvin);
    }

    case FEATURE_KEYS.COLOR: {
      // `rgb` only reflects reality while the bulb shows a COLOUR: in CT mode
      // it keeps whatever colour was last set, so publishing it would paint the
      // Gladys UI with a colour the lamp is not showing.
      //
      // HSV mode counts as a colour: strips and bedside lamps sit in mode 3
      // after the Yeelight app sets a colour, and the bulb keeps `rgb` in sync
      // with the hue/sat it is displaying. Treating mode 3 as "not a colour"
      // would leave those lamps with a colour Gladys never shows.
      const mode = readNumber(props.color_mode);
      if (mode === COLOR_MODE_TEMPERATURE) {
        return undefined;
      }
      if (mode === COLOR_MODE_HSV) {
        // Prefer the reported rgb; fall back to converting hue/sat when the
        // firmware only reports those.
        const rgb = readNumber(props.rgb);
        if (rgb !== undefined) {
          return rgb;
        }
        const hue = readNumber(props.hue);
        const saturation = readNumber(props.sat);
        return hue === undefined || saturation === undefined
          ? undefined
          : hsvToRgbInteger(hue, saturation);
      }
      return readNumber(props.rgb);
    }

    case FEATURE_KEYS.BACKGROUND_POWER:
      return readPower(props.bg_power);

    case FEATURE_KEYS.BACKGROUND_BRIGHTNESS:
      return readNumber(props.bg_bright);

    case FEATURE_KEYS.BACKGROUND_COLOR: {
      // Same rules as the main light: `bg_rgb` is only meaningful outside CT
      // mode, and HSV (mode 3) IS a colour — the ambient ring of a ceiling
      // light sits in mode 3 as soon as the Yeelight app sets a colour on it,
      // so skipping mode 3 here is what kept those changes from ever reaching
      // Gladys.
      const mode = readNumber(props.bg_lmode);
      if (mode === COLOR_MODE_TEMPERATURE) {
        return undefined;
      }
      if (mode === COLOR_MODE_HSV) {
        const rgb = readNumber(props.bg_rgb);
        if (rgb !== undefined) {
          return rgb;
        }
        const hue = readNumber(props.bg_hue);
        const saturation = readNumber(props.bg_sat);
        return hue === undefined || saturation === undefined
          ? undefined
          : hsvToRgbInteger(hue, saturation);
      }
      return readNumber(props.bg_rgb);
    }

    case FEATURE_KEYS.NIGHT_LIGHT: {
      // `active_mode` is 1 in moonlight mode, 0 in daylight mode.
      const active = readNumber(props.active_mode);
      return active === undefined ? undefined : active === 1 ? 1 : 0;
    }

    default:
      return undefined;
  }
}

/**
 * Convert a hue/saturation pair into the single 0xRRGGBB integer Gladys stores.
 * Brightness is deliberately fixed at full: it is carried by its own feature,
 * so folding it in here would darken the colour swatch twice.
 * @param {number} hue - Hue, 0-359.
 * @param {number} saturation - Saturation, 0-100.
 * @returns {number} The packed RGB integer.
 * @example
 * hsvToRgbInteger(0, 100); // 16711680 (red)
 */
export function hsvToRgbInteger(hue, saturation) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, Number(saturation) / 100));
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];
  const to255 = (v) => Math.round((v + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/**
 * Read a `power`-style property into a Gladys binary value.
 * @param {string|undefined} value - The raw property value.
 * @returns {number|undefined} 1 for on, 0 for off, undefined when absent.
 */
function readPower(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value).toLowerCase() === 'on' ? 1 : 0;
}

/**
 * Read a numeric property. Every value in a notification is a STRING, even the
 * numeric ones (spec section 4.3), so this conversion is not optional.
 * @param {string|number|undefined} value - The raw property value.
 * @returns {number|undefined} The number, or undefined when unusable.
 */
function readNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The Yeelight properties worth reading back for a set of features. Used to
 * refresh a device without asking for the whole table.
 * @param {object[]} descriptors - The feature descriptors of the device.
 * @returns {string[]} The property names to request.
 * @example
 * propsForFeatures([{ key: 'power' }, { key: 'color' }]);
 */
export function propsForFeatures(descriptors) {
  const props = new Set();
  descriptors.forEach((descriptor) => {
    switch (descriptor.key) {
      case FEATURE_KEYS.POWER:
        props.add('power');
        break;
      case FEATURE_KEYS.BRIGHTNESS:
        props.add('bright');
        break;
      case FEATURE_KEYS.TEMPERATURE:
        props.add('ct');
        break;
      case FEATURE_KEYS.COLOR:
        props.add('rgb');
        // Needed to know whether `rgb` is meaningful right now.
        props.add('color_mode');
        // Fallback for a firmware that only reports hue/sat in HSV mode.
        props.add('hue');
        props.add('sat');
        break;
      case FEATURE_KEYS.BACKGROUND_POWER:
        props.add('bg_power');
        break;
      case FEATURE_KEYS.BACKGROUND_BRIGHTNESS:
        props.add('bg_bright');
        break;
      case FEATURE_KEYS.BACKGROUND_COLOR:
        props.add('bg_rgb');
        props.add('bg_lmode');
        // Fallback for a firmware that only reports hue/sat in HSV mode.
        props.add('bg_hue');
        props.add('bg_sat');
        break;
      case FEATURE_KEYS.NIGHT_LIGHT:
        props.add('active_mode');
        break;
      default:
        break;
    }
  });
  return [...props];
}

// Re-exported so the mapping module names Gladys types from one place.
export const LIGHT_TYPES = DEVICE_FEATURE_TYPES.LIGHT;
