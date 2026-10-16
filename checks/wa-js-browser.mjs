import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browserExecutable, WaJsClient, installWaBridge, waScript } from '../wa-js-client.js';
import { normalizeWaMessage } from '../messages.js';
import { sendFlow } from '../flow-sender.js';

const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const bundlePage = await browser.newPage();
  await bundlePage.goto('about:blank');
  await bundlePage.addScriptTag({ path: waScript });
  const bundle = await bundlePage.evaluate(() => ({ version: window.WPP.version, text: typeof window.WPP.chat.sendTextMessage, file: typeof window.WPP.chat.sendFileMessage, qr: typeof window.WPP.conn.getAuthCode }));
  assert.equal(bundle.version, '4.7.1'); assert.equal(bundle.text, 'function'); assert.equal(bundle.file, 'function'); assert.equal(bundle.qr, 'function');
  await bundlePage.close();
  const page = await browser.newPage();
  const received = [];
  await page.exposeFunction('__blueWaEvent', event => { received.push(event); });
  await page.evaluate(() => {
    const handlers = {}; window.fixtureHandlers = handlers; window.sent = [];
    window.WPP = { isReady: true, on: (name, callback) => { handlers[name] = callback; },
      conn: { isMainReady: () => false, isOnline: () => true, isAuthenticated: () => false, getAuthCode: async () => ({ fullCode: 'test-qr-only' }), getMyUserId: () => ({ toString: () => '123456789@c.us' }) },
      chat: { sendTextMessage: async (to, text, options) => { window.sent.push({ kind: 'text', to, text, options }); return { id: `true_${to}_TEXT`, ack: 1 }; }, sendFileMessage: async (to, data, options) => { window.sent.push({ kind: 'image', to, data, options }); return { id: `true_${to}_IMAGE`, ack: 1 }; } }
    };
  });
  await page.evaluate(installWaBridge);
  await page.waitForFunction(() => Boolean(window.fixtureHandlers['chat.new_message']));
  for (let i = 0; i < 20 && !received.some(e => e.type === 'qr'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(received.some(e => e.type === 'qr'));
  await page.evaluate(() => {
    window.WPP.conn.isMainReady = () => true;
    window.fixtureHandlers['conn.main_ready']();
    window.fixtureHandlers['chat.new_message']({ id: { id: 'REPLY', remote: { _serialized: '123456789@c.us' }, fromMe: false }, body: '产品介绍', type: 'buttons_response', selectedButtonId: 'flow:welcome:0', quotedStanzaID: 'TEXT', t: Math.floor(Date.now() / 1000), notifyName: 'Customer', isMdHistoryMsg: false });
  });
  for (let i = 0; i < 20 && !received.some(e => e.type === 'message'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  const reply = normalizeWaMessage(received.find(e => e.type === 'message').message);
  assert.equal(reply.selection, 'flow:welcome:0'); assert.equal(reply.quotedId, 'TEXT'); assert.equal(reply.jid, '123456789@s.whatsapp.net');
  const client = new WaJsClient({ profileDir: '/unused', onEvent() {} }); client.page = page;
  const node = { id: 'welcome', text: '请选择', options: [{ label: '产品介绍', next: 'products' }] };
  assert.equal(await sendFlow(client, reply.jid, node, 'buttons'), 'TEXT');
  assert.equal(await sendFlow(client, reply.jid, node, 'buttons', Buffer.from([255,216,255,0])), 'IMAGE');
  const calls = await page.evaluate(() => window.sent);
  assert.equal(calls[0].to, '123456789@c.us'); assert.deepEqual(calls[0].options.buttons, [{ id: 'flow:welcome:0', text: '产品介绍' }]);
  assert.equal(calls[0].options.waitForAck, true); assert.equal(calls[0].options.detectMentioned, false);
  assert.equal(calls[1].options.type, 'image'); assert.match(calls[1].data, /^data:image\/jpeg;base64,/); assert.equal(calls[1].options.buttons.length, 1);
  console.log('PASS: Chromium loads pinned WA-JS 4.7.1 bundle; browser bridge handles QR/status/replies and calls text/image button APIs. WhatsApp network and recipient rendering are not simulated as delivery.');
} finally { await browser.close(); }
