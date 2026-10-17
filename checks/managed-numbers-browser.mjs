import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { Store } from '../store.js';
import { browserExecutable } from '../wa-js-client.js';

const dir = await mkdtemp('/tmp/blue-managed-browser-'); const store = new Store(dir);
await store.bootstrap('pool-admin', '123456'); const admin = store.byName('pool-admin');
const user = await store.createUser('pool-customer', '123456'); store.grant(admin.id, user.id, { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 86400000).toISOString() });
const legacy = store.createAccount(user.id, 'Existing own number');
const service = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'development', ADMIN_USER: 'pool-admin', ADMIN_PASSWORD: '123456', PUBLIC_ORIGIN: '', AUTO_CONNECT: 'false', PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => { let output = ''; service.stdout.on('data', chunk => { output += chunk; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); }); service.once('exit', code => reject(Error(`Server exited ${code}`))); });
  const base = `http://127.0.0.1:${port}`;
  browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const adminContext = await browser.createBrowserContext(), userContext = await browser.createBrowserContext();
  const page = await adminContext.newPage(), customer = await userContext.newPage(); const errors = [], adminRequests = [];
  for (const p of [page, customer]) p.on('pageerror', e => errors.push(e.message));
  page.on('request', req => adminRequests.push(new URL(req.url()).pathname));
  async function login(p, name) { await p.goto(base); await p.type('#username', name); await p.type('#password', '123456'); await p.click('#auth-submit'); await p.waitForFunction(() => !document.getElementById('workspace').hidden); }
  await login(page, 'pool-admin'); await page.click('#nav-admin');
  await page.waitForSelector('#admin-users input[type=number]');
  await page.$eval('#admin-users input[type=number]', el => { el.value = '3'; });
  const saved = page.waitForResponse(r => r.url().endsWith(`/api/admin/users/${user.id}`) && r.request().method() === 'PATCH');
  await page.click('#admin-users button[type=submit]'); assert.equal((await saved).status(), 200);
  assert.equal(store.publicUser(store.user(user.id)).limit, 3);
  page.once('dialog', d => d.accept('Managed customer number'));
  await page.click('#admin-add-number'); await page.waitForSelector('#pool-device-dialog[open]');
  await page.waitForFunction(() => document.getElementById('pool-device-status').textContent.includes('未连接'));
  assert.ok(!adminRequests.some(path => /\/api\/accounts\/[^/]+\/(events|state)/.test(path)), 'admin provisioning never opens message state or stream');
  await page.click('#pool-device-close');
  const poolId = store.managedAccounts()[0].id; const poolRow = `#admin-numbers [data-number-id="${poolId}"]`;
  await page.waitForSelector(`${poolRow} select`); await page.select(`${poolRow} select`, user.id);
  page.once('dialog', d => d.accept()); const allocated = page.waitForResponse(r => r.url().endsWith('/assignment') && r.request().method() === 'PATCH');
  await page.click(`${poolRow} button`); assert.equal((await allocated).status(), 200);
  await page.waitForFunction(() => document.getElementById('admin-numbers').textContent.includes('pool-customer'));
  const pool = store.managedAccounts()[0]; store.remember(pool.id, { id: 'PRIVATE', jid: '123456789@s.whatsapp.net', name: 'Customer', text: 'Only assigned user can see', time: Date.now() });
  await login(customer, 'pool-customer'); await customer.waitForFunction(() => Array.from(document.getElementById('account-select').options).filter(o => o.value).length === 2);
  for (const id of ['add-account', 'sync-messages', 'open-device', 'remove-account']) assert.equal(await customer.$eval(`#${id}`, el => el.hidden), true, `legacy user control ${id} must be hidden`);
  for (const action of ['connect', 'logout', 'sync']) assert.equal(await customer.evaluate(async ({ id, action }) => (await fetch(`/api/accounts/${id}/${action}`, { method: 'POST' })).status, { id: legacy.id, action }), 403);
  assert.equal((await customer.evaluate(async () => (await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Forbidden' }) })).status)), 403);
  await customer.select('#account-select', pool.id); await customer.waitForSelector('.chat-item');
  assert.equal(await customer.$eval('#open-device', el => el.hidden), true);
  assert.equal(await customer.$eval('#remove-account', el => el.hidden), true);
  assert.match(await customer.$eval('.chat-item', el => el.textContent), /Only assigned user/);
  assert.ok(!(await page.$eval('#workspace', el => el.textContent)).includes('Only assigned user'));
  await page.select(`${poolRow} select`, ''); page.once('dialog', d => d.accept()); const reclaimed = page.waitForResponse(r => r.url().endsWith('/assignment') && r.request().method() === 'PATCH'); await page.click(`${poolRow} button`); assert.equal((await reclaimed).status(), 200);
  await customer.waitForFunction(id => !Array.from(document.getElementById('account-select').options).some(o => o.value === id), {}, pool.id);
  assert.equal(await customer.$eval('#account-select', el => el.value), legacy.id);
  assert.equal(await customer.$$eval('.chat-item', els => els.length), 0);
  assert.equal(await customer.evaluate(async id => (await fetch(`/api/accounts/${id}/state`)).status, pool.id), 404);
  assert.deepEqual(errors, []);
  console.log('PASS: admin custom quota/provision/assign/reclaim UI loads no message streams; customers keep legacy numbers, cannot add numbers, and lose reclaimed chat access immediately.');
} finally {
  await browser?.close(); if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  store.close(); await rm(dir, { recursive: true, force: true });
}
