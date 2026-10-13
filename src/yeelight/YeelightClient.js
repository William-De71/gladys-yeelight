// -----------------------------------------------------------------------------
// One live TCP connection to one bulb.
//
// The control protocol is line-delimited JSON over TCP (port 55443). Three
// message kinds share the socket, and telling them apart is the whole job of
// the read path:
//
//   COMMAND      -> {"id":1,"method":"set_power","params":["on","smooth",500]}
//   RESULT       -> {"id":1,"result":["ok"]}   or   {"id":1,"error":{...}}
//   NOTIFICATION -> {"method":"props","params":{"power":"on","bright":"10"}}
//
// A notification carries NO id: it is unsolicited, sent by the bulb whenever
// its state changes. That is what makes this a push integration — Gladys learns
// a light was dimmed from the wall switch without polling anything.
//
// Two quotas from the spec shape this class. A bulb accepts at most 4
// simultaneous connections, so we hold exactly one and reuse it; and it accepts
// 60 commands per minute per connection, past which it simply STOPS ANSWERING
// rather than returning an error. Commands are therefore queued and spaced,
// never fired concurrently.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  MESSAGE_TERMINATOR,
  MAX_COMMANDS_PER_MINUTE,
  RATE_WINDOW_MS,
  COMMAND_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  DEFAULT_CONTROL_PORT,
} from './constants.js';

const logger = createLogger({ name: 'yeelight-client' });

/**
 * A connection to a single Yeelight bulb.
 *
 * Emits:
 *   - `props`      : (object) a state change pushed by the bulb;
 *   - `connect`    : the socket is up;
 *   - `disconnect` : the socket went down.
 * @example
 * const client = new YeelightClient({ host: '192.168.1.239' });
 * client.on('props', (props) => console.log(props));
 * await client.connect();
 */
export class YeelightClient extends EventEmitter {
  /**
   * @param {object} options - Connection options.
   * @param {string} options.host - The bulb IP address.
   * @param {number} [options.port] - The control port.
   */
  constructor({ host, port = DEFAULT_CONTROL_PORT }) {
    super();
    this.host = host;
    this.port = port;
    /** @type {import('node:net').Socket|null} */
    this.socket = null;
    this.connected = false;
    // Incoming bytes not yet terminated by CRLF. TCP is a stream: one read can
    // hold half a message, or three of them.
    this.buffer = '';
    // Command id echoed back in the RESULT message, used to correlate.
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    // Serializes commands so two writes never interleave on the socket.
    this.queue = Promise.resolve();
    // Timestamps of the commands sent in the current window, oldest first. A
    // SLIDING WINDOW rather than a fixed delay: a scene that sets power, colour
    // and brightness at once must go out immediately (Gladys acks `onSetValue`
    // within 5 s), and only a genuine flood should ever wait.
    this.commandTimes = [];
    // Last known value of each property, fed by every source that carries one:
    // the pushed notifications, the `get_prop` replies and the commands we send.
    // It exists to spare the bulb a `get_prop` whose answer we already know —
    // the per-connection quota is 60 commands a minute, and a slider that
    // queried the power state before every step burned three of them per move.
    /** @type {Record<string, string>} */
    this.state = {};
    /** Last time the bulb sent anything (ms since the epoch). */
    this.lastSeen = 0;
  }

  /**
   * The last known value of one property, or undefined when it was never seen.
   *
   * Deliberately NOT a promise: a caller that cannot answer from the cache is
   * expected to fall back to `getProps`, which refreshes it.
   * @param {string} name - The property name.
   * @returns {string|undefined} The cached value.
   * @example
   * client.cached('power'); // 'on'
   */
  cached(name) {
    return this.state[name];
  }

  /**
   * Record property values into the cache.
   * @param {Record<string, string|number>} props - The properties to remember.
   * @returns {void}
   */
  remember(props) {
    Object.entries(props || {}).forEach(([name, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        this.state[name] = String(value);
      }
    });
  }

  /**
   * Open the connection.
   * @returns {Promise<void>} Resolves once the socket is up.
   * @example
   * await client.connect();
   */
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      // Only guards the CONNECT phase: removed below, otherwise it would kill
      // an idle-but-healthy connection, and idle is the normal state of a lamp.
      socket.setTimeout(CONNECT_TIMEOUT_MS);

      const onError = (err) => {
        socket.destroy();
        reject(err);
      };

      socket.once('error', onError);
      socket.once('timeout', () => onError(new Error(`Connection to ${this.host} timed out`)));

      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.off('error', onError);
        // Commands are small and latency-sensitive; Nagle would batch them.
        socket.setNoDelay(true);

        this.socket = socket;
        this.connected = true;
        this.lastSeen = Date.now();
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('error', (err) => {
          logger.debug(`Socket error on ${this.host}: ${err.message}`);
        });
        socket.on('close', () => this.handleClose());

        this.emit('connect');
        resolve();
      });
    });
  }

  /**
   * Feed raw bytes through the line framing and dispatch every complete message.
   * @param {string} chunk - The received bytes.
   * @returns {void}
   */
  handleData(chunk) {
    this.lastSeen = Date.now();
    this.buffer += chunk;

    let index = this.buffer.indexOf(MESSAGE_TERMINATOR);
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + MESSAGE_TERMINATOR.length);
      if (line.length > 0) {
        this.handleMessage(line);
      }
      index = this.buffer.indexOf(MESSAGE_TERMINATOR);
    }

    // A peer that never sends CRLF (or a corrupted stream) must not grow the
    // buffer without bound.
    if (this.buffer.length > 65536) {
      logger.warn(`Oversized buffer from ${this.host}, dropping it`);
      this.buffer = '';
    }
  }

  /**
   * Route one decoded message: a RESULT settles a pending command, a
   * NOTIFICATION is pushed to the listeners.
   * @param {string} line - One complete JSON message.
   * @returns {void}
   */
  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      logger.debug(`Unparseable message from ${this.host}: ${line}`);
      return;
    }

    // A notification has a method and no id. This is the push path.
    if (message.method === 'props' && message.params) {
      this.remember(message.params);
      this.emit('props', message.params);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(`Yeelight error ${message.error.code}: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  /**
   * Settle every in-flight command and report the drop.
   * @returns {void}
   */
  handleClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.buffer = '';
    // The lamp may be power-cycled while we are away, so nothing survives the
    // drop: a stale `power` would let a command skip the power-on it needed.
    this.state = {};

    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed before the bulb answered'));
    });
    this.pending.clear();

    if (wasConnected) {
      this.emit('disconnect');
    }
  }

  /**
   * Send a command and wait for its result.
   *
   * Calls are serialized and spaced by `COMMAND_MIN_INTERVAL_MS`: the bulb's
   * 60-per-minute quota is enforced by silence, not by an error, so pacing is
   * the only way to stay reliable under a burst.
   * @param {string} method - The Yeelight method name.
   * @param {Array} [params] - The method parameters.
   * @returns {Promise<Array>} The `result` array of the RESULT message.
   * @example
   * await client.command('set_power', ['on', 'smooth', 500]);
   */
  command(method, params = []) {
    const run = async () => {
      await this.awaitQuota();
      const result = await this.send(method, params);
      // Only once the bulb ACKED it: a command that failed changed nothing, and
      // caching its intent would make the next call skip a power-on it needed.
      this.rememberCommand(method, params);
      return result;
    };

    // Chain onto the queue, and keep the queue alive when a command rejects:
    // one failed command must not wedge every later one.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Fold an accepted command into the cache.
   *
   * Only the power state is tracked, and only for the two `set_power` families:
   * it is the single property read back before another command, so it is the
   * only one whose staleness would cost a round trip. The values a setter
   * carries (colour, brightness…) are left to the bulb's own push, which is
   * authoritative — a lamp clamps what it is given.
   * @param {string} method - The method that was accepted.
   * @param {Array} params - The parameters it was sent with.
   * @returns {void}
   */
  rememberCommand(method, params) {
    const power = params[0] === 'on' ? 'on' : params[0] === 'off' ? 'off' : undefined;
    if (power === undefined) {
      return;
    }
    if (method === 'set_power') {
      this.remember({ power });
    } else if (method === 'bg_set_power') {
      this.remember({ bg_power: power });
    }
  }

  /**
   * Block until the bulb's quota allows one more command.
   *
   * The spec caps a connection at 60 commands per minute and enforces it by
   * going SILENT, not by returning an error — an over-quota burst looks exactly
   * like a broken bulb. Waiting for the oldest command to leave the window is
   * what keeps that from ever happening, while leaving normal use unthrottled.
   * @returns {Promise<void>} Resolves when a slot is free.
   */
  async awaitQuota() {
    // Drop the timestamps that left the window.
    const cutoff = Date.now() - RATE_WINDOW_MS;
    this.commandTimes = this.commandTimes.filter((time) => time > cutoff);

    if (this.commandTimes.length >= MAX_COMMANDS_PER_MINUTE) {
      const wait = this.commandTimes[0] + RATE_WINDOW_MS - Date.now();
      if (wait > 0) {
        logger.warn(`Command quota reached for ${this.host}, holding ${wait} ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        return this.awaitQuota();
      }
      this.commandTimes.shift();
    }

    this.commandTimes.push(Date.now());
  }

  /**
   * Write one command on the socket and register its pending result.
   * @param {string} method - The Yeelight method name.
   * @param {Array} params - The method parameters.
   * @returns {Promise<Array>} The result array.
   */
  send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error(`Bulb ${this.host} is not connected`));
        return;
      }

      const id = this.nextId;
      // Stay inside the int range the bulb echoes back; a lamp left running for
      // months would otherwise reach Number.MAX_SAFE_INTEGER.
      this.nextId = this.nextId >= 0x7ffffff ? 1 : this.nextId + 1;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bulb ${this.host} did not answer "${method}" in time`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify({ id, method, params }) + MESSAGE_TERMINATOR;
      this.socket.write(payload, 'utf8', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Read properties from the bulb (spec table 4-2).
   * @param {string[]} names - The property names.
   * @returns {Promise<Record<string, string>>} The values, indexed by name.
   * @example
   * await client.getProps(['power', 'bright', 'ct']);
   */
  async getProps(names) {
    const values = await this.command('get_prop', names);
    /** @type {Record<string, string>} */
    const props = {};
    names.forEach((name, index) => {
      const value = (values || [])[index];
      // An unknown property comes back as an empty string, which carries no
      // information and would otherwise publish a bogus state.
      if (value !== undefined && value !== '') {
        props[name] = value;
      }
    });
    this.remember(props);
    return props;
  }

  /**
   * Drop a connection that stopped answering, AS a disconnection: unlike
   * `disconnect`, the `disconnect` event fires, so the manager reports the
   * light unreachable and starts reconnecting.
   * @returns {void}
   * @example
   * client.abort();
   */
  abort() {
    if (this.socket) {
      this.socket.destroy();
    }
  }

  /**
   * Close the connection, freeing one of the bulb's 4 connection slots.
   * @returns {void}
   * @example
   * client.disconnect();
   */
  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}
