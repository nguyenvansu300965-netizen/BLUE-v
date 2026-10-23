import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../store.js';
import { migrateQuickReplies, materializeQuickReplyAsset, quickReplyMediaDir } from '../quick-replies.js';

test('legacy quick replies migrate with durable shared media; cross-user isolation survives number deletion', async () => {
  const dir = await mkdtemp('/tmp/blue-shared-quick-'); let store = new Store(dir);
  try {
    await store.bootstrap('quick-admin', '123456'); const user = store.byName('quick-admin');
    const other = await store.createUser('quick-other', '123456');
    store.grant(user.id, other.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const first = store.createAccount(user.id, 'One'), second = store.createAccount(user.id, 'Two'), foreign = store.createAccount(other.id, 'Foreign');
    const mediaDir = path.join(dir, 'tenants', user.id, first.id, 'media'); await mkdir(mediaDir, { recursive: true });
    const media = { id: 'a'.repeat(32), name: 'test.png', mime: 'image/png', type: 'image', size: 3 };
    store.addAttachment(first.id, media); await writeFile(path.join(mediaDir, `${media.id}.bin`), 'png');
    const old = store.saveQuickReply(first.id, null, { title: 'Welcome', text: 'Hello', attachment: media.id });
    const errors = []; await migrateQuickReplies(store, dir, entry => errors.push(entry)); assert.deepEqual(errors, []);
    const reply = store.userQuickReplies(user.id)[0]; assert.equal(reply.id, old.id); assert.equal(reply.attachment.scope, 'quick-reply');
    await migrateQuickReplies(store, dir); assert.equal(store.userQuickReplies(user.id).length, 1);
    const targetDir = path.join(dir, 'tenants', user.id, second.id, 'media');
    const [copy, duplicate] = await Promise.all([materializeQuickReplyAsset(store, user.id, second.id, reply.attachment, targetDir, dir), materializeQuickReplyAsset(store, user.id, second.id, reply.attachment, targetDir, dir)]);
    assert.equal(copy.id, duplicate.id); assert.equal(await readFile(path.join(targetDir, `${copy.id}.bin`), 'utf8'), 'png');
    assert.deepEqual(store.userQuickReplies(other.id), []); assert.equal(store.quickReplyAsset(other.id, reply.attachment.id), null);
    assert.throws(() => store.saveUserQuickReply(other.id, null, { title: 'Bad', text: '', attachment: reply.attachment.id }), /当前用户/);
    assert.throws(() => store.deleteUserQuickReply(other.id, reply.id), /不存在/);
    await assert.rejects(materializeQuickReplyAsset(store, user.id, foreign.id, reply.attachment, targetDir, dir), /当前用户/);
    store.deleteAccount(first.id); await rm(path.dirname(mediaDir), { recursive: true, force: true });
    assert.equal(store.userQuickReplies(user.id).length, 1);
    assert.equal(await readFile(path.join(quickReplyMediaDir(dir, user.id), `${reply.attachment.id}.bin`), 'utf8'), 'png');
    store.close(); store = new Store(dir); assert.equal(store.userQuickReplies(user.id)[0].text, 'Hello');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('assigned-number migration reads immutable storage owner and keeps templates with the current user after reassignment', async () => {
  const dir = await mkdtemp('/tmp/blue-assigned-quick-'); const store = new Store(dir);
  try {
    await store.bootstrap('owner-admin', '123456'); const admin = store.byName('owner-admin');
    const customer = await store.createUser('quick-customer', '123456');
    const account = store.createAccount(admin.id, 'Assigned');
    const media = { id: 'b'.repeat(32), name: 'old.png', mime: 'image/png', type: 'image', size: 3 };
    store.addAttachment(account.id, media);
    const source = path.join(dir, 'tenants', admin.id, account.id, 'media'); await mkdir(source, { recursive: true }); await writeFile(path.join(source, `${media.id}.bin`), 'old');
    store.saveQuickReply(account.id, null, { title: 'Customer reply', text: '', attachment: media.id });
    store.db.prepare('UPDATE accounts SET user_id=? WHERE id=?').run(customer.id, account.id);
    await migrateQuickReplies(store, dir);
    assert.equal(store.userQuickReplies(admin.id).length, 0);
    const reply = store.userQuickReplies(customer.id)[0]; assert.equal(reply.title, 'Customer reply');
    assert.equal(await readFile(path.join(quickReplyMediaDir(dir, customer.id), `${reply.attachment.id}.bin`), 'utf8'), 'old');
    store.db.prepare('UPDATE accounts SET user_id=? WHERE id=?').run(admin.id, account.id);
    await migrateQuickReplies(store, dir);
    assert.equal(store.userQuickReplies(customer.id).length, 1); assert.equal(store.userQuickReplies(admin.id).length, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
