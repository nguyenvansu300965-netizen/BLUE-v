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
    runtime = await new WhatsAppAccount(a, store, dir).init();
    let ended = false;
    runtime.client = { close: async () => { ended = true; } }; runtime.state.status = 'connected';
    runtime.requireConnected();
    store.db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(Date.now() - 1, user.id);
    assert.equal(entitlement(store.user(user.id)).active, false);
    assert.equal(store.allowed(a), false);
    assert.throws(() => runtime.requireConnected(), /订阅/);
    assert.throws(() => store.createAccount(user.id, 'Expired'), /订阅/);
    await assert.rejects(runtime.connect(), /权限/);
    await runtime.stop('blocked'); assert.equal(ended, true); assert.equal(runtime.client, null);
    store.close(); store = new Store(dir);
    assert.equal(store.messages(a.id)[0].text, 'Private'); assert.equal(store.messages(b.id).length, 0);
    assert.ok(store.byName('test-user').password_hash !== 'a-long-password-123');
    assert.throws(() => store.grant(actor, user.id, { enabled: true, plan: 'vip', expiresAt: new Date(Date.now() - 1).toISOString() }), /未来/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
