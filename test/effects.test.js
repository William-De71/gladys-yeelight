import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectScene, EFFECTS } from '../src/yeelight/effects.js';

const COLOR = { color: true, kelvin: { min: 1700, max: 6500 } };
const WHITE = { color: false, kelvin: { min: 2700, max: 6500 } };

/**
 * Parse the flow string of a `set_scene cf` call.
 * @param {string} flow - `duration,mode,value,brightness,...`.
 * @returns {number[][]} The steps.
 */
function steps(flow) {
  const numbers = flow.split(',').map(Number);
  const out = [];
  for (let i = 0; i < numbers.length; i += 4) {
    out.push(numbers.slice(i, i + 4));
  }
  return out;
}

test('every effect builds a valid flow, in colour and in white', () => {
  for (const effect of EFFECTS) {
    for (const lamp of [COLOR, WHITE]) {
      const [kind, count, action, flow] = effectScene(effect, lamp);
      assert.equal(kind, 'cf');
      assert.ok(Number.isInteger(count) && count >= 0, `${effect} count`);
      assert.ok([0, 1, 2].includes(action), `${effect} action`);
      for (const [duration, mode, value, brightness] of steps(flow)) {
        assert.ok(duration >= 50, `${effect}: step of ${duration} ms`);
        assert.ok([1, 2, 7].includes(mode), `${effect}: mode ${mode}`);
        assert.ok(brightness >= 1 && brightness <= 100, `${effect}: brightness ${brightness}`);
        if (mode === 2) {
          assert.ok(value >= lamp.kelvin.min && value <= lamp.kelvin.max, `${effect}: ${value} K`);
        }
        if (lamp === WHITE) {
          assert.notEqual(mode, 1, `${effect}: no RGB step on a white lamp`);
        }
      }
    }
  }
});

test('sunrise lasts the requested minutes and stays on, sunset ends off', () => {
  const [, , stays, sunrise] = effectScene('sunrise', { ...COLOR, minutes: 20 });
  const total = steps(sunrise).reduce((sum, [duration]) => sum + duration, 0);
  assert.equal(total, 20 * 60 * 1000);
  assert.equal(stays, 1);
  assert.equal(effectScene('sunset', COLOR)[2], 2);
});

test('the duration is clamped to 1-60 minutes', () => {
  const total = (minutes) =>
    steps(effectScene('sunrise', { ...COLOR, minutes })[3]).reduce((sum, [d]) => sum + d, 0);
  assert.equal(total(0), 15 * 60 * 1000, 'empty field = default');
  assert.equal(total(500), 60 * 60 * 1000);
  assert.equal(total(0.2), 60 * 1000);
});

test('an alert on a light that was off turns it back off, on one that was on restores it', () => {
  assert.equal(effectScene('alert', { ...COLOR, wasOn: false })[2], 2);
  assert.equal(effectScene('alert', { ...COLOR, wasOn: true })[2], 0);
  assert.equal(effectScene('notify', { ...COLOR, wasOn: false })[2], 2);
});

test('the candle runs until it is stopped', () => {
  assert.equal(effectScene('candle', COLOR)[1], 0);
});

test('an unknown effect is refused', () => {
  assert.throws(() => effectScene('disco', COLOR), /Unknown effect "disco"/);
});
