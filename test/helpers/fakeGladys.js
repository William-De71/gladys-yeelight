// Minimal stand-in for the Gladys SDK instance, exposing only what the modules
// under test call. Keeping it tiny is deliberate: a fake that mirrors the whole
// SDK would pass even when the real contract changed.

/**
 * Build a fake Gladys SDK instance.
 * @param {object} [options] - Options.
 * @param {string} [options.selector] - The integration selector.
 * @param {Array} [options.devices] - The devices the user "created".
 * @param {Array|Error} [options.scanResults] - What the network scan returns.
 * @returns {object} The fake instance, with a `published` log for assertions.
 * @example
 * const gladys = fakeGladys({ scanResults: [{ payload_base64: '...' }] });
 */
export function fakeGladys({ selector = 'ext-dev-yeelight', devices = [], scanResults } = {}) {
  const published = { states: [], devices: [], transports: [] };
  const scans = [];

  return {
    selector,
    devices,
    published,
    scans,
    externalId: (suffix) => `ext:${selector}:${suffix}`,
    externalIds: (type, platformId) => {
      const device = `ext:${selector}:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },
    scanNetwork: async (type, options) => {
      scans.push({ type, options });
      if (scanResults instanceof Error) {
        throw scanResults;
      }
      return scanResults || [];
    },
    publishStates: async (states) => {
      published.states.push(...states);
    },
    publishDiscoveredDevices: async (list) => {
      published.devices = list;
    },
    publishTransports: async (transports) => {
      published.transports.push(...transports);
    },
  };
}

/**
 * Build the base64 payload of a discovery reply, as the core relays it.
 * @param {object} [overrides] - Headers to override or add.
 * @returns {string} The base64-encoded datagram.
 * @example
 * const payload = discoveryPayload({ id: '0x42', model: 'ceiling1' });
 */
export function discoveryPayload(overrides = {}) {
  const headers = {
    'Cache-Control': 'max-age=3600',
    Location: 'yeelight://192.168.1.239:55443',
    Server: 'POSIX UPnP/1.0 YGLC/1',
    id: '0x000000000015243f',
    model: 'color',
    fw_ver: '18',
    support: 'get_prop set_default set_power toggle set_bright set_ct_abx set_rgb',
    power: 'on',
    bright: '100',
    color_mode: '2',
    ct: '4000',
    rgb: '16711680',
    name: '',
    ...overrides,
  };
  const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  const message = ['HTTP/1.1 200 OK', ...lines].join('\r\n') + '\r\n';
  return Buffer.from(message, 'utf8').toString('base64');
}
