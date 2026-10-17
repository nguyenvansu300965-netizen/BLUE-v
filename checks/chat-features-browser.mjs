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
  assert.match(await page.$eval('.chat-item', el => el.textContent), /Rose/);
  assert.match(await page.$eval('.chat-contact-details', el => el.textContent), /\+447700900123/);
  assert.equal(await page.$eval('.unread-badge', el => el.textContent), '1');
  await page.click('.chat-item'); await page.waitForFunction(() => !document.querySelector('.unread-badge'));
  await page.waitForFunction(async ({ account, jid }) => { const s = await (await fetch(`/api/accounts/${account}/state`)).json(); return s.contacts.some(c => c.jid === jid && c.readAt > 0); }, {}, { account: account.id, jid });
  await page.click('#edit-contact'); await page.type('#contact-remark', '客户小玫'); await page.click('#contact-save');
  await page.waitForFunction(() => document.getElementById('chat-name').textContent === '客户小玫');
  assert.match(await page.$eval('.chat-contact-details', el => el.textContent), /Rose.*447700900123/);
  assert.equal(store.contacts(second.id).length, 0, 'remarks stay within the current WhatsApp account');
  await page.click('#close-chat');
  assert.equal(await page.$eval('#chat-name', el => el.textContent), 'BLUE-v 网页工作台');
  assert.equal(await page.$$eval('.chat-item', els => els.length), 1, 'closing does not delete the conversation');
  await page.reload(); await page.waitForSelector('.chat-item');
  assert.match(await page.$eval('.chat-item', el => el.textContent), /客户小玫/);
  assert.equal(await page.$$eval('.unread-badge', els => els.length), 0, 'read state survives reload');
  await page.evaluate(() => { closeStream(); window.soundCount = 0; playNotification = () => { window.soundCount++; }; });
  const next = { ...first, id: 'two', text: 'New realtime message', time: Date.now() };
  store.remember(account.id, next);
  await page.evaluate(async id => { const state = await (await fetch(`/api/accounts/${id}/state`)).json(); renderState({ ...state, receiver: { ...state.receiver, lastMessageAt: Date.now() } }); }, account.id);
  assert.equal(await page.$eval('.unread-badge', el => el.textContent), '1');
  assert.equal(await page.$eval('.chat-item', el => el.classList.contains('has-unread')), true);
  assert.equal(await page.evaluate(() => window.soundCount), 1);
  await page.evaluate(async id => { renderState(await (await fetch(`/api/accounts/${id}/state`)).json()); }, account.id);
  assert.equal(await page.evaluate(() => window.soundCount), 1, 'snapshot updates never repeat notifications');
  await page.click('.chat-item'); await page.waitForFunction(() => !document.querySelector('.unread-badge'));
  // A history import creates unread markers but must not generate a realtime sound.
  store.remember(account.id, { ...next, id: 'history', jid: '8613800000000@s.whatsapp.net', name: 'Another', time: Date.now() - 5000 });
  await page.evaluate(async id => { const state = await (await fetch(`/api/accounts/${id}/state`)).json(); renderState({ ...state, sync: { ...state.sync, status: 'syncing' } }); }, account.id);
  assert.equal(await page.evaluate(() => window.soundCount), 1);
  // Overflow belongs to the message list, never the page or the primary menu.
  await page.evaluate(async id => {
    const state = await (await fetch(`/api/accounts/${id}/state`)).json();
    renderState({ ...state, messages: Array.from({ length: 100 }, (_, n) => ({ id: `long-${n}`, jid: '447700900123@s.whatsapp.net', name: 'Rose', outgoing: true, text: 'Long chat content '.repeat(20), time: Date.now() + n })) });
  }, account.id);
  await page.evaluate(() => {
    const states = [undefined, 0, 1, 2, 3, 4, -5];
    messages = states.map((ack, n) => ({ id: `receipt-${n}`, jid: selectedThread, name: 'Rose', text: 'Receipt test', time: Date.now(), outgoing: true, ...(ack === undefined ? {} : { ack }) })); renderMessages();
  });
  const receipts = await page.$$eval('.message-receipt', els => els.map(el => ({ text: el.textContent, label: el.getAttribute('aria-label'), blue: el.classList.contains('read') })));
  assert.deepEqual(receipts.map(r => r.text), ['◷', '◷', '✓', '✓✓', '✓✓', '✓✓', '! 发送失败']);
  assert.deepEqual(receipts.map(r => r.blue), [false, false, false, false, true, true, false]);
  assert.equal(receipts.at(-1).label, '媒体无法上传');
  await page.click('#receipt-help'); assert.match(await page.$eval('#receipt-dialog', el => el.textContent), /单勾不代表被拉黑/); await page.click('#receipt-close');
  // Restore enough content to verify independent scrolling below.
  await page.evaluate(() => { messages = Array.from({ length: 100 }, (_, n) => ({ id: `overflow-${n}`, jid: selectedThread, name: 'Rose', text: 'Long text '.repeat(40), time: Date.now(), outgoing: true })); renderMessages(); });
  const before = await page.$eval('.rail', el => el.getBoundingClientRect().top);
  await page.$eval('#messages', el => { el.scrollTop = el.scrollHeight; });
  const geometry = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, view: innerHeight, content: document.getElementById('messages').scrollHeight, height: document.getElementById('messages').clientHeight }));
  assert.ok(geometry.content > geometry.height); assert.ok(geometry.page <= geometry.view + 1);
  assert.equal(await page.$eval('.rail', el => el.getBoundingClientRect().top), before);
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: names/phones, persistent isolated remarks/read markers, realtime notification deduplication, close-chat preservation and independently scrolling layout.');
} finally {
  await browser?.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  store.close(); await rm(dir, { recursive: true, force: true });
}
