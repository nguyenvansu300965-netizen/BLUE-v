import test from 'node:test';
import assert from 'node:assert/strict';
import { WaJsClient } from '../wa-js-client.js';

test('receiver watchdog ignores quiet chats and only recovers missing bridge heartbeats once', async () => {
  const events = [];
  const client = new WaJsClient({ profileDir: '/unused', onEvent: event => events.push(event) });
  client.checkBridgeHealth(100000); assert.equal(events.length, 0, 'login without an initialized bridge is handled by startup timeout');
  client.lastBridgeAt = 100000;
  client.checkBridgeHealth(189999); assert.equal(events.length, 0);
  client.lastBridgeAt = 180000; client.checkBridgeHealth(200000); assert.equal(events.length, 0, 'heartbeat keeps a quiet number online');
  client.checkBridgeHealth(270000); client.checkBridgeHealth(300000);
  assert.deepEqual(events, [{ type: 'closed', reason: 'RECEIVER_HEARTBEAT_TIMEOUT' }]);
  await client.close(); client.healthFailed = false; client.checkBridgeHealth(400000);
  assert.equal(events.length, 1, 'closed clients cannot reconnect');
});
