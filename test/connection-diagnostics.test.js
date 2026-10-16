import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceSample, connectionDiagnostic, safeStartupReason } from '../connection-diagnostics.js';

test('container diagnostics read total Chromium-inclusive usage and handle unavailable/unlimited cgroups', async () => {
  const files = { 'memory.current': String(2 * 1048576), 'memory.max': String(24 * 1024 * 1048576), 'memory.events': 'oom 1\noom_kill 2\n', 'pids.current': '123', 'pids.max': '512' };
  assert.deepEqual(await resourceSample(async file => files[file.split('/').at(-1)]), { memoryMb: 2, memoryLimitMb: 24576, oomKills: 2, pids: 123, pidsLimit: 512 });
  assert.deepEqual(await resourceSample(async () => { throw new Error('Not mounted'); }), { memoryMb: null, memoryLimitMb: null, oomKills: null, pids: null, pidsLimit: null });
  assert.equal((await resourceSample(async file => file.endsWith('.max') ? 'max' : '0')).memoryLimitMb, null);
});
test('startup reasons distinguish profile/process/network failures without guessing OOM from account count', () => {
  const before = { oomKills: 0 }, resources = { memoryMb: 2000, memoryLimitMb: 24576, oomKills: 0, pids: 512, pidsLimit: 512 };
  assert.equal(connectionDiagnostic(new Error('Failed to launch'), 'browser', before, resources).code, 'BROWSER_PROCESS_LIMIT');
  assert.equal(connectionDiagnostic(new Error('Failed to create SingletonLock'), 'browser').code, 'BROWSER_PROFILE_LOCKED');
  assert.equal(connectionDiagnostic(Object.assign(new Error('memory'), { code: 'ENOMEM' }), 'browser').code, 'BROWSER_OOM');
  assert.equal(connectionDiagnostic(new Error('process exited'), 'browser', before, { ...resources, oomKills: 1 }).code, 'BROWSER_OOM');
  assert.equal(connectionDiagnostic(new Error('unknown'), 'browser', before, { ...resources, pids: 123 }).code, 'BROWSER_LAUNCH_FAILED');
  assert.equal(connectionDiagnostic(Object.assign(new Error('Timed out waiting for WS endpoint'), { name: 'TimeoutError' }), 'browser').code, 'BROWSER_START_TIMEOUT');
  assert.equal(connectionDiagnostic(new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'page').code, 'CERTIFICATE_UNTRUSTED');
  assert.equal(connectionDiagnostic(new Error('net::ERR_NAME_NOT_RESOLVED'), 'page').code, 'WHATSAPP_DNS');
  const message = connectionDiagnostic(new Error('pthread_create: Resource temporarily unavailable'), 'browser', before, resources).message;
  assert.match(message, /BROWSER_PROCESS_LIMIT/); assert.match(message, /2000 \/ 24576 MB/);
  const secret = 'token=private-token\npassword=private-password\nFailed https://user:secret@example.test/login?code=private-code\npthread_create failed';
  const filtered = safeStartupReason(new Error(secret));
  assert.ok(!filtered.includes('private-')); assert.ok(!filtered.includes('user:secret')); assert.match(filtered, /pthread_create failed/);
});
