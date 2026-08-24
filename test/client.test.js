import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { YeelightClient } from '../src/yeelight/YeelightClient.js';
import { MAX_COMMANDS_PER_MINUTE, RATE_WINDOW_MS } from '../src/yeelight/constants.js';

/**
 * Start a fake bulb speaking the real line protocol.
 * @param {Function} [onCommand] - Custom handler `(message, socket) => void`.
 * @returns {Promise<object>} The server, its port and a `push` helper.
 */
async function fakeBulb(onCommand) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (data) => {
      data
        .split('\r\n')
        .filter(Boolean)
        .forEach((line) => {
          const message = JSON.parse(line);
          if (onCommand) {
            onCommand(message, socket);
            return;
          }
          socket.write(JSON.stringify({ id: message.id, result: ['ok'] }) + '\r\n');
        });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    push: (raw) => sockets.forEach((socket) => socket.write(raw)),
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a command is answered by the matching RESULT message', async () => {
  const bulb = await fakeBulb();
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  assert.deepEqual(await client.command('set_power', ['on', 'smooth', 500]), ['ok']);

  client.disconnect();
  await bulb.close();
});

test('an ERROR result rejects with the message the bulb gave', async () => {
  const bulb = await fakeBulb((message, socket) => {
    socket.write(
      JSON.stringify({ id: message.id, error: { code: -1, message: 'unsupported method' } }) +
        '\r\n',
    );
  });
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  await assert.rejects(() => client.command('nope'), /unsupported method/);

  client.disconnect();
  await bulb.close();
});

test('a reply split across packets is still decoded', async () => {
  // TCP is a stream: one read can carry half a message. Framing on CRLF is
  // what makes this work, and it is easy to get wrong.
  const bulb = await fakeBulb((message, socket) => {
    const reply = JSON.stringify({ id: message.id, result: ['ok'] }) + '\r\n';
    socket.write(reply.slice(0, 6));
    setTimeout(() => socket.write(reply.slice(6)), 10);
  });
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  assert.deepEqual(await client.command('toggle'), ['ok']);

  client.disconnect();
  await bulb.close();
});

test('several messages glued in one packet are all decoded', async () => {
  const bulb = await fakeBulb();
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  const pushed = [];
  client.on('props', (props) => pushed.push(props));
  await client.connect();

  bulb.push(
    '{"method":"props","params":{"power":"on"}}\r\n{"method":"props","params":{"bright":"10"}}\r\n',
  );
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(pushed, [{ power: 'on' }, { bright: '10' }]);

  client.disconnect();
  await bulb.close();
});

test('an unsolicited notification is pushed, not mistaken for a result', async () => {
  // The push path: a notification carries NO id. This is how Gladys learns a
  // lamp was dimmed at the wall switch.
  const bulb = await fakeBulb();
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  const pushed = [];
  client.on('props', (props) => pushed.push(props));
  await client.connect();

  bulb.push('{"method":"props","params":{"power":"off","bright":"1"}}\r\n');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(pushed, [{ power: 'off', bright: '1' }]);

  client.disconnect();
  await bulb.close();
});

test('get_prop drops the empty values that mean "unknown property"', async () => {
  const bulb = await fakeBulb((message, socket) => {
    socket.write(JSON.stringify({ id: message.id, result: ['on', '42', ''] }) + '\r\n');
  });
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  assert.deepEqual(await client.getProps(['power', 'bright', 'nope']), {
    power: 'on',
    bright: '42',
  });

  client.disconnect();
  await bulb.close();
});

test('a burst of commands is not throttled below the quota', async () => {
  // Gladys acks `onSetValue` within 5 s, and a scene can set several features
  // at once: a fixed delay per command would blow that budget.
  const bulb = await fakeBulb();
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  const started = Date.now();
  await Promise.all([
    client.command('set_power', ['on', 'smooth', 500]),
    client.command('set_bright', [50, 'smooth', 500]),
    client.command('set_rgb', [255, 'smooth', 500]),
  ]);
  assert.ok(Date.now() - started < 1000, 'a 3-command burst must go out immediately');

  client.disconnect();
  await bulb.close();
});

test('the quota holds a command back once the window is full', async () => {
  // The bulb enforces its 60/min limit by going SILENT, so exceeding it looks
  // exactly like a broken lamp. Waiting is the only safe behaviour.
  const client = new YeelightClient({ host: '127.0.0.1' });
  for (let index = 0; index < MAX_COMMANDS_PER_MINUTE; index += 1) {
    await client.awaitQuota();
  }
  assert.equal(client.commandTimes.length, MAX_COMMANDS_PER_MINUTE);

  // Make the oldest slot expire shortly, then check we waited for it.
  client.commandTimes[0] = Date.now() - (RATE_WINDOW_MS - 150);
  const started = Date.now();
  await client.awaitQuota();
  assert.ok(Date.now() - started >= 100, 'an over-quota command must wait');
});

test('a command sent while disconnected rejects instead of hanging', async () => {
  const client = new YeelightClient({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => client.command('toggle'), /not connected/);
});

test('closing settles the commands still in flight', async () => {
  // Without this, a command sent as the lamp loses power would hang forever.
  const bulb = await fakeBulb(() => {
    /* never answers */
  });
  const client = new YeelightClient({ host: '127.0.0.1', port: bulb.port });
  await client.connect();

  const pending = client.command('toggle');
  setTimeout(() => client.disconnect(), 30);

  await assert.rejects(() => pending, /Connection closed/);
  await bulb.close();
});

test('connecting to a closed port rejects rather than resolving', async () => {
  const client = new YeelightClient({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => client.connect());
});

test('an accepted power command updates the cache, a failed one does not', () => {
  // The cache spares a `get_prop` before every slider step, so a wrong value
  // costs a real bug: a stale 'on' would skip the power-on the command needed.
  const client = new YeelightClient({ host: '192.0.2.1' });

  client.remember({ power: 'on' });
  assert.equal(client.cached('power'), 'on');

  // Only what a setter ACTUALLY carries is folded in.
  client.rememberCommand('set_power', ['off', 'smooth', 500]);
  assert.equal(client.cached('power'), 'off');
  client.rememberCommand('bg_set_power', ['on', 'smooth', 500]);
  assert.equal(client.cached('bg_power'), 'on');

  // A setter that is not a power command leaves the power state alone.
  client.rememberCommand('set_ct_abx', [4000, 'smooth', 500]);
  assert.equal(client.cached('power'), 'off');

  // An unknown property was simply never seen.
  assert.equal(client.cached('bright'), undefined);
});

test('the cache is dropped when the connection is lost', () => {
  // A lamp can be power-cycled while we are away: keeping a stale 'on' would
  // let the next command skip a power-on it needed.
  const client = new YeelightClient({ host: '192.0.2.1' });
  client.connected = true;
  client.remember({ power: 'on' });

  client.handleClose();

  assert.equal(client.cached('power'), undefined);
});
