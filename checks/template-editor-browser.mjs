import assert from 'node:assert/strict';
import { Store } from '../store.js';
function legacyAccount(dir, userId, label) { const store = new Store(dir); try { return store.createAccount(userId, label); } finally { store.close(); } }
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { browserExecutable } from '../wa-js-client.js';

const dir = await mkdtemp('/tmp/blue-template-browser-');
const service = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'development', ADMIN_USER: 'template-admin', ADMIN_PASSWORD: 'admin-test-123', PUBLIC_ORIGIN: '', AUTO_CONNECT: 'false', PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    service.stdout.on('data', chunk => { output += chunk; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); });
    service.once('exit', code => reject(new Error(`Test server exited: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const admin = await browser.newPage();
  const context = await browser.createBrowserContext();
  const user = await context.newPage();
  const errors = [];
  for (const page of [admin, user]) page.on('pageerror', error => errors.push(error.message));
  const fill = (page, selector, value) => page.$eval(selector, (element, text) => { element.value = text; element.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const request = (page, url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
  async function login(page, username, password) {
    await page.goto(base);
    await fill(page, '#username', username); await fill(page, '#password', password);
    await page.click('#auth-submit');
    await page.waitForFunction(() => !document.getElementById('workspace').hidden);
    await page.waitForFunction(() => document.getElementById('current-user').textContent.length > 0);
  }
  async function openFlows(page) {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('account-select').value.length > 0);
    await page.click('#nav-flows');
    await page.waitForFunction(() => !document.getElementById('flow-example').disabled);
  }
  await login(admin, 'template-admin', 'admin-test-123');
  // Reproduce the empty-number administrator shown in the report.
  await admin.click('#nav-flows');
  await admin.waitForFunction(() => document.querySelectorAll('#flow-template option').length >= 2 && !document.getElementById('flow-save').disabled && document.querySelector('.flow-node textarea'));
  assert.equal(await admin.$eval('#account-select', el => el.value), '');
  assert.equal(await admin.$eval('#flow-add', el => el.disabled), false);
  assert.equal(await admin.$eval('#template-use', el => el.disabled), true);
  assert.equal(await admin.$eval('#flow-enabled', el => el.disabled), true);
  await fill(admin, '.flow-node textarea', 'Global template without owning a number');
  admin.once('dialog', dialog => dialog.accept('无码管理示例'));
  await admin.click('#template-new');
  await admin.waitForFunction(() => document.getElementById('flow-notice').textContent.includes('已保存为 v1'));
  const globalImage = `${dir}/global.png`;
  await writeFile(globalImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1kAAAAASUVORK5CYII=', 'base64'));
  await (await admin.$('.flow-node input[type=file]')).uploadFile(globalImage);
  await admin.waitForFunction(() => { const img = document.querySelector('.flow-node .flow-image'); return img.src.includes('/api/admin/template-assets/media/') && img.complete && img.naturalWidth > 0 && !document.getElementById('flow-save').disabled; });
  await admin.click('#flow-save'); await admin.waitForFunction(() => document.getElementById('flow-notice').textContent.includes('已保存为 v2'));
  const isolatedTemplateId = await admin.$eval('#flow-template', el => el.value);
  const globalSaved = (await request(admin, `/api/admin/templates/${isolatedTemplateId}`)).data;
  assert.equal(globalSaved.config.nodes[0].text, 'Global template without owning a number'); assert.ok(globalSaved.config.nodes[0].image);
  await admin.reload(); await admin.waitForFunction(() => !document.getElementById('workspace').hidden); await admin.click('#nav-flows');
  await admin.waitForFunction(() => !document.getElementById('flow-example').disabled);
  await admin.select('#flow-template', isolatedTemplateId); admin.once('dialog', dialog => dialog.accept()); await admin.click('#flow-example');
  await admin.waitForFunction(() => document.querySelector('.flow-node textarea')?.value === 'Global template without owning a number');
  const accountCount = (await request(admin, '/api/accounts')).data.accounts.length; assert.equal(accountCount, 0);
  const adminId = (await request(admin, '/api/auth/me')).data.user.id;
  const adminAccount = legacyAccount(dir, adminId, 'Existing admin number');
  await openFlows(admin);
  await admin.click('#flow-example');
  await admin.waitForFunction(() => !document.getElementById('template-editor').hidden && !document.getElementById('flow-save').disabled);
  assert.equal(await admin.$eval('#flow-save', element => element.textContent), '保存公共示例');
  await fill(admin, '#template-name', '示例1 · 已更新');
  await fill(admin, '.flow-node textarea', 'Updated greeting {full_name}');
  await fill(admin, '.flow-node:nth-child(2) textarea', 'Updated product reply');
  const imagePath = `${dir}/product.png`;
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1kAAAAASUVORK5CYII=', 'base64'));
  await (await admin.$('.flow-node input[type=file]')).uploadFile(imagePath);
  await admin.waitForFunction(() => document.querySelector('.flow-node .flow-image').src.includes('/media/') && !document.getElementById('flow-save').disabled);
  await admin.click('#flow-save');
  await admin.waitForFunction(() => document.getElementById('flow-notice').textContent.includes('已保存为 v2'));
  const untouched = await request(admin, `/api/accounts/${adminAccount.id}/flows`);
  assert.equal(untouched.data.nodes.length, 0, 'public save must not change the account flow');

  // A newly registered user must receive the saved shared revision, not the built-in defaults.
  await user.goto(base);
  const registered = await request(user, '/api/auth/register', 'POST', { username: 'new-template-user', password: '123456' });
  assert.equal(registered.status, 201);
  await request(admin, `/api/admin/users/${registered.data.user.id}`, 'PATCH', { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  await login(user, 'new-template-user', '123456');
  const userAccount = legacyAccount(dir, registered.data.user.id, 'Existing user number');
  await openFlows(user);
  assert.match(await user.$eval('#flow-template', element => element.selectedOptions[0].textContent), /示例1 · 已更新.*v2/);
  await user.click('#flow-example');
  await user.waitForFunction(() => document.querySelector('.flow-node textarea')?.value === 'Updated greeting {full_name}');
  assert.equal(await user.$eval('#template-editor', element => element.hidden), true);
  assert.equal(await user.$eval('#flow-save', element => element.textContent), '保存号码流程');
  assert.equal(await user.$eval('.flow-node:nth-child(2) textarea', element => element.value), 'Updated product reply');
  await user.waitForFunction(() => { const image = document.querySelector('.flow-node .flow-image'); return image.complete && image.naturalWidth > 0; });
  await user.click('#flow-enabled'); await user.click('#flow-save');
  await user.waitForFunction(() => document.getElementById('flow-notice').textContent.includes('流程已保存'));
  const saved = (await request(user, `/api/accounts/${userAccount.id}/flows`)).data;
  assert.equal(saved.nodes[0].text, 'Updated greeting {full_name}'); assert.equal(saved.enabled, true);
  assert.equal(saved.nodes[0].options[0].next, saved.nodes[1].id);

  // Verify the administrator can deliberately load the same example for their own number.
  admin.once('dialog', dialog => dialog.accept());
  await admin.click('#template-use');
  await admin.waitForFunction(() => document.getElementById('template-editor').hidden && !document.getElementById('flow-save').disabled);
  assert.equal(await admin.$eval('#flow-save', element => element.textContent), '保存号码流程');
  await admin.click('#flow-enabled'); await admin.click('#flow-save');
  await admin.waitForFunction(() => document.getElementById('flow-notice').textContent.includes('流程已保存'));
  assert.equal((await request(admin, `/api/accounts/${adminAccount.id}/flows`)).data.nodes[0].text, saved.nodes[0].text);
  assert.deepEqual(errors, []);
  console.log('PASS: an admin with zero numbers edits, uploads images, saves/reloads shared templates; admin Save updates the shared example; a newly registered user loads v2 text, image and branches; account saves remain separate.');
} finally {
  await browser?.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  await rm(dir, { recursive: true, force: true });
}
