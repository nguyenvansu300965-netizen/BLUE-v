import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    assert.deepEqual(creates.map(r => r.status).sort(), [201, 409]);
    const account = (await creates.find(r => r.status === 201).json()).account;
    const base = `/api/accounts/${account.id}`;
    const bobAccount = (await (await bob.request('/api/accounts', { method: 'POST', body: { label: 'Bob' } })).json()).account;
    assert.equal((await bob.request(`${base}/state`)).status, 404);
    assert.equal((await bob.request(`${base}/sync`, { method: 'POST' })).status, 404);
    assert.equal((await alice.request(`${base}/sync`, { method: 'POST' })).status, 409);
    assert.equal((await bob.request(`${base}/connect`, { method: 'POST' })).status, 404);
    assert.equal((await bob.request(`${base}/flows`)).status, 404);
    assert.equal((await bob.request(base, { method: 'DELETE' })).status, 404);
    const state = await (await alice.request(`${base}/state`)).json(); assert.equal(state.status, 'idle'); assert.deepEqual(state.messages, []);
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
    const flow = { enabled: true, mode: 'numbered', nodes: [{ id: 'hi', name: 'Welcome', text: 'Hello', triggers: ['hi'], image: asset, options: [] }] };
    assert.equal((await alice.request(`${base}/flows`, { method: 'POST', body: flow })).status, 200);
    assert.equal((await bob.request(`/api/accounts/${bobAccount.id}/flows`, { method: 'POST', body: flow })).status, 400);
    for (const [plan, limit] of [['pro', 5], ['vip', 10]]) {
      await admin.request(`/api/admin/users/${aliceUser.id}`, { method: 'PATCH', body: grant(plan) });
      while ((await (await alice.request('/api/accounts')).json()).accounts.length < limit) assert.equal((await alice.request('/api/accounts', { method: 'POST', body: { label: `Extra ${plan}` } })).status, 201);
      assert.equal((await alice.request('/api/accounts', { method: 'POST', body: { label: 'Overflow' } })).status, 409);
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
    const adminData = await (await adminRestored.request('/api/admin/users')).json();
    assert.ok(adminData.audit.length >= 4); assert.ok(!JSON.stringify(adminData).includes('password_hash'));
  } finally { await service.stop(); await rm(dataDir, { recursive: true }); }
});
