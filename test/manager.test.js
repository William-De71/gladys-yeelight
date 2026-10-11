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
