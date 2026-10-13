// -----------------------------------------------------------------------------
// Light effects: the colour flows of the Yeelight protocol (spec 4.1,
// `start_cf` / `set_scene cf`), as ready-made presets for the scene actions.
//
// A flow is a list of steps `[duration ms, mode, value, brightness]`, mode 1 =
// colour (RGB), 2 = colour temperature (Kelvin), 7 = pause. The flow is sent
// through `set_scene ['cf', count, action, flow]` rather than `start_cf`: the
// lamp refuses `start_cf` while it is off, `set_scene` turns it on first.
//
// `action` says what the lamp does once the flow ends: 0 = back to the state it
// had before, 1 = stay on the last step, 2 = turn off. A notification on a lamp
// that was off must end off, hence `endAction`.
//
// White-only lamps (ceiling lights, desk lamps) get the same effect in colour
// temperature: a red alert becomes a cold white flash, a candle a warm one.
// -----------------------------------------------------------------------------

/** The effect keys of the `start_effect` scene action, forever. */
export const EFFECTS = ['sunrise', 'sunset', 'alert', 'notify', 'candle'];

const RED = 0xff0000;
const DEEP_ORANGE = 0xff4d00;
const AMBER = 0xffa040;
const BLUE = 0x0050ff;

// The protocol refuses a step shorter than 50 ms.
const MIN_STEP_MS = 50;

/**
 * Split a total duration over steps weighted by `shares`.
 * @param {number} totalMs - The whole duration.
 * @param {number[]} shares - The weight of each step.
 * @returns {number[]} The duration of each step, each at least MIN_STEP_MS.
 */
function spread(totalMs, shares) {
  const sum = shares.reduce((total, share) => total + share, 0);
  return shares.map((share) => Math.max(MIN_STEP_MS, Math.round((totalMs * share) / sum)));
}

/**
 * Build the `set_scene` parameters of an effect.
 * @param {string} effect - One of EFFECTS.
 * @param {object} options - What the lamp can do and how long the effect lasts.
 * @param {boolean} options.color - Whether the lamp does RGB colour.
 * @param {{ min: number, max: number }} options.kelvin - Its colour temperature range.
 * @param {number} [options.minutes] - Duration of sunrise and sunset.
 * @param {boolean} [options.wasOn] - Whether the lamp was on before the effect.
 * @returns {Array} `['cf', count, action, 'flow']`, ready for `set_scene`.
 * @example
 * effectScene('alert', { color: true, kelvin: { min: 1700, max: 6500 }, wasOn: false });
 */
export function effectScene(effect, { color, kelvin, minutes = 15, wasOn = true }) {
  const warm = Math.max(kelvin.min, 2700);
  const cold = Math.min(kelvin.max, 6500);
  // Back to the previous state, or off when the lamp was off: a notification
  // must not leave a light on in an empty room.
  const endAction = wasOn ? 0 : 2;
  const totalMs = Math.min(Math.max(Number(minutes) || 15, 1), 60) * 60 * 1000;

  let count;
  let action;
  let steps;
  switch (effect) {
    case 'sunrise': {
      const [a, b, c, d] = spread(totalMs, [1, 3, 3, 3]);
      steps = color
        ? [
            [a, 1, DEEP_ORANGE, 1],
            [b, 1, AMBER, 10],
            [c, 2, warm, 60],
            [d, 2, Math.min(cold, 4000), 100],
          ]
        : [
            [a, 2, kelvin.min, 1],
            [b, 2, warm, 10],
            [c, 2, warm, 60],
            [d, 2, Math.min(cold, 4000), 100],
          ];
      [count, action] = [1, 1];
      break;
    }
    case 'sunset': {
      const [a, b, c] = spread(totalMs, [3, 4, 3]);
      steps = color
        ? [
            [a, 2, warm, 50],
            [b, 1, AMBER, 15],
            [c, 1, DEEP_ORANGE, 1],
          ]
        : [
            [a, 2, warm, 50],
            [b, 2, kelvin.min, 15],
            [c, 2, kelvin.min, 1],
          ];
      [count, action] = [1, 2];
      break;
    }
    case 'alert':
      steps = color
        ? [
            [250, 1, RED, 100],
            [250, 1, RED, 1],
          ]
        : [
            [250, 2, cold, 100],
            [250, 2, cold, 1],
          ];
      [count, action] = [10, endAction];
      break;
    case 'notify':
      steps = color
        ? [
            [600, 1, BLUE, 80],
            [600, 1, BLUE, 10],
          ]
        : [
            [600, 2, cold, 80],
            [600, 2, cold, 10],
          ];
      [count, action] = [4, endAction];
      break;
    case 'candle':
      steps = color
        ? [
            [800, 1, AMBER, 50],
            [800, 1, DEEP_ORANGE, 30],
            [1200, 1, AMBER, 45],
            [700, 1, DEEP_ORANGE, 25],
          ]
        : [
            [800, 2, warm, 50],
            [800, 2, kelvin.min, 30],
            [1200, 2, warm, 45],
            [700, 2, kelvin.min, 25],
          ];
      // Endless, until `stop_effect` or another command.
      [count, action] = [0, 0];
      break;
    default:
      throw new Error(`Unknown effect "${effect}" (expected one of ${EFFECTS.join(', ')})`);
  }

  const flow = steps.map((step) => step.join(',')).join(',');
  return ['cf', count, action, flow];
}
