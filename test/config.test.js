import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  parseBulbs,
  parseAddress,
  formatAddress,
  DEFAULT_CONFIG,
  CONFIG_BOUNDS,
} from '../src/config.js';

test('an empty config yields the documented defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.scan_duration, DEFAULT_CONFIG.scan_duration);
  assert.equal(config.transition_duration, DEFAULT_CONFIG.transition_duration);
  assert.deepEqual(config.bulbs, []);
});

test('numeric fields arriving as strings from the form are converted', () => {
  // The Configuration screen posts everything as text.
  const config = normalizeConfig({ scan_duration: '12', transition_duration: '300' });
  assert.equal(config.scan_duration, 12);
  assert.equal(config.transition_duration, 300);
});

test('hand-declared bulbs are parsed one per line, with an optional port', () => {
  assert.deepEqual(parseBulbs('192.168.1.42\n192.168.1.43:55444'), [
    { host: '192.168.1.42', port: 55443 },
    { host: '192.168.1.43', port: 55444 },
  ]);
});

test('blank lines and stray spaces are tolerated', () => {
  // Users paste from a terminal or a notes file.
  assert.deepEqual(parseBulbs('\n  192.168.1.42  \n\n'), [{ host: '192.168.1.42', port: 55443 }]);
});

test('a hostname is accepted, not only an IP address', () => {
  assert.deepEqual(parseBulbs('lamp.local'), [{ host: 'lamp.local', port: 55443 }]);
});

test('an out-of-range port is dropped rather than sent to the socket', () => {
  assert.deepEqual(parseBulbs('192.168.1.42:99999'), []);
});

test('a non-string field yields no bulb', () => {
  assert.deepEqual(parseBulbs(undefined), []);
  assert.deepEqual(parseBulbs(42), []);
});

test('several lights fit in the single-line field the manifest renders', () => {
  // The field is a plain `string` input: a newline cannot be typed into it, so a
  // user with two hand-declared lamps needs a separator they can actually enter.
  const expected = [
    { host: '192.168.0.200', port: 55443 },
    { host: '192.168.0.201', port: 55444 },
  ];
  assert.deepEqual(parseBulbs('192.168.0.200, 192.168.0.201:55444'), expected);
  assert.deepEqual(parseBulbs('192.168.0.200;192.168.0.201:55444'), expected);
  // Newlines keep working for anyone who pasted a list.
  assert.deepEqual(parseBulbs('192.168.0.200\n192.168.0.201:55444'), expected);
  // Mixed separators and stray whitespace collapse the same way.
  assert.deepEqual(parseBulbs(' 192.168.0.200 ,, 192.168.0.201:55444 '), expected);
});

test('a colon still introduces the port, never a new address', () => {
  // Splitting on ':' would have torn "192.168.0.200:55443" into two bogus hosts.
  assert.deepEqual(parseBulbs('192.168.0.200:55443'), [{ host: '192.168.0.200', port: 55443 }]);
});

test('a numeric field emptied in the form falls back to its default', () => {
  // `Number('')` is 0: a scan listening for 0 seconds finds no lamp at all.
  const config = normalizeConfig({ scan_duration: '', transition_duration: '  ' });
  assert.equal(config.scan_duration, DEFAULT_CONFIG.scan_duration);
  assert.equal(config.transition_duration, DEFAULT_CONFIG.transition_duration);
  assert.equal(normalizeConfig({ scan_duration: 'abc' }).scan_duration, 5);
});

test('a numeric field out of the manifest range is brought back into it', () => {
  const config = normalizeConfig({ scan_duration: 1, transition_duration: 60000 });
  assert.equal(config.scan_duration, CONFIG_BOUNDS.scan_duration.min);
  assert.equal(config.transition_duration, CONFIG_BOUNDS.transition_duration.max);
});

test('an IPv6 address is written in brackets and reaches the socket without them', () => {
  assert.deepEqual(parseBulbs('[fe80::1]:55444, [fe80::2]'), [
    { host: 'fe80::1', port: 55444 },
    { host: 'fe80::2', port: 55443 },
  ]);
  // Bare, its last group could not be told from a port.
  assert.deepEqual(parseBulbs('fe80::1'), []);
});

test('an address written back on a device reads back identically', () => {
  for (const [host, port] of [
    ['192.168.1.42', 55443],
    ['fe80::1', 55444],
    ['lamp.local', 1234],
  ]) {
    assert.deepEqual(parseAddress(formatAddress(host, port)), { host, port });
  }
});
