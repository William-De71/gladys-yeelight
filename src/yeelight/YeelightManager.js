// -----------------------------------------------------------------------------
// Connection manager: one live connection per bulb.
//
// Yeelight has no hub — every bulb is an independent TCP peer that PUSHES its
// state changes. That shapes the design:
//
//   - one YeelightClient per bulb, kept OPEN (not a request/response client);
//   - state arrives unsolicited, forwarded to a callback (see devices.js);
//   - reconnection is ours to handle: a lamp cut at the wall switch is normal,
//     so it backs off exponentially instead of hammering the network.
//
// This module owns connections and nothing else: no Gladys SDK, no feature
// mapping. It speaks Yeelight and reports what happens through callbacks.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { YeelightClient } from './YeelightClient.js';
import {
  DEFAULT_CONTROL_PORT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from './constants.js';

const logger = createLogger({ name: 'yeelight-manager' });

/**
 * Manages the live connections to the Yeelight bulbs.
 * @example
 * const manager = new YeelightManager();
 * manager.onProps((bulbId, props) => { ... });
 */
export class YeelightManager {
  constructor() {
    /** @type {Map<string, YeelightClient>} */
    this.clients = new Map();
    /** @type {Map<string, { host: string, port: number }>} */
    this.addresses = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.reconnectTimers = new Map();
    /** @type {Map<string, number>} */
    this.reconnectDelays = new Map();
    // Connections being opened, shared by concurrent callers. After a restart a
    // poll, a command and the startup refresh can all reach the same bulb at
    // once; without this each opened its own socket, the last one replaced the
    // others in `clients`, and the orphans kept holding one of the bulb's 4
    // connection slots until the lamp itself dropped them.
    /** @type {Map<string, Promise<YeelightClient>>} */
    this.connecting = new Map();
    /** @type {Function|null} */
    this.propsCallback = null;
    /** @type {Function|null} */
    this.connectionCallback = null;
    // Set on shutdown so a socket closing during teardown does not schedule a
    // reconnection that would keep the process alive.
    this.stopped = false;
  }

  /**
   * Register the callback receiving the state pushed by the bulbs.
   * @param {Function} callback - `(bulbId, props) => void`.
   * @returns {void}
   */
  onProps(callback) {
    this.propsCallback = callback;
  }

  /**
   * Register the callback receiving the reachability changes.
   * @param {Function} callback - `(bulbId, connected) => void`.
   * @returns {void}
   */
  onConnectionChange(callback) {
    this.connectionCallback = callback;
  }

  /**
   * Connect to a bulb, or return the connection already open for it.
   *
   * Reusing the open connection is not just an optimisation: a bulb accepts
   * only 4 simultaneous connections, and opening a new one per command would
   * lock everyone else out within seconds.
   * @param {object} bulb - `{ id, host, port }`.
   * @returns {Promise<YeelightClient>} The connected client.
   * @example
   * const client = await manager.connect({ id: '0x1', host: '192.168.1.239' });
   */
  connect(bulb) {
    const existing = this.clients.get(bulb.id);
    if (existing && existing.connected) {
      return Promise.resolve(existing);
    }
    const pending = this.connecting.get(bulb.id);
    if (pending) {
      return pending;
    }

    const attempt = this.openConnection(bulb).finally(() => {
      this.connecting.delete(bulb.id);
    });
    this.connecting.set(bulb.id, attempt);
    return attempt;
  }

  /**
   * Open a new connection to a bulb. Only `connect` calls this, so that two
   * callers never race to open two sockets to the same lamp.
   * @param {object} bulb - `{ id, host, port }`.
   * @returns {Promise<YeelightClient>} The connected client.
   */
  async openConnection(bulb) {
    const port = bulb.port || DEFAULT_CONTROL_PORT;
    this.addresses.set(bulb.id, { host: bulb.host, port });

    const client = new YeelightClient({ host: bulb.host, port });

    client.on('props', (props) => {
      if (this.propsCallback) {
        this.propsCallback(bulb.id, props);
      }
    });

    client.on('disconnect', () => {
      logger.info(`Yeelight bulb "${bulb.id}" disconnected`);
      this.clients.delete(bulb.id);
      if (this.connectionCallback) {
        this.connectionCallback(bulb.id, false);
      }
      this.scheduleReconnect(bulb.id);
    });

    await client.connect();

    // A shutdown that started while the socket was opening must not be undone
    // by it: the client would hold a slot on the bulb and keep the process up.
    if (this.stopped) {
      client.removeAllListeners('disconnect');
      client.disconnect();
      throw new Error(`Yeelight manager stopped while connecting to "${bulb.id}"`);
    }

    this.clients.set(bulb.id, client);
    // A successful connection resets the backoff, so the next outage starts
    // from a short delay again.
    this.reconnectDelays.delete(bulb.id);
    this.clearReconnect(bulb.id);

    logger.info(`Connected to Yeelight bulb "${bulb.id}" (${bulb.host}:${port})`);
    if (this.connectionCallback) {
      this.connectionCallback(bulb.id, true);
    }
    return client;
  }

  /**
   * Schedule a reconnection with exponential backoff.
   *
   * A bulb switched off at the wall is unreachable for hours, and retrying it
   * every five seconds forever would be pure noise on the network and in the
   * logs — hence the cap at RECONNECT_MAX_DELAY_MS.
   * @param {string} bulbId - The bulb id.
   * @returns {void}
   */
  scheduleReconnect(bulbId) {
    if (this.stopped || this.reconnectTimers.has(bulbId)) {
      return;
    }
    const address = this.addresses.get(bulbId);
    if (!address) {
      return;
    }

    const delay = this.reconnectDelays.get(bulbId) || RECONNECT_INITIAL_DELAY_MS;
    this.reconnectDelays.set(bulbId, Math.min(delay * 2, RECONNECT_MAX_DELAY_MS));

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(bulbId);
      this.connect({ id: bulbId, ...address }).catch((e) => {
        logger.debug(`Reconnection to "${bulbId}" failed: ${e.message}`);
        this.scheduleReconnect(bulbId);
      });
    }, delay);

    // Do not hold the event loop open just to retry a lamp.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimers.set(bulbId, timer);
  }

  /**
   * Cancel a pending reconnection.
   * @param {string} bulbId - The bulb id.
   * @returns {void}
   */
  clearReconnect(bulbId) {
    const timer = this.reconnectTimers.get(bulbId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(bulbId);
    }
  }

  /**
   * Get the open client of a bulb, if any.
   * @param {string} bulbId - The bulb id.
   * @returns {YeelightClient|undefined} The client, or undefined.
   */
  getClient(bulbId) {
    const client = this.clients.get(bulbId);
    return client && client.connected ? client : undefined;
  }

  /**
   * Send a command to a bulb, connecting first when needed.
   * @param {string} bulbId - The bulb id.
   * @param {string} method - The Yeelight method.
   * @param {Array} params - The method parameters.
   * @returns {Promise<Array>} The result array.
   * @example
   * await manager.command('0x1', 'set_power', ['on', 'smooth', 500]);
   */
  async command(bulbId, method, params) {
    const client = await this.ensureClient(bulbId);
    return client.command(method, params);
  }

  /**
   * Get the open client of a bulb, connecting to its last known address when
   * the session is down.
   *
   * What matters is that EVERY caller goes through here, not only `command`:
   * the power check that precedes a colour command used to give up on a bulb
   * that was not connected yet, so the colour then reached a lamp that was off
   * and was refused.
   * @param {string} bulbId - The bulb id.
   * @returns {Promise<YeelightClient>} The connected client.
   * @example
   * const client = await manager.ensureClient('0x1');
   */
  async ensureClient(bulbId) {
    const client = this.getClient(bulbId);
    if (client) {
      return client;
    }
    const address = this.addresses.get(bulbId);
    if (!address) {
      throw new Error(`Yeelight bulb "${bulbId}" has no known address`);
    }
    return this.connect({ id: bulbId, ...address });
  }

  /**
   * Remember the address of a bulb without connecting to it, so a later command
   * or reconnection knows where to reach it.
   *
   * `ifUnknown` is for the address stored on a Gladys device: it is only a
   * fallback, and must never override a fresher one learnt from a scan.
   * @param {object} bulb - `{ id, host, port }`.
   * @param {object} [options] - Options.
   * @param {boolean} [options.ifUnknown] - Keep the address already known, if any.
   * @returns {void}
   */
  rememberAddress(bulb, { ifUnknown = false } = {}) {
    if (ifUnknown && this.addresses.has(bulb.id)) {
      return;
    }
    this.addresses.set(bulb.id, {
      host: bulb.host,
      port: bulb.port || DEFAULT_CONTROL_PORT,
    });
  }

  /**
   * Close every connection, freeing the bulbs' connection slots right away.
   *
   * `permanent` distinguishes the two callers, and getting it wrong is a real
   * bug: a shutdown must NOT schedule reconnections (they would keep the
   * process alive), while a reconfigure must stay able to reconnect right
   * after — so it only drops the sockets and leaves the manager usable.
   * @param {object} [options] - Options.
   * @param {boolean} [options.permanent] - True on shutdown.
   * @returns {Promise<void>} Resolves once everything is closed.
   * @example
   * await manager.disconnectAll({ permanent: true });
   */
  async disconnectAll({ permanent = false } = {}) {
    // Set BEFORE closing the sockets: each `close` fires the disconnect
    // handler, which would otherwise schedule a reconnection for every bulb.
    this.stopped = true;
    this.reconnectTimers.forEach((timer) => clearTimeout(timer));
    this.reconnectTimers.clear();
    this.reconnectDelays.clear();
    this.clients.forEach((client) => client.disconnect());
    this.clients.clear();

    if (!permanent) {
      // Let the close events settle before re-arming, so none of them lands
      // after the flag is cleared and revives a connection we just dropped.
      await new Promise((resolve) => setImmediate(resolve));
      this.stopped = false;
    }
  }
}
