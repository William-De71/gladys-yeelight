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
    .map((line) => {
      // An IPv6 literal is written [::1]:55443, so only split on a trailing
      // `:port` and only when what follows is a number.
      const match = /^(.*?)(?::(\d{1,5}))?$/.exec(line);
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
    })
    .filter((bulb) => bulb !== null);
}

/**
 * Merge the user config with the defaults, force the numeric types and parse
 * the free-text field.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized configuration.
 * @example
 * const config = normalizeConfig(await gladys.getConfig());
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    scan_duration: Number(raw.scan_duration ?? DEFAULT_CONFIG.scan_duration),
    transition_duration: Number(raw.transition_duration ?? DEFAULT_CONFIG.transition_duration),
    bulbs: parseBulbs(raw.bulbs),
  };
}
