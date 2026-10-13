import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { YeelightManager } from '../src/yeelight/YeelightManager.js';

/**
 * Start a TCP server standing in for a bulb, counting the sockets it accepts.
 * @returns {Promise<object>} The port, the accepted sockets and a `close` helper.
 */
async function countingBulb() {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sockets,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('concurrent callers share one connection to the same bulb', async () => {
  // After a restart, the startup refresh, a poll and a command can all reach a
  // lamp at once. Each used to open its own socket, and the orphans kept
  // holding some of the 4 slots a bulb accepts.
  const bulb = await countingBulb();
  const manager = new YeelightManager();
  const target = { id: '0x1', host: '127.0.0.1', port: bulb.port };

  const clients = await Promise.all([
    manager.connect(target),
    manager.connect(target),
    manager.connect(target),
  ]);

  assert.equal(new Set(clients).size, 1);
  assert.equal(bulb.sockets.length, 1);

  await manager.disconnectAll({ permanent: true });
  await bulb.close();
});

test('a bulb with a known address is connected on demand', async () => {
  const bulb = await countingBulb();
  const manager = new YeelightManager();
  manager.rememberAddress({ id: '0x1', host: '127.0.0.1', port: bulb.port });

  const client = await manager.ensureClient('0x1');

  assert.equal(client.connected, true);
  assert.equal(await manager.ensureClient('0x1'), client, 'the open session is reused');

  await manager.disconnectAll({ permanent: true });
  await bulb.close();
});

test('an address read from a device never overrides one learnt from a scan', () => {
  const manager = new YeelightManager();
  manager.rememberAddress({ id: '0x1', host: '192.168.1.50', port: 55443 });
  manager.rememberAddress({ id: '0x1', host: '192.168.1.20', port: 55443 }, { ifUnknown: true });

  assert.equal(manager.addresses.get('0x1').host, '192.168.1.50');
});

test('a bulb with no known address is reported, not silently skipped', async () => {
  const manager = new YeelightManager();
  await assert.rejects(() => manager.ensureClient('0x404'), /no known address/);
});

/**
 * Start a TCP server answering `get_prop` like a bulb, until `mute()`.
 * @returns {Promise<object>} The port, `mute` and `close` helpers.
 */
async function answeringBulb() {
  const sockets = [];
  let muted = false;
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (muted) {
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        const { id } = JSON.parse(line);
        socket.write(`${JSON.stringify({ id, result: ['on'] })}\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    mute: () => {
      muted = true;
    },
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('the heartbeat keeps a lamp that answers connected', async () => {
  const bulb = await answeringBulb();
  const manager = new YeelightManager();
  const changes = [];
  manager.onConnectionChange((id, connected) => changes.push([id, connected]));
  const client = await manager.connect({ id: '0x1', host: '127.0.0.1', port: bulb.port });
  client.lastSeen = 0;

  await manager.probeIdleClients(60000);

  assert.equal(client.connected, true);
  assert.deepEqual(changes, [['0x1', true]]);
  assert.equal(client.cached('power'), 'on');
  await manager.disconnectAll({ permanent: true });
  await bulb.close();
});

test('the heartbeat drops a lamp that stopped answering, as a disconnection', async (t) => {
  // A lamp cut at the wall switch: the session stays half-open and silent.
  const bulb = await answeringBulb();
  const manager = new YeelightManager();
  const changes = [];
  manager.onConnectionChange((id, connected) => changes.push([id, connected]));
  const client = await manager.connect({ id: '0x1', host: '127.0.0.1', port: bulb.port });
  bulb.mute();
  client.lastSeen = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const probe = manager.probeIdleClients(60000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await probe;
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(changes, [
    ['0x1', true],
    ['0x1', false],
  ]);
  assert.equal(manager.getClient('0x1'), undefined);
  await manager.disconnectAll({ permanent: true });
  await bulb.close();
});

test('a connection that spoke recently is not probed', async () => {
  const bulb = await countingBulb();
  const manager = new YeelightManager();
  const client = await manager.connect({ id: '0x1', host: '127.0.0.1', port: bulb.port });
  let probed = false;
  client.getProps = async () => {
    probed = true;
    return {};
  };

  await manager.probeIdleClients(60000);

  assert.equal(probed, false);
  await manager.disconnectAll({ permanent: true });
  await bulb.close();
});

test('the heartbeat starts once and stops on shutdown', async () => {
  const manager = new YeelightManager();
  manager.startHeartbeat(60000);
  const timer = manager.heartbeatTimer;
  manager.startHeartbeat(60000);
  assert.equal(manager.heartbeatTimer, timer);
  await manager.disconnectAll({ permanent: true });
  assert.equal(manager.heartbeatTimer, null);
});
