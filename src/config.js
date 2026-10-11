// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user-facing values come from the `config_schema` of the manifest; the SDK
// fetches them (`gladys.getConfig()`) and notifies changes through
// `gladys.onConfigUpdated()`.
//
// This module provides the defaults, normalizes the received object (a numeric
// field arrives as a string from the form) and parses the one free-text field
// the manifest cannot express structurally: the bulbs added by hand.
// -----------------------------------------------------------------------------

import { DEFAULT_CONTROL_PORT } from './yeelight/constants.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a test pins this).
export const DEFAULT_CONFIG = {
  scan_duration: 5, // seconds the core listens for discovery replies
  transition_duration: 500, // ms of the smooth fade applied to every change
};

// Bounds of the numeric fields, the same `min`/`max` as the manifest (a test
// pins this). The form enforces them, but a value set through the API or left
// over from an older manifest does not go through the form.
export const CONFIG_BOUNDS = {
  scan_duration: { min: 3, max: 30 },
  transition_duration: { min: 0, max: 5000 },
};

/**
 * Read one numeric field: the default when it is blank or not a number, the
 * nearest bound when it is out of range.
 *
 * A blank field is the trap this exists for. The form posts an emptied number
 * input as `''`, and `Number('')` is 0 — a scan listening for 0 seconds finds
 * no lamp at all, and nothing tells the user why.
 * @param {unknown} raw - The raw field value.
 * @param {string} key - The field key, in DEFAULT_CONFIG and CONFIG_BOUNDS.
 * @returns {number} A usable value.
 */
function readNumber(raw, key) {
  const fallback = DEFAULT_CONFIG[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const { min, max } = CONFIG_BOUNDS[key];
  return Math.min(max, Math.max(min, number));
}

/**
 * Split a free-text field into trimmed, non-empty entries.
 *
 * Commas and semicolons separate as well as newlines, deliberately: the manifest
 * renders this as a single-line input, where a newline cannot be typed at all.
 * Accepting only newlines meant a user with two hand-declared lamps had no way
 * to enter the second one.
 *
 * A colon is NOT a separator — it introduces the optional `:port`, and an IPv6
 * literal is full of them.
 * @param {unknown} raw - The raw field value.
 * @returns {string[]} The meaningful entries.
 * @example
 * splitEntries('192.168.1.4, 192.168.1.5'); // ['192.168.1.4', '192.168.1.5']
 */
function splitEntries(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[\r\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse one `host[:port]` address.
 *
 * An IPv6 literal must be written in brackets (`[fe80::1]:55443`), as in a URL:
 * it is full of colons, so a bare one cannot tell its last group from a port.
 * The brackets are stripped from the result, since the socket wants the bare
 * address.
 * @param {string} entry - The address.
 * @returns {{ host: string, port: number }|null} The parsed address, or null.
 * @example
 * parseAddress('[fe80::1]:55443'); // { host: 'fe80::1', port: 55443 }
 */
export function parseAddress(entry) {
  const text = String(entry || '').trim();
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  const match = bracketed || /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) {
    return null;
  }
  const host = match[1].trim();
  if (!host) {
    return null;
  }
  const port = match[2] ? Number(match[2]) : DEFAULT_CONTROL_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

/**
 * Write an address back in the `host:port` form `parseAddress` reads, with the
 * brackets an IPv6 literal needs.
 * @param {string} host - The host.
 * @param {number} [port] - The control port.
 * @returns {string} The address.
 * @example
 * formatAddress('fe80::1', 55443); // '[fe80::1]:55443'
 */
export function formatAddress(host, port = DEFAULT_CONTROL_PORT) {
  return String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Parse the "bulbs added by hand" field: addresses separated by a comma, a
 * semicolon or a newline, each with an optional `:port`. Used for the bulbs the
 * discovery cannot reach — another VLAN, or a router that drops multicast.
 * @param {unknown} raw - The raw field value.
 * @returns {Array<{ host: string, port: number }>} The manual bulbs.
 * @example
 * parseBulbs('192.168.1.42, 192.168.1.43:55443');
 */
export function parseBulbs(raw) {
  return splitEntries(raw)
    .map(parseAddress)
    .filter((bulb) => bulb !== null);
}

/**
 * Merge the user config with the defaults, bound the numeric fields and parse
 * the free-text field.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized configuration.
 * @example
 * const config = normalizeConfig(await gladys.getConfig());
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    scan_duration: readNumber(raw.scan_duration, 'scan_duration'),
    transition_duration: readNumber(raw.transition_duration, 'transition_duration'),
    bulbs: parseBulbs(raw.bulbs),
  };
}
