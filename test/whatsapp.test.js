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
    assert.equal(a.snapshot('user').qr, null, 'ordinary workspaces never receive device QR credentials');
    assert.equal(a.snapshot('admin').qr, a.state.qr);
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
    a.client.fetchMessages = async () => ({ messages: [incoming.message], chatCount: 1, failedChats: 0 });
    await a.syncMessages(); await a.automation.queue;
    assert.equal(calls.filter(c => c[0] === 'text').length, 0, 'a new message imported before its live event does not itself trigger');
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

test('a third browser failure reports process limits and leaves two other owners connected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-third-browser-')); const store = new Store(dir); const runtimes = [], handlers = [], closed = [], failures = [];
  try {
    await store.bootstrap('test-admin', '123456');
    const admin = store.byName('test-admin');
    for (let index = 0; index < 3; index++) {
      const user = await store.createUser(`browser-user-${index}`, '123456');
      store.grant(admin.id, user.id, { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 60000).toISOString() });
      const rt = await new WhatsAppAccount(store.createAccount(user.id, 'One'), store, dir, {
        sampleResources: async () => ({ memoryMb: 2000, memoryLimitMb: 24576, oomKills: 0, pids: 512, pidsLimit: 512 }),
        logFailure: failure => failures.push(failure),
        createClient: ({ onEvent }) => { handlers[index] = onEvent; return { start: async () => { if (index === 2) throw Object.assign(new Error('pthread_create: Resource temporarily unavailable'), { code: 'EAGAIN' }); }, close: async () => { closed.push(index); } }; }
      }).init();
      runtimes.push(rt); await rt.connect();
      if (index < 2) await handlers[index]({ type: 'state', status: 'connected', user: { id: `${123456789 + index}@c.us` } });
    }
    assert.equal(runtimes[0].state.status, 'connected'); assert.equal(runtimes[1].state.status, 'connected');
    assert.equal(runtimes[2].state.status, 'error'); assert.equal(runtimes[2].client, null);
    assert.match(runtimes[2].state.error, /BROWSER_PROCESS_LIMIT/); assert.match(runtimes[2].state.error, /24576/);
    assert.deepEqual(closed, [2]); assert.equal(failures.length, 1); assert.equal(failures[0].code, 'BROWSER_PROCESS_LIMIT');
    assert.equal(failures[0].accountId, runtimes[2].account.id);
  } finally { await Promise.all(runtimes.map(rt => rt.stop())); store.close(); await rm(dir, { recursive: true }); }
});

test('incoming full-resolution media are cached per account and downloads deduplicate without blocking reception', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-received-media-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('media-admin', '123456'); const user = store.byName('media-admin');
    const account = store.createAccount(user.id, 'One'), other = store.createAccount(user.id, 'Other');
    rt = await new WhatsAppAccount(account, store, dir).init();
    rt.state.status = 'connected'; rt.state.user = { id: '123456789@s.whatsapp.net' }; let downloads = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1kAAAAASUVORK5CYII=', 'base64');
    rt.client = { close: async () => {}, downloadMessageMedia: async sourceId => { downloads++; assert.equal(sourceId, 'false_987654321@c.us_MEDIA'); return { base64: png.toString('base64'), mime: 'image/png' }; } };
    await rt.onClientEvent({ type: 'message', message: { id: 'MEDIA', chatId: '987654321@c.us', type: 'image', body: '', mime: 'image/png', timestamp: Date.now() / 1000 } }, rt.generation);
    await rt.mediaQueue;
    const message = store.messages(account.id).find(item => item.id === 'MEDIA');
    assert.equal(message.attachment.type, 'image'); assert.equal(message.text, '[图片]');
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(await readFile(path.join(rt.mediaDir, `${message.attachment.id}.bin`)), png);
    await rt.downloadMessageMedia('MEDIA'); assert.equal(downloads, 1, 'cached image must not be downloaded again');
    assert.equal(store.attachment(other.id, message.attachment.id), undefined);
    store.remember(account.id, { id: 'VOICE', jid: '987654321@s.whatsapp.net', text: '[语音]', media: { type: 'ptt', sourceId: 'voice' }, time: Date.now() });
    rt.client.downloadMessageMedia = async () => { throw new Error('MEDIA_UNAVAILABLE'); };
    await assert.rejects(rt.downloadMessageMedia('VOICE'), /媒体下载失败/);
    rt.client.downloadMessageMedia = async () => ({ base64: png.toString('base64'), mime: 'audio/ogg; codecs=opus' });
    const voice = await rt.downloadMessageMedia('VOICE'); assert.equal(voice.attachment.type, 'audio'); assert.equal(voice.attachment.mime, 'audio/ogg');
    await assert.rejects(rt.downloadMessageMedia('foreign-message'), /消息不存在/);
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true }); }
});


test('forward/revoke use only account-owned messages and persist revocation only after confirmed success', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-actions-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('actions-admin', '123456'); const user = store.byName('actions-admin');
    const account = store.createAccount(user.id, 'One'), other = store.createAccount(user.id, 'Other');
    rt = await new WhatsAppAccount(account, store, dir).init();
    rt.state.status = 'connected'; rt.state.user = { id: '123456789@s.whatsapp.net' };
    const calls = []; let fail = false;
    rt.syncMessages = async () => {};
    rt.client = { close: async () => {}, forwardMessage: async (...args) => { calls.push(['forward', ...args]); if (fail) throw Error(); }, revokeMessage: async (...args) => { calls.push(['revoke', ...args]); if (fail) throw Error(); }, sendMedia: async (...args) => { calls.push(['media', ...args]); return 'VOICE'; } };
    const message = { id: 'OWN', jid: '987654321@s.whatsapp.net', text: 'hello', outgoing: true, time: Date.now() };
    store.remember(account.id, message);
    store.remember(account.id, { ...message, id: 'IN', outgoing: false });
    store.remember(other.id, { ...message, id: 'FOREIGN' });
    await assert.rejects(rt.messageAction('FOREIGN', 'revoke'), /消息不存在/);
    await assert.rejects(rt.messageAction('IN', 'revoke'), /只能撤回/);
    await assert.rejects(rt.messageAction('OWN', 'forward', 'invalid'), /目标无效/);
    assert.equal(calls.length, 0);
    await rt.messageAction('IN', 'forward', '123456789@s.whatsapp.net');
    assert.deepEqual(calls[0], ['forward', 'false_987654321@c.us_IN', '123456789@s.whatsapp.net']);
    fail = true;
    await assert.rejects(rt.messageAction('OWN', 'revoke'), /撤回失败/);
    assert.equal(store.messages(account.id).find(m => m.id === 'OWN').text, 'hello');
    await assert.rejects(rt.messageAction('IN', 'forward', '123456789@s.whatsapp.net'), /转发失败/);
    fail = false; await rt.messageAction('OWN', 'revoke');
    assert.equal(store.messages(account.id).find(m => m.id === 'OWN').revoked, true);
    assert.equal(store.setMessageAttachment(account.id, 'OWN', { id: 'late-download' }), false, 'a pending media download must not restore revoked content');
    store.remember(account.id, { ...message, manual: true });
    assert.equal(store.messages(account.id).find(m => m.id === 'OWN').text, '此消息已撤回');
    await assert.rejects(rt.messageAction('OWN', 'forward', '123456789@s.whatsapp.net'), /已撤回/);
    await mkdir(rt.mediaDir, { recursive: true }); await writeFile(path.join(rt.mediaDir, 'voice.bin'), 'fixture');
    await rt.sendMedia(message.jid, { id: 'voice', type: 'audio', mime: 'audio/webm' }, '', true);
    assert.equal(calls.at(-1).at(-1), true, 'recorded audio sends as PTT');
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true }); }
});


test('message receipts survive early send races, history refresh and account isolation without regressing read state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-receipts-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('receipt-admin', '123456'); const user = store.byName('receipt-admin');
    const a = store.createAccount(user.id, 'One'), b = store.createAccount(user.id, 'Two');
    rt = await new WhatsAppAccount(a, store, dir).init();
    const jid = '123456789@s.whatsapp.net', message = { id: 'OUT', jid, name: 'Test', outgoing: true, text: 'hello', time: Date.now(), manual: true };
    store.remember(b.id, message);
    await rt.onClientEvent({ type: 'receipt', id: 'true_123456789@c.us_OUT', jid: '123456789@c.us', ack: 2 }, rt.generation);
    rt.remember(message); assert.equal(store.messages(a.id)[0].ack, 2, 'receipt may arrive before send API stores the message');
    assert.equal(store.messages(b.id)[0].ack, undefined);
    await rt.onClientEvent({ type: 'receipt', id: 'OUT', jid: '123456789@c.us', ack: 3 }, rt.generation);
    store.remember(a.id, { ...message, ack: 1 });
    store.remember(a.id, { ...message, manual: false, history: true, ack: 0 });
    assert.equal(store.messages(a.id)[0].ack, 3, 'manual echoes and stale history cannot downgrade read state');
    await rt.onClientEvent({ type: 'receipt', id: 'OUT', jid: '999999999@c.us', ack: 4 }, rt.generation);
    assert.equal(store.messages(a.id)[0].ack, 3, 'wrong conversation cannot update the same stanza ID');
    await rt.onClientEvent({ type: 'receipt', id: 'OUT', jid: '123456789@c.us', ack: 5 }, rt.generation);
    assert.equal(store.messages(a.id)[0].ack, 3, 'peer acknowledgement is not a read receipt');
    rt.remember({ ...message, id: 'FAIL' });
    await rt.onClientEvent({ type: 'receipt', id: 'FAIL', jid, ack: -5 }, rt.generation);
    assert.equal(store.messages(a.id).find(m => m.id === 'FAIL').ack, -5);
    const reopen = new Store(dir); assert.equal(reopen.messages(a.id)[0].ack, 3); reopen.close();
    store.revokeMessage(a.id, 'OUT'); assert.equal(store.updateReceipt(a.id, 'OUT', jid, 4), false);
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true }); }
});

test('single-message text repair validates stored ownership, connection generation and never triggers automation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-reread-')); const store = new Store(dir);
  let rt;
  try {
    await store.bootstrap('reread-admin', '123456'); const owner = store.byName('reread-admin');
    const account = store.createAccount(owner.id, 'One');
    rt = await new WhatsAppAccount(account, store, dir).init();
    const jid = '123456789@s.whatsapp.net', raw = { id: 'TEXT', chatId: '123456789@c.us', type: 'chat', body: '真实文字', timestamp: Date.now() / 1000 };
    store.remember(account.id, { id: 'TEXT', jid, text: '[非文本消息]', time: Date.now(), outgoing: false });
    rt.state.status = 'connected'; rt.state.user = { id: '987654321@s.whatsapp.net' };
    let sends = 0; rt.automation.handle = () => { sends++; };
    rt.client = { close: async () => {}, readMessage: async (source, chat) => { assert.equal(source, 'false_123456789@c.us_TEXT'); assert.equal(chat, jid); return raw; } };
    const result = await rt.refreshMessage('TEXT'); assert.equal(result.recovered, true); assert.equal(result.message.text, '真实文字'); assert.equal(sends, 0);
    await assert.rejects(rt.refreshMessage('FOREIGN'), /消息不存在/);
    rt.client.readMessage = async () => ({ ...raw, chatId: '999999999@c.us' });
    await assert.rejects(rt.refreshMessage('TEXT'), /不匹配/);
    rt.client.readMessage = async () => { rt.generation++; return raw; };
    await assert.rejects(rt.refreshMessage('TEXT'), /连接已变更/);
    rt.client.readMessage = async () => { throw Error('private error'); };
    await assert.rejects(rt.refreshMessage('TEXT'), /暂未提供/);
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('rejected live messages retain actionable per-reason counters and sanitized envelope shapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-reject-')); const store = new Store(dir); let rt;
  try {
    await store.bootstrap('reject-admin', '123456'); rt = await new WhatsAppAccount(store.createAccount(store.byName('reject-admin').id, 'One'), store, dir).init();
    const raw = { id: 'SECRET-ID', chatId: '123456789:4@c.us', type: 'chat', body: 'private text', timestamp: Date.now() / 1000 };
    await rt.onClientEvent({ type: 'message', message: raw }, rt.generation);
    await rt.onClientEvent({ type: 'message', message: { ...raw, chatId: '123456789@c.us', timestamp: 0 } }, rt.generation);
    assert.equal(rt.receiver.rejectionReasons.UNSUPPORTED_CHAT_FORMAT, 1); assert.equal(rt.receiver.rejectionReasons.INVALID_TIMESTAMP, 1);
    assert.equal(rt.receiver.lastRejection.reason, 'INVALID_TIMESTAMP'); assert.equal(rt.receiver.lastMessageAt, null);
    assert.doesNotMatch(JSON.stringify(rt.receiver), /SECRET-ID|123456789|private text/);
  } finally { await rt?.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
