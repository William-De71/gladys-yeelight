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

  const [temperature] = describeBulb({ model: 'ceiling1', support: 'set_ct_abx' }).filter(
    (feature) => feature.key === FEATURE_KEYS.TEMPERATURE,
  );
  assert.equal(temperature.min, 2700);
  assert.equal(temperature.unit, 'kelvin');
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

test('feature names are readable in the Gladys UI', () => {
  assert.equal(featureName('Salon', { key: FEATURE_KEYS.BRIGHTNESS }), 'Salon - brightness');
  assert.equal(
    featureName('Salon', { key: FEATURE_KEYS.TEMPERATURE }),
    'Salon - color temperature',
  );
});
