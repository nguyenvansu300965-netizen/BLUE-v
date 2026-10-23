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
  await page.evaluateOnNewDocument(() => {
    window.testStreams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 1; window.testStreams.push(this); }
      close() { this.readyState = 2; }
    };
  });
  await page.goto(`http://127.0.0.1:${port}`); await page.type('#username', 'chat-admin'); await page.type('#password', '123456'); await page.click('#auth-submit');
  await page.waitForSelector('.chat-item');
  await page.click('.chat-item');
  await page.type('#text', '尚未发送的草稿');
  store.remember(account.id, { id: 'NEW-FALLBACK', jid, name: 'Rose', text: '无需刷新自动补读', outgoing: false, time: Date.now() });
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('无需刷新自动补读'), { timeout: 12000 });
  assert.equal(await page.$eval('#text', el => el.value), '尚未发送的草稿');
  assert.equal(await page.evaluate(() => selectedThread), jid);
  const oldStreamCount = await page.evaluate(() => { const n = window.testStreams.length; window.testStreams.at(-1).readyState = 2; return n; });
  await page.waitForFunction(count => window.testStreams.length > count, { timeout: 6000 }, oldStreamCount);
  assert.equal(await page.$eval('#text', el => el.value), '尚未发送的草稿', 'reopening SSE preserves the composer');

  // A pushed snapshot should render immediately and win against an older poll.
  await page.evaluate(async id => {
    const state = await (await fetch(`/api/accounts/${id}/state`)).json();
    window.oldPollState = state;
    window.freshPushState = { ...state, messages: [...state.messages, { id: 'PUSH-NEWEST', jid: selectedThread, text: '即时推送比慢请求更新', outgoing: false, time: Date.now() }] };
    window.savedApi = api; window.pollWaiting = false;
    api = async (url, options) => {
      if (url.endsWith('/state')) return new Promise(resolve => { window.pollWaiting = true; window.releaseOldPoll = () => resolve(window.oldPollState); });
      return window.savedApi(url, options);
    };
    window.dispatchEvent(new Event('focus'));
  }, account.id);
  await page.waitForFunction(() => window.pollWaiting);
  await page.evaluate(() => { window.testStreams.at(-1).onmessage({ data: JSON.stringify(window.freshPushState) }); window.releaseOldPoll(); });
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('即时推送比慢请求更新'), { timeout: 1000 });
  assert.equal(await page.$eval('#text', el => el.value), '尚未发送的草稿');
  await page.evaluate(() => { api = window.savedApi; });
  // A delayed account-A poll must never paint account B after switching numbers.
  await page.evaluate(() => {
    window.pollWaiting = false;
    api = async (url, options) => {
      if (url.endsWith('/state')) return new Promise(resolve => { window.pollWaiting = true; window.releaseForeignPoll = () => resolve(window.freshPushState); });
      return window.savedApi(url, options);
    };
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(() => window.pollWaiting);
  await page.evaluate(() => { api = window.savedApi; });
  await page.select('#account-select', second.id);
  await page.evaluate(() => window.releaseForeignPoll());
  await page.waitForFunction(id => selectedAccount === id, {}, second.id);
  assert.ok(!await page.$eval('#messages', el => el.textContent.includes('即时推送比慢请求更新')));
  assert.equal(await page.$eval('#text', el => el.value), '');
  assert.deepEqual(errors, []);
  console.log('PASS: stalled SSE updates automatically through polling; draft/chat stay intact; fresh pushes win poll races; number switches reject delayed snapshots.');
} finally {
  await browser?.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  store.close(); await rm(dir, { recursive: true, force: true });
}
