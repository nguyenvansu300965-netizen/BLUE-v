import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, entitlement } from '../store.js';
import { WhatsAppAccount } from '../whatsapp.js';

test('subscription expiry blocks account creation and sends; messages stay isolated and survive reopen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-store-'));
  let store = new Store(dir);
  let runtime;
  try {
    await store.bootstrap('admin-user', 'a-long-password-123');
    const user = await store.createUser('test-user', 'a-long-password-123');
    const actor = store.byName('admin-user').id;
    store.grant(actor, user.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const a = store.createAccount(user.id, 'First'), b = store.createAccount(user.id, 'Second');
    const message = { id: '1', jid: '123456789@s.whatsapp.net', text: 'Private', time: Date.now() };
    assert.equal(store.remember(a.id, message), true); assert.equal(store.remember(a.id, message), false);
    assert.deepEqual(store.messages(b.id), []);
    store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '/9j/' + 'A'.repeat(200), outgoing: true, time: Date.now() });
    assert.equal(store.messages(a.id).find(m => m.id === 'IMAGE').text, '[图片]', 'legacy base64 must not be exposed as chat text');
    assert.equal(store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '产品文案', image: 'a'.repeat(32) + '.png', buttons: [{ label: '咨询' }], outgoing: true, automatic: true, time: Date.now() }), true);
    const media = store.messages(a.id).find(m => m.id === 'IMAGE');
    assert.equal(media.text, '产品文案'); assert.equal(media.image, 'a'.repeat(32) + '.png'); assert.equal(media.buttons[0].label, '咨询');
    assert.equal(store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '/9j/' + 'A'.repeat(200), outgoing: true, time: Date.now() }), false, 'later browser echo must not replace the canonical reply');

    const menu = { nodeId: 'welcome', options: [{ label: 'Product', next: 'product' }] };
    store.remember(a.id, { id: 'OLD-MENU', jid: message.jid, text: 'Choose', buttons: [{ label: 'Product' }], flow: menu, outgoing: true, automatic: true, time: Date.now() - 86400000 });
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'OLD-MENU', []), menu);
    assert.equal(store.flowMenu(b.id, message.jid, 'welcome', 'OLD-MENU', []), null);
    assert.equal(store.flowMenu(a.id, '987654321@s.whatsapp.net', 'welcome', 'OLD-MENU', []), null);
    assert.equal(store.flowMenu(a.id, message.jid, 'welcome', 'unknown', []), null);
    store.remember(a.id, { id: 'LEGACY-MENU', jid: message.jid, text: 'Choose', buttons: [{ label: 'Product' }], outgoing: true, automatic: true, time: Date.now() - 5000 });
    const legacyNodes = [{ id: 'welcome', options: menu.options }];
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'LEGACY-MENU', legacyNodes), menu);
    assert.equal(store.flowMenu(a.id, message.jid, 'welcome', 'LEGACY-MENU', [{ id: 'welcome', options: [{ label: 'Different', next: 'product' }] }]), null);

    runtime = await new WhatsAppAccount(a, store, dir).init();
    let ended = false;
    runtime.client = { close: async () => { ended = true; } }; runtime.state.status = 'connected'; runtime.state.user = { id: '123456789@s.whatsapp.net' };
    runtime.requireConnected();
    store.db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(Date.now() - 1, user.id);
    assert.equal(entitlement(store.user(user.id)).active, false);
    assert.equal(store.allowed(a), false);
    assert.throws(() => runtime.requireConnected(), /订阅/);
    assert.throws(() => store.createAccount(user.id, 'Expired'), /订阅/);
    await assert.rejects(runtime.connect(), /权限/);
    await runtime.stop('blocked'); assert.equal(ended, true); assert.equal(runtime.client, null);
    store.close(); store = new Store(dir);
    assert.equal(store.messages(a.id).find(item => item.id === '1').text, 'Private'); assert.equal(store.messages(b.id).length, 0);
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'OLD-MENU', []), menu, 'old buttons survive process restart');
    assert.ok(store.byName('test-user').password_hash !== 'a-long-password-123');
    assert.throws(() => store.grant(actor, user.id, { enabled: true, plan: 'vip', expiresAt: new Date(Date.now() - 1).toISOString() }), /未来/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});


test('contact remarks and monotonic read markers persist per account and cascade on deletion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-contacts-')); let store = new Store(dir);
  try {
    await store.bootstrap('contact-admin', '123456'); const user = store.byName('contact-admin');
    const a = store.createAccount(user.id, 'One'), b = store.createAccount(user.id, 'Two'), jid = '123456789@s.whatsapp.net';
    store.updateContact(a.id, jid, { remark: '客户甲', readAt: 1000, name: 'Rose', phone: '123456789' });
    store.updateContact(a.id, jid, { readAt: 500 });
    assert.equal(store.contacts(a.id)[0].readAt, 1000);
    assert.deepEqual(store.contacts(b.id), []);
    store.close(); store = new Store(dir);
    assert.equal(store.contacts(a.id)[0].remark, '客户甲');
    store.updateContact(a.id, jid, { remark: '' }); assert.equal(store.contacts(a.id)[0].name, 'Rose');
    store.deleteAccount(a.id); assert.deepEqual(store.contacts(a.id), []);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});


test('legacy schema migrates without moving ownership or changing plan limits; managed profiles keep their storage owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-legacy-assignment-')); let store = new Store(dir); let runtime;
  try {
    await store.bootstrap('legacy-admin', '123456'); const admin = store.byName('legacy-admin');
    const user = await store.createUser('legacy-customer', '123456');
    store.grant(admin.id, user.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const old = store.createAccount(user.id, 'Legacy');
    store.db.exec('ALTER TABLE users DROP COLUMN number_limit; ALTER TABLE accounts DROP COLUMN storage_owner_id; ALTER TABLE accounts DROP COLUMN managed');
    store.close(); store = new Store(dir);
    assert.equal(store.publicUser(store.user(user.id)).limit, 5); assert.equal(store.account(old.id).managed, 0); assert.equal(store.account(old.id).storage_owner_id, user.id);
    assert.equal(store.canAccess(user.id, old), true);
    const pool = store.createManaged(admin.id, 'Pooled'); runtime = await new WhatsAppAccount(pool, store, dir).init();
    const profile = runtime.profileDir; let closed = 0; const client = { close: async () => { closed++; } }; runtime.client = client; runtime.state.status = 'connected'; runtime.state.user = { id: '123456789@s.whatsapp.net' };
    runtime.account = store.assignAccount(admin.id, pool.id, user.id);
    assert.equal(runtime.profileDir, profile); assert.equal(runtime.client, client); assert.equal(store.canAccess(admin.id, pool), false); assert.equal(store.canAccess(user.id, pool), true);
    runtime.account = store.assignAccount(admin.id, pool.id, null);
    assert.equal(store.canAccess(user.id, pool), false); assert.equal(store.allowed(pool), true); assert.equal(runtime.state.status, 'connected'); assert.equal(closed, 0);
    assert.equal(store.canAccess(user.id, old), true, 'legacy number remains unchanged');
  } finally { await runtime?.stop(); store.close(); await rm(dir, { recursive: true }); }
});
