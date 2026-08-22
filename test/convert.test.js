import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommand,
  readState,
  propsForFeatures,
  effectArgs,
  clamp,
  hsvToRgbInteger,
  kelvinMiredSwap,
  kelvinRangeToMired,
  FEATURE_KEYS,
} from '../src/yeelight/convert.js';

test('power maps to set_power in both directions', () => {
  assert.deepEqual(buildCommand({ key: FEATURE_KEYS.POWER }, 1).params[0], 'on');
  assert.deepEqual(buildCommand({ key: FEATURE_KEYS.POWER }, 0).params[0], 'off');
  assert.equal(readState({ key: FEATURE_KEYS.POWER }, { power: 'on' }), 1);
  assert.equal(readState({ key: FEATURE_KEYS.POWER }, { power: 'off' }), 0);
});

test('a brightness of 0 turns the light off instead of writing 0', () => {
  // Yeelight has no 0% brightness: the minimum is 1 and `set_bright 0` is
  // refused, so a 0 from Gladys can only mean "off".
  const command = buildCommand({ key: FEATURE_KEYS.BRIGHTNESS }, 0);
  assert.equal(command.method, 'set_power');
  assert.equal(command.params[0], 'off');
});

test('brightness is clamped into the 1-100 range the bulb accepts', () => {
  assert.equal(buildCommand({ key: FEATURE_KEYS.BRIGHTNESS }, 150).params[0], 100);
  assert.equal(buildCommand({ key: FEATURE_KEYS.BRIGHTNESS }, 42.6).params[0], 43);
});

test('colour, temperature and brightness are flagged as needing the light on', () => {
  // The spec is explicit: these are "only accepted if the smart LED is
  // currently in on state". The flag is what makes the caller power it on
  // first, instead of the click doing nothing.
  for (const key of [FEATURE_KEYS.BRIGHTNESS, FEATURE_KEYS.COLOR, FEATURE_KEYS.TEMPERATURE]) {
    assert.equal(buildCommand({ key, min: 1700, max: 6500 }, 50).requiresPower, true);
  }
  // Power itself obviously does not need the light to be on.
  assert.equal(buildCommand({ key: FEATURE_KEYS.POWER }, 1).requiresPower, undefined);
});

test('the colour temperature is clamped in mired, then sent in Kelvin', () => {
  // The descriptor bounds are mired (see mapping.js): 154 is the cold end,
  // 370 the warm one. Clamping has to happen BEFORE the conversion, otherwise a
  // Kelvin value gets compared against mired bounds.
  const descriptor = { key: FEATURE_KEYS.TEMPERATURE, min: 154, max: 370 };
  // Past the warm end: clamped to 370 mired = 2703K.
  assert.equal(buildCommand(descriptor, 900).params[0], 2703);
  // Past the cold end: clamped to 154 mired = 6494K.
  assert.equal(buildCommand(descriptor, 10).params[0], 6494);
  // In range: 250 mired = 4000K.
  assert.equal(buildCommand(descriptor, 250).params[0], 4000);
});

test('a mired value round-trips through Kelvin and back', () => {
  // The conversion is its own inverse, which is what keeps the value the user
  // set and the value the bulb reports back from drifting apart.
  for (const mired of [154, 200, 250, 300, 370]) {
    const kelvin = kelvinMiredSwap(mired);
    assert.ok(Math.abs(kelvinMiredSwap(kelvin) - mired) <= 1);
  }
});

test('a Kelvin range converts into a mired range with its bounds swapped', () => {
  // The coldest Kelvin is the SMALLEST mired: converting bound by bound without
  // swapping would build a range whose min sits above its max.
  assert.deepEqual(kelvinRangeToMired({ min: 2700, max: 6500 }), { min: 154, max: 370 });
  assert.deepEqual(kelvinRangeToMired({ min: 1700, max: 6500 }), { min: 154, max: 588 });
});

test('a colour is a single 0xRRGGBB integer, clamped to the valid range', () => {
  assert.equal(buildCommand({ key: FEATURE_KEYS.COLOR }, 16711680).params[0], 16711680);
  assert.equal(buildCommand({ key: FEATURE_KEYS.COLOR }, 99999999).params[0], 16777215);
});

test('the night light uses mode 5 of set_power', () => {
  // Documented as the only way into moonlight without a power cycle.
  assert.deepEqual(buildCommand({ key: FEATURE_KEYS.NIGHT_LIGHT }, 1).params[3], 5);
  assert.deepEqual(buildCommand({ key: FEATURE_KEYS.NIGHT_LIGHT }, 0).params[3], 1);
});

test('an unknown feature yields no command rather than a silent no-op', () => {
  assert.equal(buildCommand({ key: 'not_a_feature' }, 1), null);
});

test('a transition under the spec floor becomes an instant change', () => {
  // Below 30 ms a smooth fade is meaningless and the duration invalid.
  assert.deepEqual(effectArgs(500), ['smooth', 500]);
  assert.deepEqual(effectArgs(0), ['sudden', 30]);
  assert.deepEqual(effectArgs(undefined), ['sudden', 30]);
});

test('a colour is published in HSV mode, which strips sit in', () => {
  // Verified against a real strip6: the Yeelight app leaves it in mode 3, and
  // the firmware keeps `rgb` in sync with the hue/sat it displays. Treating
  // mode 3 as "not a colour" left those lamps with a colour Gladys never showed.
  assert.equal(
    readState({ key: FEATURE_KEYS.COLOR }, { rgb: '16641023', color_mode: '3' }),
    16641023,
  );
});

test('a colour in HSV mode falls back to hue/sat when rgb is missing', () => {
  assert.equal(
    readState({ key: FEATURE_KEYS.COLOR }, { color_mode: '3', hue: '0', sat: '100' }),
    16711680,
  );
});

test('hue/saturation convert to the packed integer Gladys stores', () => {
  assert.equal(hsvToRgbInteger(0, 100), 0xff0000);
  assert.equal(hsvToRgbInteger(120, 100), 0x00ff00);
  assert.equal(hsvToRgbInteger(240, 100), 0x0000ff);
  // Saturation 0 is white whatever the hue.
  assert.equal(hsvToRgbInteger(200, 0), 0xffffff);
});

test('a colour read in temperature mode is not published', () => {
  // In CT mode the `rgb` property keeps a stale value; publishing it would
  // paint the Gladys UI with a colour the lamp is not showing.
  assert.equal(
    readState({ key: FEATURE_KEYS.COLOR }, { rgb: '16711680', color_mode: '2' }),
    undefined,
  );
  assert.equal(
    readState({ key: FEATURE_KEYS.COLOR }, { rgb: '16711680', color_mode: '1' }),
    16711680,
  );
});

test('numeric properties arrive as strings and are converted', () => {
  // Section 4.3: "all values are String type", even the numeric ones.
  assert.equal(readState({ key: FEATURE_KEYS.BRIGHTNESS }, { bright: '42' }), 42);
  // The bulb reports Kelvin, Gladys stores mired: 4000K -> 250 mired.
  assert.equal(readState({ key: FEATURE_KEYS.TEMPERATURE }, { ct: '4000' }), 250);
});

test('the ambient colour is published in HSV mode too', () => {
  // The ambient ring of a ceiling light sits in mode 3 as soon as the Yeelight
  // app sets a colour on it. Skipping mode 3 here kept those changes from ever
  // reaching Gladys, while the main light handled them.
  assert.equal(
    readState({ key: FEATURE_KEYS.BACKGROUND_COLOR }, { bg_rgb: '16641023', bg_lmode: '3' }),
    16641023,
  );
  // Falls back to hue/sat when the firmware only reports those.
  assert.equal(
    readState(
      { key: FEATURE_KEYS.BACKGROUND_COLOR },
      { bg_lmode: '3', bg_hue: '0', bg_sat: '100' },
    ),
    16711680,
  );
  // CT mode still publishes nothing: `bg_rgb` is stale there.
  assert.equal(
    readState({ key: FEATURE_KEYS.BACKGROUND_COLOR }, { bg_rgb: '16711680', bg_lmode: '2' }),
    undefined,
  );
});

test('an absent property publishes nothing rather than a placeholder', () => {
  // Publishing a 0 here would write a wrong value into the history.
  assert.equal(readState({ key: FEATURE_KEYS.BRIGHTNESS }, {}), undefined);
  assert.equal(readState({ key: FEATURE_KEYS.POWER }, { power: '' }), undefined);
});

test('the night light state is read from active_mode', () => {
  assert.equal(readState({ key: FEATURE_KEYS.NIGHT_LIGHT }, { active_mode: '1' }), 1);
  assert.equal(readState({ key: FEATURE_KEYS.NIGHT_LIGHT }, { active_mode: '0' }), 0);
});

test('only the properties the features need are requested', () => {
  const props = propsForFeatures([{ key: FEATURE_KEYS.POWER }, { key: FEATURE_KEYS.COLOR }]);
  assert.deepEqual(props.sort(), ['color_mode', 'hue', 'power', 'rgb', 'sat']);
  // color_mode comes along because it decides whether `rgb` is meaningful.
  assert.ok(props.includes('color_mode'));
});

test('clamp rounds and bounds', () => {
  assert.equal(clamp(5.6, 1, 100), 6);
  assert.equal(clamp(-10, 1, 100), 1);
});
