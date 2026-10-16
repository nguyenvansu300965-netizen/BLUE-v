import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { WhatsAppAccount } from '../whatsapp.js';

test('WA-JS account profiles, events and automation are isolated; reset closes browser before removing profile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-wajs-'));
  const store = new Store(dir);
  const events = [], calls = [], runtimes = [];
  try {
    await store.bootstrap('test-admin', 'test-password-123');
    const user = store.byName('test-admin');
    const createClient = ({ profileDir, onEvent }) => {
      events.push(onEvent); calls.push(['profile', profileDir]);
      return { start: async () => {}, close: async () => { calls.push(['close', profileDir]); }, logout: async () => {}, sendText: async (jid, text, buttons) => { calls.push(['text', jid, text, buttons]); return calls.filter(call => call[0] === 'text').length === 1 ? 'OUTGOING' : `OUTGOING-${calls.filter(call => call[0] === 'text').length}`; } };
    };
    const a = await new WhatsAppAccount(store.createAccount(user.id, 'One'), store, dir, { createClient }).init();
    const b = await new WhatsAppAccount(store.createAccount(user.id, 'Two'), store, dir, { createClient }).init(); runtimes.push(a, b);
    await a.connect(); await b.connect();
    assert.notEqual(a.profileDir, b.profileDir);
    await events[0]({ type: 'qr', code: 'test-only-qr' }); assert.match(a.state.qr, /^data:image\/png;base64,/); assert.equal(b.state.qr, null);
    await events[0]({ type: 'state', status: 'connected', user: { id: '123456789@c.us' } });
    await access(a.sessionMarker);
    a.config = { enabled: true, mode: 'buttons', nodes: [{ id: 'start', name: 'Welcome', triggers: ['hi'], text: 'Dear user {full_name}, hello! {phone_number}', image: '', options: [{ label: 'Next', next: 'next' }] }, { id: 'next', name: 'Next', triggers: [], text: 'Done', image: '', options: [] }] };
    a.automation.configure(a.config);
    a.client.contactInfo = async () => ({ name: 'Rose', phoneNumber: '123456789' });
    a.client.fetchMessages = async () => ({ messages: [{ id: 'HISTORY', chatId: '123456789@c.us', body: 'hi', timestamp: Date.now() / 1000 }], chatCount: 1, failedChats: 0 });
    await a.syncMessages(); await a.automation.queue;
    assert.equal(store.messages(a.account.id).some(m => m.id === 'HISTORY'), true);
    assert.equal(calls.filter(c => c[0] === 'text').length, 0, 'history must not trigger automation even if a keyword matches');
    await a.syncMessages(); assert.equal(a.sync.imported, 0);
    const incoming = { type: 'message', message: { id: 'INCOMING', chatId: '123456789@c.us', body: 'hi', timestamp: Date.now() / 1000 } };
    await events[0](incoming); await a.automation.queue;
    assert.equal(calls.find(c => c[0] === 'text')[2], 'Dear user Rose, hello! 123456789');
    assert.equal(store.messages(a.account.id).find(m => m.id === 'OUTGOING').text, 'Dear user Rose, hello! 123456789');
    assert.equal(a.config.nodes[0].text, 'Dear user {full_name}, hello! {phone_number}');
    assert.equal(calls.filter(c => c[0] === 'text').length, 1); assert.deepEqual(calls.find(c => c[0] === 'text')[3], [{ id: 'flow:start:0', text: 'Next' }]);
    await events[0](incoming); await a.automation.queue; assert.equal(calls.filter(c => c[0] === 'text').length, 1);
    await events[0]({ type: 'message', message: { id: 'DECRYPT', chatId: '123456789@c.us', type: 'ciphertext', timestamp: Date.now() / 1000 } });
    await events[0]({ type: 'message', message: { id: 'DECRYPT', chatId: '123456789@c.us', type: 'chat', body: 'Decrypted content', timestamp: Date.now() / 1000 } });
    assert.equal(store.messages(a.account.id).find(m => m.id === 'DECRYPT').text, 'Decrypted content');
    assert.deepEqual(store.messages(a.account.id).find(m => m.id === 'OUTGOING').flow, { nodeId: 'start', options: [{ label: 'Next', next: 'next' }] });
    a.automation.configure(a.config); // Drops all in-memory sessions/menus, as after a restart.
    await events[0]({ type: 'message', message: { id: 'OLD-BUTTON-CLICK', chatId: '123456789@c.us', type: 'buttons_response', selectedButtonId: 'flow:start:0', quotedId: 'OUTGOING', timestamp: Date.now() / 1000 } });
    await a.automation.queue;
    assert.equal(calls.filter(call => call[0] === 'text').length, 2);
    assert.equal(calls.filter(call => call[0] === 'text').at(-1)[2], 'Done', 'persisted original menu must route an old button with no active session');
    assert.ok(a.receiver.lastMessageAt);
    assert.equal(store.messages(b.account.id).length, 0);
    await mkdir(a.mediaDir, { recursive: true });
    const attachment = { id: 'a'.repeat(32), name: '报价.pdf', mime: 'application/pdf', type: 'document', size: 3 };
    await writeFile(path.join(a.mediaDir, `${attachment.id}.bin`), Buffer.from('pdf'));
    a.client.sendMedia = async (jid, data, item, caption) => { assert.equal(jid, '123456789@s.whatsapp.net'); assert.equal(data.toString(), 'pdf'); assert.deepEqual(item, attachment); assert.equal(caption, '报价'); return 'MEDIA'; };
    assert.equal(await a.sendMedia('123456789@s.whatsapp.net', attachment, '报价'), 'MEDIA');
    await a.reset();
    assert.equal(a.client, null); assert.equal(a.state.status, 'idle');
    await assert.rejects(access(a.sessionMarker));
    await events[0]({ type: 'qr', code: 'stale' }); assert.equal(a.state.qr, null);
    assert.equal(b.state.status, 'connecting');
    assert.ok(calls.some(c => c[0] === 'close' && c[1] === a.profileDir));
  } finally { await Promise.all(runtimes.map(rt => rt.stop())); store.close(); await rm(dir, { recursive: true }); }
});

test('blocked account cancels a browser that is still starting and never becomes connected afterwards', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-cancel-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('test-admin', 'test-password-123');
    const user = await store.createUser('test-user', 'test-password-123'); store.grant(store.byName('test-admin').id, user.id, { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 60000).toISOString() });
    let finish, notify, closed = false;
    rt = await new WhatsAppAccount(store.createAccount(user.id, 'One'), store, dir, { createClient: ({ onEvent }) => { notify = onEvent; return { start: () => new Promise(resolve => { finish = resolve; }), close: async () => { closed = true; finish(); } }; } }).init();
    const starting = rt.connect();
    await new Promise(resolve => setImmediate(resolve));
    store.grant(store.byName('test-admin').id, user.id, { enabled: false, plan: 'basic', expiresAt: null });
    await rt.stop('blocked'); await starting;
    await notify({ type: 'state', status: 'connected', user: { id: '123456789@c.us' } });
    assert.equal(closed, true); assert.equal(rt.state.status, 'blocked'); assert.equal(rt.client, null);
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true }); }
});

test('startup without a QR times out, closes its browser and becomes retryable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-qr-timeout-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('test-admin', 'test-password-123');
    let closed = 0;
    rt = await new WhatsAppAccount(store.createAccount(store.byName('test-admin').id, 'One'), store, dir, { connectTimeout: 20, createClient: () => ({ start: async () => {}, close: async () => { closed++; } }) }).init();
    await rt.connect();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(rt.state.status, 'error'); assert.match(rt.state.error, /获取二维码超时/); assert.equal(rt.client, null); assert.equal(closed, 1);
    await rt.connect(); assert.equal(rt.state.status, 'connecting');
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true }); }
});

test('different owners have independent WhatsApp profiles, connection identities and message stores', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-owner-isolation-')); const store = new Store(dir); const runtimes = [], handlers = [];
  try {
    await store.bootstrap('test-admin', 'test-password-123');
    const admin = store.byName('test-admin');
    for (const username of ['owner-one', 'owner-two']) {
      const user = await store.createUser(username, '123456');
      store.grant(admin.id, user.id, { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 60000).toISOString() });
      const rt = await new WhatsAppAccount(store.createAccount(user.id, username), store, dir, { createClient: ({ profileDir, onEvent }) => {
        handlers.push(onEvent);
        assert.ok(profileDir.includes(path.join('tenants', user.id)));
        return { start: async () => {}, close: async () => {} };
      } }).init();
      runtimes.push(rt); await rt.connect();
    }
    const [a, b] = runtimes;
    assert.notEqual(a.profileDir, b.profileDir);
    await handlers[0]({ type: 'state', status: 'connected', user: { id: '123456789@c.us' } });
    assert.equal(a.state.user.id, '123456789@s.whatsapp.net'); assert.equal(a.state.user.phoneNumber, '123456789');
    assert.equal(b.state.status, 'connecting'); assert.equal(b.state.user, null);
    await handlers[1]({ type: 'state', status: 'connected', user: null });
    assert.equal(b.state.status, 'connecting'); assert.equal(b.state.user, null);
    assert.throws(() => b.requireConnected(), /扫码/);
    await assert.rejects(access(b.sessionMarker), 'missing identity must never persist a registered session');
    await handlers[1]({ type: 'qr', code: 'owner-two-only' });
    assert.equal(b.state.status, 'qr'); assert.equal(a.state.status, 'connected');
    await handlers[0]({ type: 'message', message: { id: 'PRIVATE', chatId: '987654321@c.us', body: 'Owner one private message', timestamp: Date.now() / 1000 } });
    assert.equal(store.messages(a.account.id).length, 1); assert.deepEqual(store.messages(b.account.id), []);
    assert.equal(b.snapshot().user, null);
    await handlers[1]({ type: 'state', status: 'connected', user: { id: '999999999999999@lid', phoneNumber: '447700900123' } });
    assert.equal(b.state.user.phoneNumber, '447700900123'); assert.equal(a.state.user.phoneNumber, '123456789');
  } finally { await Promise.all(runtimes.map(rt => rt.stop())); store.close(); await rm(dir, { recursive: true }); }
});
