import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, readlink, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { recoverProfileLock, launchWithProfileRecovery } from '../profile-recovery.js';

async function fixture() {
  const dir = await mkdtemp('/tmp/blue-profile-lock-');
  await writeFile(path.join(dir, 'auth-preserved'), 'keep-session');
  for (const [name, target] of [['SingletonLock', 'old-container-99999999'], ['SingletonCookie', 'old-cookie-token'], ['SingletonSocket', '/tmp/missing-old-chrome/socket']]) await symlink(target, path.join(dir, name));
  return dir;
}
test('foreign-container locks require single-replica opt-in; active profile processes are never unlocked', async () => {
  const dir = await fixture();
  try {
    await assert.rejects(recoverProfileLock(dir, { hostname: 'new-container', processes: async () => [] }), { code: 'BROWSER_PROFILE_OTHER_HOST' });
    await assert.rejects(recoverProfileLock(dir, { allowForeignHost: true, processes: async () => [123] }), /仍有浏览器/);
    assert.equal(await readlink(path.join(dir, 'SingletonLock')), 'old-container-99999999');
    assert.equal(await readFile(path.join(dir, 'auth-preserved'), 'utf8'), 'keep-session');
  } finally { await rm(dir, { recursive: true }); }
});
test('stale lock recovery removes only known symlinks, keeps authentication data and retries once', async () => {
  const dir = await fixture(); let attempts = 0, recovered = 0;
  try {
    const browser = await launchWithProfileRecovery(async () => { if (++attempts === 1) throw new Error('The browser is already running for this profile'); return 'browser'; }, dir, { allowForeignHost: true, processes: async () => [], onRecovery: () => { recovered++; } });
    assert.equal(browser, 'browser'); assert.equal(attempts, 2); assert.equal(recovered, 1);
    await assert.rejects(readlink(path.join(dir, 'SingletonLock')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(dir, 'auth-preserved'), 'utf8'), 'keep-session');
  } finally { await rm(dir, { recursive: true }); }
});
test('unknown lock files and unreadable process lists fail closed without deleting profile data', async () => {
  const dir = await fixture();
  try {
    await assert.rejects(recoverProfileLock(dir, { allowForeignHost: true, processes: async () => { throw new Error('Inspection unavailable'); } }), /Inspection unavailable/);
    await rm(path.join(dir, 'SingletonCookie')); await writeFile(path.join(dir, 'SingletonCookie'), 'unexpected-file');
    await assert.rejects(recoverProfileLock(dir, { allowForeignHost: true, processes: async () => [] }), /锁格式无法识别/);
    assert.equal(await readlink(path.join(dir, 'SingletonLock')), 'old-container-99999999');
    assert.equal(await readFile(path.join(dir, 'SingletonCookie'), 'utf8'), 'unexpected-file');
  } finally { await rm(dir, { recursive: true }); }
});
