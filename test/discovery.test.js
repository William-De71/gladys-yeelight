import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryRequest,
  parseDiscoveryReply,
  parseLocation,
  discoverBulbs,
} from '../src/yeelight/discovery.js';
import { fakeGladys, discoveryPayload } from './helpers/fakeGladys.js';

test('the M-SEARCH is byte-for-byte the one the spec mandates', () => {
  // Yeelight silently drops anything malformed, so a bulb that never answers is
  // the only symptom of a typo here. Worth pinning literally.
  assert.equal(
    buildDiscoveryRequest().toString('utf8'),
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n',
  );
});

test('a search response is parsed into a bulb descriptor', () => {
  const bulb = parseDiscoveryReply(Buffer.from(discoveryPayload(), 'base64'));
  assert.equal(bulb.id, '0x000000000015243f');
  assert.equal(bulb.host, '192.168.1.239');
  assert.equal(bulb.port, 55443);
  assert.equal(bulb.model, 'color');
  assert.equal(bulb.firmwareVersion, '18');
  // The reply already carries the state, so a fresh device has real values.
  assert.equal(bulb.state.power, 'on');
  assert.equal(bulb.state.bright, '100');
});

test('an advertisement (NOTIFY) is accepted like a search response', () => {
  // The spec gives both the same Yeelight headers; refusing NOTIFY would
  // discard a perfectly usable announcement.
  const notify =
    'NOTIFY * HTTP/1.1\r\nLocation: yeelight://10.0.0.5:55443\r\nid: 0x2\r\nNTS: ssdp:alive\r\n';
  const bulb = parseDiscoveryReply(notify);
  assert.equal(bulb.id, '0x2');
  assert.equal(bulb.host, '10.0.0.5');
});

test('a reply without an id or a location is rejected', () => {
  // Without an id there is nothing stable to build an external id on.
  assert.equal(parseDiscoveryReply('HTTP/1.1 200 OK\r\nLocation: yeelight://10.0.0.5:1\r\n'), null);
  assert.equal(parseDiscoveryReply('HTTP/1.1 200 OK\r\nid: 0x1\r\n'), null);
  assert.equal(parseDiscoveryReply('random garbage'), null);
  assert.equal(parseDiscoveryReply(''), null);
});

test('header names are case-insensitive, as the spec states', () => {
  const bulb = parseDiscoveryReply(
    'HTTP/1.1 200 OK\r\nID: 0x9\r\nLOCATION: yeelight://10.0.0.9:55443\r\nMODEL: mono\r\n',
  );
  assert.equal(bulb.id, '0x9');
  assert.equal(bulb.model, 'mono');
});

test('the Location header yields the control endpoint, with a default port', () => {
  assert.deepEqual(parseLocation('yeelight://192.168.1.239:55443'), {
    host: '192.168.1.239',
    port: 55443,
  });
  assert.deepEqual(parseLocation('yeelight://192.168.1.239'), {
    host: '192.168.1.239',
    port: 55443,
  });
  assert.equal(parseLocation('http://192.168.1.239'), null);
  assert.equal(parseLocation(undefined), null);
});

test('the scan is a udp-active-broadcast on port 1982', async () => {
  // Yeelight does NOT use standard SSDP (port 1900): a generic ssdp scan would
  // never see a bulb, which is the whole reason for this capture type.
  const gladys = fakeGladys({ scanResults: [] });
  await discoverBulbs(gladys, 7);
  assert.equal(gladys.scans.length, 1);
  assert.equal(gladys.scans[0].type, 'udp-active-broadcast');
  assert.equal(gladys.scans[0].options.port, 1982);
  assert.equal(gladys.scans[0].options.timeoutSeconds, 7);
});

test('bulbs answering several times are de-duplicated by id', async () => {
  const gladys = fakeGladys({
    scanResults: [
      { source_ip: '192.168.1.239', payload_base64: discoveryPayload() },
      { source_ip: '192.168.1.239', payload_base64: discoveryPayload({ bright: '20' }) },
      { source_ip: '192.168.1.50', payload_base64: discoveryPayload({ id: '0xB' }) },
    ],
  });
  const bulbs = await discoverBulbs(gladys);
  assert.equal(bulbs.length, 2);
  // The last reply wins: it carries the freshest state.
  assert.equal(bulbs.find((b) => b.id === '0x000000000015243f').state.bright, '20');
});

test('the source IP of the datagram wins over the Location header', async () => {
  // They differ when the bulb's DHCP lease changed since it last advertised;
  // the address the datagram actually came from is the reachable one.
  const gladys = fakeGladys({
    scanResults: [{ source_ip: '192.168.1.77', payload_base64: discoveryPayload() }],
  });
  const [bulb] = await discoverBulbs(gladys);
  assert.equal(bulb.host, '192.168.1.77');
});

test('a refused or rate-limited scan yields no bulb instead of throwing', async () => {
  // A scan the core refuses must not take the whole discovery down.
  for (const status of [403, 429, 500]) {
    const error = Object.assign(new Error('nope'), { status });
    const bulbs = await discoverBulbs(fakeGladys({ scanResults: error }));
    assert.deepEqual(bulbs, []);
  }
});
