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
 * Split a free-text field into trimmed, non-empty lines.
 * @param {unknown} raw - The raw field value.
 * @returns {string[]} The meaningful lines.
 * @example
 * splitLines('192.168.1.4\n\n 192.168.1.5 '); // ['192.168.1.4', '192.168.1.5']
 */
function splitLines(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Parse the "bulbs added by hand" field: one address per line, with an optional
 * `:port`. Used for the bulbs the discovery cannot reach — another VLAN, or a
 * router that drops multicast.
 * @param {unknown} raw - The raw field value.
 * @returns {Array<{ host: string, port: number }>} The manual bulbs.
 * @example
 * parseBulbs('192.168.1.42\n192.168.1.43:55443');
 */
export function parseBulbs(raw) {
  return splitLines(raw)
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
