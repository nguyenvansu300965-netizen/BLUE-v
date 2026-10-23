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


test('live bridge heartbeats do not mask a stalled WhatsApp transport; recovery cancels when transport returns', async () => {
  const events = [], client = new WaJsClient({ profileDir: '/unused', onEvent: event => events.push(event) });
  const healthy = { mode: 'MAIN', info: 'NORMAL', connected: true }, offline = { mode: 'OFFLINE', info: 'CONNECTING', connected: false };
  client.observeHealth({ type: 'state', status: 'connected', stream: healthy }, 100000);
  client.observeHealth({ type: 'state', status: 'disconnected', stream: offline }, 110000);
  client.observeHealth({ type: 'receiver_heartbeat', stream: offline }, 200000);
  client.checkBridgeHealth(220000); assert.equal(events.length, 0);
  client.observeHealth({ type: 'state', status: 'connected', stream: healthy }, 225000);
  client.checkBridgeHealth(230000); assert.equal(events.length, 0, 'normal recovery cancels transport watchdog');
  client.observeHealth({ type: 'state', status: 'disconnected', stream: offline }, 240000);
  client.observeHealth({ type: 'receiver_heartbeat', stream: offline }, 350000);
  client.checkBridgeHealth(360000); client.checkBridgeHealth(380000);
  assert.deepEqual(events, [{ type: 'closed', reason: 'WHATSAPP_STREAM_STALLED' }]);
  await client.close();
});

test('QR pairing and stream conflict do not trigger an automatic session takeover', async () => {
  const events = [], client = new WaJsClient({ profileDir: '/unused', onEvent: event => events.push(event) });
  client.observeHealth({ type: 'state', status: 'connected', stream: { mode: 'MAIN', info: 'NORMAL', connected: true } }, 100000);
  client.observeHealth({ type: 'state', status: 'qr', stream: { mode: 'QR', info: 'PAIRING', connected: false } }, 110000);
  client.checkBridgeHealth(500000); assert.equal(events.length, 0);
  client.observeHealth({ type: 'receiver_heartbeat', stream: { mode: 'CONFLICT', info: null, connected: false } }, 600000);
  client.observeHealth({ type: 'receiver_heartbeat', stream: { mode: 'CONFLICT', info: null, connected: false } }, 800000);
  client.checkBridgeHealth(800001); assert.equal(events.length, 0);
  await client.close();
});
