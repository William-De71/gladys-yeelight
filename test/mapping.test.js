import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBulb, deviceName, featureName } from '../src/yeelight/mapping.js';
import { parseSupport, temperatureRange, supportsNightLight } from '../src/yeelight/models.js';
import { FEATURE_KEYS } from '../src/yeelight/convert.js';

const keysOf = (bulb) => describeBulb(bulb).map((feature) => feature.key);

test('features follow the support list the bulb advertises', () => {
  // Keying on the advertised methods rather than a model table is what makes a
  // model released after this code still get exactly what its firmware does.
  assert.deepEqual(keysOf({ model: 'color', support: 'set_power set_bright set_rgb set_ct_abx' }), [
    FEATURE_KEYS.POWER,
    FEATURE_KEYS.BRIGHTNESS,
    FEATURE_KEYS.COLOR,
    FEATURE_KEYS.TEMPERATURE,
  ]);
});

test('a white-only bulb gets neither colour nor temperature', () => {
  assert.deepEqual(keysOf({ model: 'mono', support: 'set_power set_bright' }), [
    FEATURE_KEYS.POWER,
    FEATURE_KEYS.BRIGHTNESS,
  ]);
});

test('a bulb that only switches still gets its on/off feature', () => {
  // A light with no dimming is still a light; dropping it would be worse than
  // exposing the one thing it can do.
  assert.deepEqual(keysOf({ model: '', support: 'set_power' }), [FEATURE_KEYS.POWER]);
});

test('an unknown model still gets the features its support list declares', () => {
  const keys = keysOf({ model: 'ceiling99-future', support: 'set_power set_bright set_ct_abx' });
  assert.ok(keys.includes(FEATURE_KEYS.TEMPERATURE));
});

test('a background light adds its own parallel features', () => {
  const keys = keysOf({
    model: 'ceiling4',
    support: 'set_power set_bright bg_set_power bg_set_bright bg_set_rgb',
  });
  assert.ok(keys.includes(FEATURE_KEYS.BACKGROUND_POWER));
  assert.ok(keys.includes(FEATURE_KEYS.BACKGROUND_BRIGHTNESS));
  assert.ok(keys.includes(FEATURE_KEYS.BACKGROUND_COLOR));
});

test('the night light is offered on ceiling lights only', () => {
  const support = parseSupport('set_power set_bright');
  assert.equal(supportsNightLight('ceiling1', support), true);
  assert.equal(supportsNightLight('color', support), false);
});

test('the temperature range follows the model, in Kelvin', () => {
  // A ceiling light does not go down to 1700K; publishing the spec default
  // would let the user drag the slider into a range the lamp refuses.
  assert.deepEqual(temperatureRange('ceiling1'), { min: 2700, max: 6500 });
  assert.deepEqual(temperatureRange('color'), { min: 1700, max: 6500 });
  // An unknown model falls back to the spec's own bounds.
  assert.deepEqual(temperatureRange('brand-new'), { min: 1700, max: 6500 });
});

test('the temperature feature is published in mired, not in Kelvin', () => {
  // Gladys renders `light.temperature` with a fixed cold->warm gradient, so the
  // value has to GROW towards warm. Kelvin runs the other way; mired is what
  // the native integrations expose (Hue 153-500, Tasmota 123-500).
  const [temperature] = describeBulb({ model: 'ceiling1', support: 'set_ct_abx' }).filter(
    (feature) => feature.key === FEATURE_KEYS.TEMPERATURE,
  );
  // 6500K -> 154 mired (cold end), 2700K -> 370 mired (warm end).
  assert.equal(temperature.min, 154);
  assert.equal(temperature.max, 370);
  // No unit: the SDK has no mired constant, and declaring KELVIN was the bug.
  assert.equal(temperature.unit, undefined);
});

test('brightness never offers a 0 the bulb would refuse', () => {
  const [brightness] = describeBulb({ support: 'set_power set_bright' }).filter(
    (feature) => feature.key === FEATURE_KEYS.BRIGHTNESS,
  );
  assert.equal(brightness.min, 1);
  assert.equal(brightness.max, 100);
});

test('every feature is writable and gives feedback', () => {
  // A Yeelight pushes its state, so each feature can be trusted to report back.
  describeBulb({ model: 'color', support: 'set_power set_bright set_rgb set_ct_abx' }).forEach(
    (feature) => {
      assert.equal(feature.readOnly, false, `${feature.key} must be writable`);
      assert.equal(feature.category, 'light');
    },
  );
});

test('the support list is parsed into normalized method names', () => {
  const support = parseSupport('  set_power   SET_BRIGHT\nset_rgb ');
  assert.ok(support.has('set_power'));
  assert.ok(support.has('set_bright'));
  assert.equal(support.size, 3);
  assert.equal(parseSupport(undefined).size, 0);
});

test('a bulb falls back to a readable name, never to its raw id', () => {
  // "0x000000000015243f" tells the user nothing about which lamp this is.
  assert.equal(deviceName({ name: 'Living room' }), 'Living room');
  assert.equal(deviceName({ name: '', model: 'color' }), 'Yeelight color');
  assert.equal(deviceName({}), 'Yeelight');
});

test('a feature name does not repeat the device name', () => {
  // Gladys already shows a feature under its device, so prefixing the label
  // with the bulb name produced rows reading "Salon - Salon - brightness".
  assert.equal(featureName({ key: FEATURE_KEYS.BRIGHTNESS }), 'Brightness');
  assert.equal(featureName({ key: FEATURE_KEYS.TEMPERATURE }), 'Colour temperature');
  assert.equal(featureName({ key: FEATURE_KEYS.POWER }), 'On/Off');
});

test('a bulb with an ambient light says which light each feature drives', () => {
  // On a ceiling light with an ambient ring, two features called "Colour" side
  // by side are unusable.
  const options = { hasAmbient: true };
  assert.equal(featureName({ key: FEATURE_KEYS.BRIGHTNESS }, options), 'Main brightness');
  assert.equal(featureName({ key: FEATURE_KEYS.POWER }, options), 'Main light');
  assert.equal(
    featureName({ key: FEATURE_KEYS.BACKGROUND_BRIGHTNESS }, options),
    'Ambient brightness',
  );
  assert.equal(featureName({ key: FEATURE_KEYS.BACKGROUND_COLOR }, options), 'Ambient colour');
});

test('a ceiling light with a tunable ambient ring exposes its temperature', () => {
  // mutmut's ceiling10 advertises bg_set_ct_abx: the Yeelight app offers a
  // warm/cold slider on the ring, independent of the main light, and nothing in
  // Gladys drove it before.
  const features = describeBulb({
    model: 'ceiling10',
    support:
      'get_prop set_power set_bright set_ct_abx bg_set_power bg_set_bright bg_set_rgb bg_set_ct_abx',
  });
  const keys = features.map((feature) => feature.key);
  assert.ok(keys.includes(FEATURE_KEYS.BACKGROUND_TEMPERATURE));

  const ambient = features.find((f) => f.key === FEATURE_KEYS.BACKGROUND_TEMPERATURE);
  // Mired, like the main one, and inside the ceiling range (2700-6500K).
  assert.deepEqual({ min: ambient.min, max: ambient.max }, { min: 154, max: 370 });
  assert.equal(featureName(ambient, { hasAmbient: true }), 'Ambient colour temperature');
});

test('a ring that cannot tune its white gets no temperature feature', () => {
  const features = describeBulb({
    model: 'ceiling1',
    support: 'get_prop set_power set_bright bg_set_power bg_set_rgb',
  });
  assert.ok(!features.some((feature) => feature.key === FEATURE_KEYS.BACKGROUND_TEMPERATURE));
});
