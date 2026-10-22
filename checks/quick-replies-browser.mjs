import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { Store } from '../store.js';
import { browserExecutable } from '../wa-js-client.js';

const dir = await mkdtemp('/tmp/blue-chats-browser-');
const store = new Store(dir); await store.bootstrap('chat-admin', '123456');
const admin = store.byName('chat-admin'); const account = store.createAccount(admin.id, 'Chat tests');
const second = store.createAccount(admin.id, 'Other account');
const jid = '447700900123@s.whatsapp.net';
const first = { id: 'one', jid, name: 'Rose', text: 'First incoming', outgoing: false, time: Date.now() - 10000 };
store.remember(account.id, first);
const service = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'development', ADMIN_USER: 'chat-admin', ADMIN_PASSWORD: '123456', PUBLIC_ORIGIN: '', AUTO_CONNECT: 'false', PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => { let output = ''; service.stdout.on('data', chunk => { output += chunk; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); }); service.once('exit', code => reject(Error(`Server exited ${code}`))); });
  browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 800 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`); await page.type('#username', 'chat-admin'); await page.type('#password', '123456'); await page.click('#auth-submit');
  await page.waitForSelector('.chat-item');
  await page.click('.chat-item');
  await page.click('#quick-open');
  await page.waitForFunction(() => !document.getElementById('quick-save').disabled);
  await page.type('#quick-title', '产品介绍'); await page.type('#quick-text', '您好，这是产品说明');
  // Use an allowed PNG upload through the same authenticated attachment endpoint.
  const media = await page.evaluate(async id => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    return (await (await fetch(`/api/accounts/${id}/attachments?mime=image/png&name=preview.png`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json()).attachment;
  }, account.id);
  await page.evaluate(item => { document.getElementById('quick-file').value = ''; quickMedia = item; previewQuickMedia(); }, media);
  await page.click('#quick-save');
  await page.waitForFunction(() => document.getElementById('quick-error').textContent === '已保存');
  assert.equal(await page.$$eval('#quick-preview img', els => els.length), 1);
  const replyId = await page.$eval('#quick-list', el => el.value);
  assert.equal(store.quickReplies(second.id).length, 0);
  const foreign = await page.evaluate(async ({ id, media }) => {
    return (await fetch(`/api/accounts/${id}/quick-replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Wrong', text: '', attachment: media.id }) })).status;
  }, { id: second.id, media });
  assert.equal(foreign, 400, 'cannot attach another account media');
  const beforeCount = store.messages(account.id).length;
  await page.click('#quick-load');
  assert.equal(await page.$eval('#text', el => el.value), '您好，这是产品说明');
  assert.equal(await page.evaluate(() => attachmentDraft.uploaded.id), media.id);
  assert.equal(store.messages(account.id).length, beforeCount, 'loading never sends');
  await page.reload(); await page.waitForSelector('.chat-item'); await page.click('#quick-open');
  await page.waitForFunction(() => document.getElementById('quick-list').options.length === 2);
  await page.select('#quick-list', replyId); await page.type('#quick-text', ' 更新'); await page.click('#quick-save');
  await page.waitForFunction(() => document.getElementById('quick-error').textContent === '已保存');
  assert.match(store.quickReplies(account.id)[0].text, /更新$/);
  await page.click('#quick-delete'); await page.waitForFunction(() => document.getElementById('quick-list').options.length === 1);
  assert.equal(store.quickReplies(account.id).length, 0);
  await page.click('#quick-close'); await page.click('#quick-open');
  await page.waitForFunction(() => !document.getElementById('quick-save').disabled);
  await page.evaluate(() => { window.dispatchEvent(new Event('account-changed')); });
  assert.equal(await page.$eval('#quick-dialog', el => el.open), false);
  assert.deepEqual(errors, []);
  console.log('PASS: quick reply CRUD, persistent media preview, account isolation, explicit composer loading, cleanup on account change.');
} finally {
  await browser?.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  store.close(); await rm(dir, { recursive: true, force: true });
}
