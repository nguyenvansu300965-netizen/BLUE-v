import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { generateCodes, activationHash, exportCodes } from '../scripts/generate-activation-codes.mjs';

test('seller code batches are unique, cryptographically random and export hashes without plaintext secrets', async () => {
  const batch = generateCodes(1000); assert.equal(batch.codes.length, 1000); assert.equal(new Set(batch.codes).size, 1000);
  assert.equal(new Set(batch.codes.map(activationHash)).size, 1000);
  assert.equal(activationHash(` ${batch.codes[0].toLowerCase()} `), activationHash(batch.codes[0]));
  assert.equal(activationHash('invalid'), null); assert.throws(() => generateCodes(0));
  const dir = await mkdtemp('/tmp/blue-activation-export-');
  try {
    const files = await exportCodes(10, dir); const csv = await readFile(files.csv, 'utf8'), manifest = JSON.parse(await readFile(files.manifest, 'utf8'));
    const codes = csv.trim().split('\n').slice(1).map(row => row.split(',')[1]);
    assert.equal(codes.length, 10); assert.deepEqual(manifest.hashes, codes.map(activationHash));
    assert.equal(JSON.stringify(manifest).includes(codes[0]), false);
    assert.equal((await stat(files.csv)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true }); }
});

import { Store } from '../store.js';
test('activation consumption is atomic, survives batch reimport/deletion/restart and never stores plaintext codes', async () => {
  const dir = await mkdtemp('/tmp/blue-activation-store-'); let store = new Store(dir);
  try {
    await store.bootstrap('activation-admin', '123456'); const admin = store.byName('activation-admin');
    const user = await store.createUser('activation-user', '123456');
    const batch = generateCodes(3), manifest = { batchId: batch.batchId, createdAt: new Date().toISOString(), hashes: batch.codes.map(activationHash) };
    assert.equal(store.importActivationBatch(manifest).added, 3);
    assert.throws(() => store.createManaged(admin.id, 'No code'), /必须填写激活码/);
    assert.throws(() => store.createManaged(admin.id, 'Invalid', 'bad'), /无效/);
    assert.throws(() => store.createManaged(user.id, 'Not admin', batch.codes[0]), /仅超级管理员/);
    assert.throws(() => store.createManaged(admin.id, '', batch.codes[0]), /备注/);
    const first = store.createManaged(admin.id, 'One', batch.codes[0]);
    assert.equal(store.managedAccounts().length, 1);
    assert.throws(() => store.createManaged(admin.id, 'Duplicate', batch.codes[0]), /已使用/);
    assert.equal(store.importActivationBatch(manifest).added, 0);
    store.deleteAccount(first.id); assert.throws(() => store.createManaged(admin.id, 'Deleted', batch.codes[0]), /已使用/);
    store.db.exec("CREATE TRIGGER reject_activation_fixture BEFORE INSERT ON accounts WHEN NEW.label='Fail' BEGIN SELECT RAISE(ABORT,'fixturefail'); END");
    assert.throws(() => store.createManaged(admin.id, 'Fail', batch.codes[1]), /fixturefail/);
    assert.equal(store.db.prepare('SELECT redeemed_at FROM activation_codes WHERE hash=?').get(activationHash(batch.codes[1])).redeemed_at, null, 'failed creation must roll back consumption');
    store.db.exec('DROP TRIGGER reject_activation_fixture');
    store.createManaged(admin.id, 'Retry', batch.codes[1]);
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM activation_codes').all()) + JSON.stringify(store.audit());
    for (const code of batch.codes) assert.equal(raw.includes(code), false);
    store.close(); store = new Store(dir); store.importActivationBatch(manifest);
    assert.throws(() => store.createManaged(admin.id, 'Restart reuse', batch.codes[1]), /已使用/);
    store.createManaged(admin.id, 'Still unused', batch.codes[2]);
    assert.throws(() => store.importActivationBatch({ ...manifest, hashes: [activationHash(generateCodes(1).codes[0])] }), /内容不一致/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
