import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
function legacyAccount(dir, user, label) { const store = new Store(dir); try { return store.createAccount(user, label); } finally { store.close(); } }

const origin = 'https://blue.example';
async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'production', ADMIN_USER: 'test-admin', ADMIN_PASSWORD: 'test-password-123', PUBLIC_ORIGIN: origin, AUTO_CONNECT: 'false', PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code} ${errors}`)));
  });
  return { child, base: `http://127.0.0.1:${port}`, stop: async () => { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
}
function client(base) {
  let cookie = '';
  return {
    async request(route, { method = 'GET', body, headers = {}, ...options } = {}) {
      const response = await fetch(`${base}${route}`, { method, ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    },
    getCookie: () => cookie,
    setCookie: value => { cookie = value; }
  };
}
const credentials = username => ({ username, password: 'strong-test-password-123' });
const grant = (plan, enabled = true, expiresAt = new Date(Date.now() + 86400000).toISOString()) => ({ plan, enabled, expiresAt });

test('multi-tenant registration, admin grants, account quotas, isolation, revocation and persistence', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blue-api-'));
  let service = await launch(dataDir);
  try {
    const anonymous = client(service.base), admin = client(service.base), alice = client(service.base), bob = client(service.base);
    assert.equal((await anonymous.request('/healthz')).status, 200);
    assert.match(await (await anonymous.request('/')).text(), /多账号 WhatsApp 工作台/);
    assert.equal((await anonymous.request('/api/accounts')).status, 401);
    assert.equal((await anonymous.request('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'incorrect-password' } })).status, 401);
    const login = await admin.request('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-password-123' } });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /Secure/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    const registered = await anonymous.request('/api/auth/register', { method: 'POST', body: { ...credentials('alice'), role: 'admin', enabled: true, plan: 'vip' } });
    assert.equal(registered.status, 201);
    const aliceUser = (await registered.json()).user; assert.equal(aliceUser.role, 'user'); assert.equal(aliceUser.active, false);
    assert.equal((await anonymous.request('/api/auth/register', { method: 'POST', body: credentials('ALICE') })).status, 409);
    const bobUser = (await (await anonymous.request('/api/auth/register', { method: 'POST', body: credentials('bob-user') })).json()).user;
    await alice.request('/api/auth/login', { method: 'POST', body: credentials('alice') });
    await bob.request('/api/auth/login', { method: 'POST', body: credentials('bob-user') });
    assert.equal((await alice.request('/api/admin/users')).status, 403);
    assert.equal((await alice.request('/api/accounts', { method: 'POST', body: { label: 'Pending' } })).status, 403);
    assert.equal((await alice.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('vip') })).status, 403);
    assert.equal((await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('unlimited') })).status, 400);
    await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('basic') });
    await admin.request(`/api/admin/users/${bobUser.id}`, { method: 'PATCH', body: grant('basic') });
    const creates = await Promise.all([alice.request('/api/accounts', { method: 'POST', body: { label: 'Alice 1' } }), alice.request('/api/accounts', { method: 'POST', body: { label: 'Alice 2' } })]);
    assert.deepEqual(creates.map(r => r.status).sort(), [403, 403]);
    const account = legacyAccount(dataDir, aliceUser.id, 'Existing Alice');
    const base = `/api/accounts/${account.id}`;
    const bobAccount = legacyAccount(dataDir, bobUser.id, 'Existing Bob');
    assert.equal((await bob.request(`${base}/state`)).status, 404);
    assert.equal((await bob.request(`${base}/sync`, { method: 'POST' })).status, 404);
    assert.equal((await alice.request(`${base}/sync`, { method: 'POST' })).status, 409);
    assert.equal((await bob.request(`${base}/connect`, { method: 'POST' })).status, 404);
    assert.equal((await bob.request(`${base}/flows`)).status, 404);
    assert.equal((await bob.request(`${base}/messages/PRIVATE/media`, { method: 'POST' })).status, 404);
    assert.equal((await bob.request(`${base}/messages/missing/forward`, { method: 'POST', body: { phone: '123456789' } })).status, 404);
    assert.equal((await bob.request(`${base}/messages/missing/revoke`, { method: 'POST' })).status, 404);
    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', body: { phone: '123456789', text: 'hello', voice: true } })).status, 400);
    assert.equal((await bob.request(`${base}/contacts`, { method: 'PATCH', body: { jid: '123456789@s.whatsapp.net', remark: 'foreign' } })).status, 404);
    assert.equal((await alice.request(`${base}/contacts`, { method: 'PATCH', body: { jid: '123456789@s.whatsapp.net', remark: 'missing' } })).status, 404);
    assert.equal((await alice.request(`${base}/messages/missing/media`, { method: 'POST' })).status, 404);
    assert.equal((await bob.request(base, { method: 'DELETE' })).status, 404);
    const state = await (await alice.request(`${base}/state`)).json(); assert.equal(state.status, 'idle'); assert.deepEqual(state.messages, []);
    assert.equal(state.user, null); assert.equal(state.account.user_id, aliceUser.id);
    const bobState = await (await bob.request(`/api/accounts/${bobAccount.id}/state`)).json();
    assert.equal(bobState.status, 'idle'); assert.equal(bobState.user, null); assert.equal(bobState.account.user_id, bobUser.id);
    const mismatch = await bob.request('/api/accounts', { method: 'POST', headers: { 'X-Workspace-User': aliceUser.id }, body: { label: 'Wrong browser tab' } });
    assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).code, 'SESSION_CHANGED');
    assert.equal((await bob.request(`/api/accounts/${bobAccount.id}/events?workspaceUser=${aliceUser.id}`)).status, 409);
    assert.equal((await alice.request('/api/accounts', { headers: { 'X-Workspace-User': aliceUser.id } })).status, 200);
    assert.equal((await bob.request('/api/auth/logout', { method: 'POST', headers: { 'X-Workspace-User': aliceUser.id } })).status, 409);
    assert.equal((await bob.request('/api/auth/me')).status, 200, 'old tabs must not log out a different browser identity');
    assert.equal((await (await bob.request('/api/accounts')).json()).accounts.length, 1, 'wrong browser identity must not create a number');

    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', body: { phone: 'bad', text: 'hello' } })).status, 400);
    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', body: { phone: '8613800138000', text: 'hello' } })).status, 409);
    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', body: { jid: '123456789@lid', text: 'hello' } })).status, 400);
    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { phone: '8613800138000', text: 'hello' } })).status, 403);
    assert.equal((await alice.request(`${base}/messages`, { method: 'POST', headers: { Origin: origin }, body: { phone: '8613800138000', text: 'hello' } })).status, 409);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1kAAAAASUVORK5CYII=', 'base64');
    const upload = await alice.request(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image }); assert.equal(upload.status, 200);
    const asset = (await upload.json()).id;
    assert.equal((await alice.request(`${base}/media/${asset}`)).status, 200);
    assert.equal((await bob.request(`${base}/media/${asset}`)).status, 404);
    assert.equal((await bob.request(`/api/accounts/${bobAccount.id}/media/${asset}`)).status, 404);
    const flow = { enabled: true, mode: 'numbered', triggerMode: 'keywords', nodes: [{ id: 'hi', name: 'Welcome', text: 'Hello', triggers: ['hi'], image: asset, options: [] }] };
    assert.equal((await alice.request(`${base}/flows`, { method: 'POST', body: flow })).status, 200);
    assert.equal((await bob.request(`/api/accounts/${bobAccount.id}/flows`, { method: 'POST', body: flow })).status, 400);
    // Shared examples are editable only by admins; images are copied into each owner's storage.
    assert.equal((await anonymous.request('/api/templates')).status, 401);
    const templates = (await (await alice.request('/api/templates')).json()).templates;
    assert.equal(templates.length, 2);
    assert.equal((await alice.request(`${base}/templates`, { method: 'POST', body: { name: 'Denied', config: flow } })).status, 403);
    assert.equal((await alice.request(`/api/admin/templates/${templates[0].id}`, { method: 'DELETE' })).status, 403);
    const adminId = (await (await admin.request('/api/auth/me')).json()).user.id;
    const adminAccount = legacyAccount(dataDir, adminId, 'Existing template editor');
    const adminBase = `/api/accounts/${adminAccount.id}`;
    const adminAsset = (await (await admin.request(`${adminBase}/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image })).json()).id;
    assert.equal((await admin.request(`/api/admin/templates/${templates[1].id}`, { method: 'DELETE' })).status, 200);
    const templateFlow = { ...flow, nodes: [{ ...flow.nodes[0], image: adminAsset }] };
    assert.equal((await admin.request(`${adminBase}/templates`, { method: 'POST', body: { id: templates[0].id, name: '示例1管理员修改', config: templateFlow } })).status, 200);
    const createdTemplate = await admin.request(`${adminBase}/templates`, { method: 'POST', body: { name: '示例3', config: templateFlow } });
    assert.equal(createdTemplate.status, 200);
    const savedTemplate = await createdTemplate.json();
    templateFlow.nodes[0].text = 'Updated shared example';
    assert.equal(savedTemplate.revision, 1);
    const updateTemplate = await admin.request(`${adminBase}/templates`, { method: 'POST', body: { id: savedTemplate.id, name: '示例3已更新', config: templateFlow, revision: 1 } });
    assert.equal(updateTemplate.status, 200); assert.equal((await updateTemplate.json()).revision, 2);
    assert.equal((await admin.request(`${adminBase}/templates`, { method: 'POST', body: { id: savedTemplate.id, name: 'stale tab', config: flow, revision: 1 } })).status, 409);
    const details = await (await bob.request(`/api/accounts/${bobAccount.id}/templates/${savedTemplate.id}/load?details=1`, { method: 'POST' })).json();
    assert.deepEqual(details.template, { id: savedTemplate.id, name: '示例3已更新', revision: 2 });
    assert.deepEqual(details.config, { ...templateFlow, enabled: false });
    assert.equal((await bob.request(`${adminBase}/templates/${savedTemplate.id}/load`, { method: 'POST' })).status, 404);
    const loadedTemplate = await (await bob.request(`/api/accounts/${bobAccount.id}/templates/${savedTemplate.id}/load`, { method: 'POST' })).json();
    assert.deepEqual(loadedTemplate, { ...templateFlow, enabled: false });
    assert.deepEqual(Buffer.from(await (await bob.request(`/api/accounts/${bobAccount.id}/media/${adminAsset}`)).arrayBuffer()), image);
    assert.equal((await bob.request(`/api/accounts/${bobAccount.id}/flows`, { method: 'POST', body: loadedTemplate })).status, 200);
    assert.deepEqual(await (await alice.request(`${base}/flows`)).json(), flow, 'loading a template must not alter another account');
    for (const [plan, limit] of [['pro', 5], ['vip', 10]]) {
      await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant(plan) });
      while ((await (await alice.request('/api/accounts')).json()).accounts.length < limit) legacyAccount(dataDir, aliceUser.id, `Existing ${plan}`);
      assert.equal((await alice.request('/api/accounts', { method: 'POST', body: { label: 'Overflow' } })).status, 403);
    }
    const controller = new AbortController();
    const stream = await alice.request(`${base}/events`, { signal: controller.signal });
    const reader = stream.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /"status":"idle"/);
    await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('basic', false) });
    const revoked = new TextDecoder().decode((await reader.read()).value); assert.match(revoked, /revoked/); controller.abort();
    assert.equal((await alice.request(`${base}/state`)).status, 403);
    assert.equal((await alice.request(`${base}/flows`)).status, 403);
    await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('basic') });
    const downgraded = (await (await alice.request('/api/accounts')).json()).accounts;
    assert.equal(downgraded.filter(a => a.allowed).length, 1);
    const blocked = downgraded.find(a => !a.allowed);
    assert.equal((await alice.request(`/api/accounts/${blocked.id}/connect`, { method: 'POST' })).status, 403);
    assert.equal((await alice.request(`/api/accounts/${blocked.id}`, { method: 'DELETE' })).status, 200);
    await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('basic', true, new Date(Date.now() + 1000).toISOString()) });
    const expiringController = new AbortController();
    const expiryTimeout = setTimeout(() => expiringController.abort(), 10000); expiryTimeout.unref();
    const expiringStream = await alice.request(`${base}/events`, { signal: expiringController.signal });
    const expiringReader = expiringStream.body.getReader();
    let revokedByExpiry = false;
    while (!revokedByExpiry) {
      const chunk = await expiringReader.read();
      if (chunk.done) break;
      revokedByExpiry = new TextDecoder().decode(chunk.value).includes('event: revoked');
    }
    assert.equal(revokedByExpiry, true, 'expiry must revoke an already-open event stream without a new client request');
    expiringController.abort(); clearTimeout(expiryTimeout);
    assert.equal((await alice.request(`${base}/connect`, { method: 'POST' })).status, 403);
    await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant('basic') });
    const cookie = alice.getCookie();
    await service.stop(); service = await launch(dataDir);
    const restored = client(service.base); restored.setCookie(cookie);
    assert.equal((await restored.request('/api/auth/me')).status, 200);
    assert.deepEqual(await (await restored.request(`${base}/flows`)).json(), flow);
    await restored.request('/api/auth/logout', { method: 'POST' });
    restored.setCookie(cookie); assert.equal((await restored.request('/api/accounts')).status, 401);
    const adminRestored = client(service.base); await adminRestored.request('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-password-123' } });
    const persistedExamples = (await (await adminRestored.request('/api/templates')).json()).templates;
    assert.ok(!persistedExamples.some(item => item.id === templates[1].id), 'deleted defaults must not return after restart');
    assert.ok(persistedExamples.some(item => item.id === templates[0].id && item.name === '示例1管理员修改'));
    assert.ok((await (await adminRestored.request('/api/templates')).json()).templates.some(item => item.id === savedTemplate.id && item.name === '示例3已更新'));
    assert.equal((await adminRestored.request(`/api/admin/templates/${savedTemplate.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await restored.request(`${base}/templates/${savedTemplate.id}/load`, { method: 'POST' })).status, 401);
    assert.ok(!(await (await adminRestored.request('/api/templates')).json()).templates.some(item => item.id === savedTemplate.id));
    const adminData = await (await adminRestored.request('/api/admin/users')).json();
    assert.ok(adminData.audit.length >= 4); assert.ok(!JSON.stringify(adminData).includes('password_hash'));
  } finally { await service.stop(); await rm(dataDir, { recursive: true }); }
});

test('six-character passwords, admin password changes/reset and isolated media uploads', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blue-password-media-'));
  let service = await launch(dataDir);
  try {
    const anonymous = client(service.base), admin = client(service.base), user = client(service.base), other = client(service.base);
    assert.equal((await anonymous.request('/api/auth/register', { method: 'POST', body: { username: 'short-pass', password: '12345' } })).status, 400);
    const registered = await anonymous.request('/api/auth/register', { method: 'POST', body: { username: 'six-pass', password: '123456' } });
    assert.equal(registered.status, 201); const uid = (await registered.json()).user.id;
    await admin.request('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-password-123' } });
    assert.equal((await user.request('/api/auth/login', { method: 'POST', body: { username: 'six-pass', password: '123456' } })).status, 200);
    await admin.request(`/api/admin/users/${uid}`, { method: 'PATCH', body: grant('basic') });
    const account = legacyAccount(dataDir, uid, 'Existing media');
    const base = `/api/accounts/${account.id}`;
    const file = Buffer.from('%PDF-1.4\ntest attachment');
    const uploaded = await user.request(`${base}/attachments?${new URLSearchParams({ mime: 'application/pdf', name: '报价单.pdf' })}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    assert.equal(uploaded.status, 200); const item = (await uploaded.json()).attachment;
    assert.equal(item.type, 'document'); assert.equal(item.size, file.length);
    const download = await user.request(`${base}/attachments/${item.id}`);
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);
    assert.equal((await anonymous.request(`${base}/attachments/${item.id}`)).status, 401);
    assert.equal((await user.request(`${base}/attachments?mime=text/html&name=page.html`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })).status, 400);
    assert.equal((await user.request(`${base}/attachments?mime=application/pdf&name=large.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(20 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await user.request(`${base}/messages`, { method: 'POST', body: { phone: '123456789', attachment: item.id } })).status, 409, 'valid file-only send still requires a WhatsApp connection');
    assert.equal((await user.request(`${base}/messages`, { method: 'POST', body: { phone: '123456789', attachment: 'missing' } })).status, 400);
    assert.equal((await user.request(`/api/admin/users/${uid}/password`, { method: 'POST', body: { password: 'abcdef' } })).status, 403);
    assert.equal((await admin.request(`/api/admin/users/${uid}/password`, { method: 'POST', body: { password: '12345' } })).status, 400);
    assert.equal((await user.request('/api/auth/me')).status, 200, 'invalid password must not revoke login');
    const controller = new AbortController();
    const stream = await user.request(`${base}/events`, { signal: controller.signal }); const reader = stream.body.getReader(); await reader.read();
    assert.equal((await admin.request(`/api/admin/users/${uid}/password`, { method: 'POST', body: { password: 'abcdef' } })).status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /revoked/); controller.abort();
    assert.equal((await user.request('/api/auth/me')).status, 401);
    assert.equal((await user.request('/api/auth/login', { method: 'POST', body: { username: 'six-pass', password: '123456' } })).status, 401);
    assert.equal((await user.request('/api/auth/login', { method: 'POST', body: { username: 'six-pass', password: 'abcdef' } })).status, 200);
    const reset = await admin.request(`/api/admin/users/${uid}/password`, { method: 'POST', body: { reset: true } });
    assert.equal(reset.status, 200); const generated = (await reset.json()).password; assert.ok(generated.length >= 20);
    assert.equal((await user.request('/api/auth/me')).status, 401);
    assert.equal((await user.request('/api/auth/login', { method: 'POST', body: { username: 'six-pass', password: generated } })).status, 200);
    const audit = await (await admin.request('/api/admin/users')).json();
    assert.ok(audit.audit.some(e => e.action === 'password_change')); assert.ok(audit.audit.some(e => e.action === 'password_reset'));
    assert.ok(!JSON.stringify(audit).includes(generated)); assert.ok(!JSON.stringify(audit).includes('abcdef'));
    const otherUser = (await (await anonymous.request('/api/auth/register', { method: 'POST', body: { username: 'media-other', password: '654321' } })).json()).user;
    await admin.request(`/api/admin/users/${otherUser.id}`, { method: 'PATCH', body: grant('basic') });
    await other.request('/api/auth/login', { method: 'POST', body: { username: 'media-other', password: '654321' } });
    const otherAccount = legacyAccount(dataDir, otherUser.id, 'Existing other');
    assert.equal((await other.request(`${base}/attachments/${item.id}`)).status, 404);
    assert.equal((await other.request(`/api/accounts/${otherAccount.id}/messages`, { method: 'POST', body: { phone: '123456789', attachment: item.id } })).status, 400);
    await service.stop(); service = await launch(dataDir);
    const restored = client(service.base);
    assert.equal((await restored.request('/api/auth/login', { method: 'POST', body: { username: 'six-pass', password: generated } })).status, 200);
    assert.deepEqual(Buffer.from(await (await restored.request(`${base}/attachments/${item.id}`)).arrayBuffer()), file);
  } finally { await service.stop(); await rm(dataDir, { recursive: true }); }
});

test('admin-managed numbers transfer without exposing messages to admin; custom quotas include legacy numbers', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blue-assignments-')); let service = await launch(dataDir);
  try {
    const admin = client(service.base), alice = client(service.base), bob = client(service.base), anonymous = client(service.base);
    await admin.request('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-password-123' } });
    const aliceUser = (await (await anonymous.request('/api/auth/register', { method: 'POST', body: credentials('assigned-alice') })).json()).user;
    const bobUser = (await (await anonymous.request('/api/auth/register', { method: 'POST', body: credentials('assigned-bob') })).json()).user;
    await alice.request('/api/auth/login', { method: 'POST', body: credentials('assigned-alice') }); await bob.request('/api/auth/login', { method: 'POST', body: credentials('assigned-bob') });
    assert.equal((await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: { ...grant('basic'), limit: 2 } })).status, 200);
    await admin.request(`/api/admin/users/${bobUser.id}`, { method: 'PATCH', body: { ...grant('basic'), limit: 1 } });
    const existing = legacyAccount(dataDir, aliceUser.id, 'Existing self-owned');
    assert.equal((await alice.request('/api/accounts', { method: 'POST', body: { label: 'No new self-owned' } })).status, 403);
    assert.equal((await alice.request(`/api/accounts/${existing.id}/state`)).status, 200);
    assert.equal((await alice.request('/api/admin/numbers')).status, 403);
    const pool = (await (await admin.request('/api/admin/numbers', { method: 'POST', body: { label: 'Provisioned' } })).json()).account;
    assert.equal((await alice.request(`/api/accounts/${pool.id}/state`)).status, 404);
    assert.equal((await admin.request(`/api/accounts/${pool.id}/state`)).status, 404, 'admin pool never grants chat access');
    const state = await (await admin.request(`/api/admin/numbers/${pool.id}/state`)).json();
    assert.equal(Object.hasOwn(state, 'messages'), false); assert.equal(Object.hasOwn(state, 'contacts'), false);
    const assign = (id, userId) => admin.request(`/api/admin/numbers/${id}/assignment`, { method: 'PATCH', body: { userId } });
    assert.equal((await assign(pool.id, aliceUser.id)).status, 200);
    assert.equal((await alice.request(`/api/accounts/${pool.id}/state`)).status, 200);
    assert.equal((await alice.request(`/api/accounts/${pool.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await alice.request(`/api/accounts/${pool.id}/logout`, { method: 'POST' })).status, 403);
    assert.equal((await alice.request(`/api/accounts/${pool.id}/connect`, { method: 'POST' })).status, 403);
    const extra = (await (await admin.request('/api/admin/numbers', { method: 'POST', body: { label: 'Another' } })).json()).account;
    assert.equal((await assign(extra.id, aliceUser.id)).status, 409, 'legacy self-owned number counts toward quota');
    assert.equal((await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: { ...grant('basic'), limit: 4 } })).status, 200);
    assert.equal((await assign(extra.id, aliceUser.id)).status, 200, 'custom limit overrides basic plan default');
    const fixture = new Store(dataDir); const original = fixture.account(pool.id); const jid = '123456789@s.whatsapp.net';
    fixture.remember(pool.id, { id: 'PRIVATE', jid, name: 'Private contact', text: 'Number history', time: Date.now() }); fixture.close();
    const file = Buffer.from('%PDF-1.4\nkept on reassignment');
    const upload = await alice.request(`/api/accounts/${pool.id}/attachments?mime=application/pdf&name=kept.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }); assert.equal(upload.status, 200);
    const attachment = (await upload.json()).attachment;
    const controller = new AbortController(); const stream = await alice.request(`/api/accounts/${pool.id}/events`, { signal: controller.signal }); const reader = stream.body.getReader(); await reader.read();
    assert.equal((await assign(pool.id, null)).status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: revoked/); controller.abort();
    assert.equal((await alice.request(`/api/accounts/${pool.id}/state`)).status, 404);
    assert.equal((await alice.request(`/api/accounts/${pool.id}/attachments/${attachment.id}`)).status, 404);
    assert.equal((await admin.request(`/api/accounts/${pool.id}/state`)).status, 404);
    assert.equal((await assign(pool.id, bobUser.id)).status, 200);
    assert.deepEqual(Buffer.from(await (await bob.request(`/api/accounts/${pool.id}/attachments/${attachment.id}`)).arrayBuffer()), file);
    const transferred = await (await bob.request(`/api/accounts/${pool.id}/state`)).json(); assert.equal(transferred.messages[0].text, 'Number history'); assert.equal(transferred.account.storage_owner_id, original.storage_owner_id);
    assert.equal((await (await admin.request('/api/accounts')).json()).accounts.some(a => a.id === pool.id), false);
    assert.equal((await admin.request(`/api/admin/numbers/${pool.id}/connect`, { method: 'POST' })).status, 400);
    const beforeRestart = transferred.account;
    await service.stop(); service = await launch(dataDir); const restoredBob = client(service.base);
    await restoredBob.request('/api/auth/login', { method: 'POST', body: credentials('assigned-bob') });
    const restored = await (await restoredBob.request(`/api/accounts/${pool.id}/state`)).json(); assert.equal(restored.account.storage_owner_id, beforeRestart.storage_owner_id); assert.equal(restored.messages[0].text, 'Number history');
    assert.deepEqual(Buffer.from(await (await restoredBob.request(`/api/accounts/${pool.id}/attachments/${attachment.id}`)).arrayBuffer()), file);
  } finally { await service.stop(); await rm(dataDir, { recursive: true }); }
});
