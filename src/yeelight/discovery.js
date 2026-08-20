// -----------------------------------------------------------------------------
// Bulb discovery on the local network.
//
// Yeelight uses an SSDP-LIKE protocol, not SSDP: same message shapes, but on
// port 1982 with `ST: wifi_bulb`. The core's generic `ssdp` scanner listens on
// 1900 and would never see a bulb, so discovery goes through the
// `udp-active-broadcast` capture instead: WE forge the M-SEARCH, the core
// broadcasts it from the host network (a bridge container cannot) and relays
// the raw unicast replies.
//
// The replies are HTTP-style header blocks. Every field this module extracts is
// documented in section 3.1 of the spec, and the useful ones (id, model,
// support, and the whole initial state) all arrive in that single datagram —
// which is why a scan alone is enough to build a complete device, with no TCP
// round-trip needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  DISCOVERY_MULTICAST_ADDRESS,
  DISCOVERY_PORT,
  DISCOVERY_ST,
  DISCOVERY_TIMEOUT_SECONDS,
  DEFAULT_CONTROL_PORT,
  MESSAGE_TERMINATOR,
} from './constants.js';

const logger = createLogger({ name: 'yeelight-discovery' });

/**
 * Build the M-SEARCH datagram the bulbs answer to.
 *
 * The spec is strict about this message and drops anything malformed silently:
 * the start line carries no leading whitespace, `MAN` keeps its double quotes,
 * `ST` is exactly `wifi_bulb`, and every line ends with CRLF. A bulb that never
 * answers is the only feedback, so this function is deliberately literal.
 * @returns {Buffer} The datagram to broadcast on port 1982.
 * @example
 * const payload = buildDiscoveryRequest();
 */
export function buildDiscoveryRequest() {
  const lines = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${DISCOVERY_MULTICAST_ADDRESS}:${DISCOVERY_PORT}`,
    'MAN: "ssdp:discover"',
    `ST: ${DISCOVERY_ST}`,
  ];
  return Buffer.from(lines.join(MESSAGE_TERMINATOR) + MESSAGE_TERMINATOR, 'utf8');
}

/**
 * Parse one raw reply (search response or advertisement) into a bulb
 * descriptor.
 *
 * Accepts both the `HTTP/1.1 200 OK` search response and the `NOTIFY`
 * advertisement: the spec gives them identical Yeelight headers, so refusing
 * the advertisement would discard a perfectly usable announcement.
 * @param {string|Buffer} raw - The raw datagram payload.
 * @returns {object|null} The bulb descriptor, or null when the reply is not one.
 * @example
 * parseDiscoveryReply('HTTP/1.1 200 OK\r\nid: 0x1\r\nLocation: yeelight://192.168.1.2:55443\r\n');
 */
export function parseDiscoveryReply(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const lines = text.split(/\r?\n/);

  const startLine = (lines.shift() || '').trim();
  // Only these two shapes carry bulb state. Anything else on this port is not
  // ours to interpret.
  if (
    !/^HTTP\/1\.1\s+200\s+OK$/i.test(startLine) &&
    !/^NOTIFY\s+\*\s+HTTP\/1\.1$/i.test(startLine)
  ) {
    return null;
  }

  /** @type {Record<string, string>} */
  const headers = {};
  lines.forEach((line) => {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return;
    }
    // Header NAMES are case-insensitive per the spec; values are not, so only
    // the name is lower-cased.
    const name = line.slice(0, separator).trim().toLowerCase();
    headers[name] = line.slice(separator + 1).trim();
  });

  // The id is what identifies a bulb for good: without it there is nothing
  // stable to build an external id on, so such a reply is unusable.
  const id = headers.id;
  if (!id) {
    return null;
  }

  const location = parseLocation(headers.location);
  if (!location) {
    return null;
  }

  return {
    id,
    host: location.host,
    port: location.port,
    model: headers.model || '',
    firmwareVersion: headers.fw_ver || '',
    support: headers.support || '',
    name: headers.name || '',
    // The reply already carries the full state, so a freshly discovered bulb
    // can be published with real values instead of blanks.
    state: {
      power: headers.power,
      bright: headers.bright,
      color_mode: headers.color_mode,
      ct: headers.ct,
      rgb: headers.rgb,
      hue: headers.hue,
      sat: headers.sat,
    },
  };
}

/**
 * Parse the `Location: yeelight://<ip>:<port>` header.
 *
 * Hand-rolled rather than `new URL()`: the `yeelight://` scheme is not one
 * WHATWG URL parsing gives a hostname for in every runtime, and the format is
 * fixed by the spec anyway.
 * @param {string|undefined} location - The raw Location header.
 * @returns {{ host: string, port: number }|null} The control endpoint.
 * @example
 * parseLocation('yeelight://192.168.1.239:55443');
 */
export function parseLocation(location) {
  const match = /^yeelight:\/\/([^:/]+)(?::(\d{1,5}))?/i.exec(String(location || '').trim());
  if (!match) {
    return null;
  }
  const host = match[1];
  const port = match[2] ? Number(match[2]) : DEFAULT_CONTROL_PORT;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

/**
 * Run a mediated scan and return the bulbs that answered, de-duplicated by id.
 *
 * A bulb can answer more than once (the core relays every datagram it caught,
 * and bulbs also advertise spontaneously); the LAST reply wins, since it
 * carries the freshest address and state.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {number} [timeoutSeconds] - How long the core listens.
 * @returns {Promise<object[]>} The discovered bulbs.
 * @example
 * const bulbs = await discoverBulbs(gladys);
 */
export async function discoverBulbs(gladys, timeoutSeconds = DISCOVERY_TIMEOUT_SECONDS) {
  let replies;
  try {
    replies = await gladys.scanNetwork('udp-active-broadcast', {
      port: DISCOVERY_PORT,
      payload: buildDiscoveryRequest(),
      timeoutSeconds,
    });
  } catch (e) {
    // A 403 means the installed integration predates the `network_discovery`
    // declaration in its manifest. Staying silent here would hide the reason
    // why no bulb is ever found.
    if (e.status === 403) {
      logger.warn(
        'Gladys refused the network scan: the installed integration predates its "network_discovery" declaration. Reinstall the integration to pick up the new manifest.',
      );
    } else if (e.status === 429) {
      logger.warn('Network scan rate-limited by Gladys (1 scan per 10 s), try again shortly.');
    } else {
      logger.warn(`The network scan failed: ${e.message}`);
    }
    return [];
  }

  /** @type {Map<string, object>} */
  const bulbs = new Map();
  (replies || []).forEach((reply) => {
    try {
      const bulb = parseDiscoveryReply(Buffer.from(reply.payload_base64, 'base64'));
      if (!bulb) {
        return;
      }
      // The Location header is authoritative for the control port, but the IP
      // the datagram actually came from is the one that is reachable right now
      // — they differ on a bulb whose lease changed since it last advertised.
      bulbs.set(bulb.id, { ...bulb, host: reply.source_ip || bulb.host });
    } catch (e) {
      logger.debug(`Unreadable discovery reply: ${e.message}`);
    }
  });

  logger.info(`Yeelight discovery: ${bulbs.size} bulb(s) answered`);
  return [...bulbs.values()];
}
