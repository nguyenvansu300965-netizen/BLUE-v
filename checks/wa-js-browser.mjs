import assert from 'node:assert/strict';
import { browserResources } from '../browser-resources.js';
import puppeteer from 'puppeteer-core';
import { browserExecutable, WaJsClient, installWaBridge, waScript } from '../wa-js-client.js';
import { normalizeWaMessage } from '../messages.js';
import { sendFlow } from '../flow-sender.js';

const resources = await browserResources(await browserExecutable());
const browser = await puppeteer.launch({ ...resources, headless: true, args: [...resources.args, '--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const bundlePage = await browser.newPage();
  await bundlePage.goto('about:blank');
  await bundlePage.addScriptTag({ path: waScript });
  const bundle = await bundlePage.evaluate(() => ({ version: window.WPP.version, text: typeof window.WPP.chat.sendTextMessage, file: typeof window.WPP.chat.sendFileMessage, qr: typeof window.WPP.conn.getAuthCode }));
  assert.equal(bundle.version, '4.7.1'); assert.equal(bundle.text, 'function'); assert.equal(bundle.file, 'function'); assert.equal(bundle.qr, 'function');
  await bundlePage.close();
  const loginPage = await browser.newPage();
  const loginEvents = [];
  await loginPage.exposeFunction('__blueWaEvent', event => { loginEvents.push(event); });
  await loginPage.setContent('<div data-ref="test-ref"><canvas width="240" height="240"></canvas></div>');
  await loginPage.evaluate(() => { window.WPP = { isReady: false }; const canvas = document.querySelector('canvas'); canvas.getContext('2d').fillRect(0, 0, 240, 240); });
  await loginPage.evaluate(installWaBridge);
  for (let i = 0; i < 20 && !loginEvents.some(e => e.type === 'qr_image'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(loginEvents.some(e => e.type === 'qr_image' && e.image.startsWith('data:image/png;base64,')), 'DOM QR must be readable even when WA-JS is not ready');
  const qrCount = loginEvents.filter(e => ['qr', 'qr_image'].includes(e.type)).length;
  await loginPage.evaluate(() => {
    window.loginHandlers = {};
    window.WPP = { isReady: true, on: (name, cb) => { window.loginHandlers[name] = cb; }, conn: { isMainReady: () => false, isOnline: () => true, isAuthenticated: () => false, getAuthCode: async () => ({ fullCode: 'different-api-code' }) } };
  });
  await loginPage.waitForFunction(() => Boolean(window.loginHandlers['conn.auth_code_change']));
  await loginPage.evaluate(() => { window.loginHandlers['conn.auth_code_change']({ fullCode: 'different-api-code' }); });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(loginEvents.filter(e => ['qr', 'qr_image'].includes(e.type)).length, qrCount, 'auth-code fallback must not overwrite the exact native QR');
  await loginPage.evaluate(() => { window.loginHandlers['conn.authenticated'](); window.loginHandlers['conn.auth_code_change']({ fullCode: 'stale-after-scan' }); });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(loginEvents.filter(e => ['qr', 'qr_image'].includes(e.type)).length, qrCount, 'QR must stop changing after authentication');
  assert.ok(loginEvents.some(e => e.type === 'state' && e.authenticated && e.status === 'connecting'));
  await loginPage.close();

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
  const beforeEmptyIdentity = received.length;
  await page.evaluate(() => {
    window.WPP.conn.isMainReady = () => true;
    window.WPP.conn.getMyUserId = () => undefined;
    window.fixtureHandlers['conn.main_ready']();
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!received.slice(beforeEmptyIdentity).some(event => event.type === 'state' && event.status === 'connected'), 'main_ready without an identity must not mean linked');
  await page.evaluate(() => {
    window.WPP.conn.getMyUserId = () => ({ _serialized: '123456789@c.us' });
    window.WPP.conn.isMainReady = () => true;
    window.fixtureHandlers['conn.main_ready']();
    window.fixtureHandlers['chat.new_message']({ id: { id: 'REPLY', remote: { _serialized: '123456789@c.us' }, fromMe: false }, body: '产品介绍', type: 'buttons_response', selectedButtonId: 'flow:welcome:0', quotedStanzaID: 'TEXT', t: Math.floor(Date.now() / 1000), notifyName: 'Customer', isMdHistoryMsg: false });
  });
  for (let i = 0; i < 20 && !received.some(e => e.type === 'message'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(received.some(event => event.type === 'state' && event.status === 'connected' && event.user?.id === '123456789@c.us'), 'identity becoming available must emit connected even when main_ready remains true');
  const reply = normalizeWaMessage(received.find(e => e.type === 'message').message);
  assert.equal(reply.selection, 'flow:welcome:0'); assert.equal(reply.quotedId, 'TEXT'); assert.equal(reply.jid, '123456789@s.whatsapp.net');
  await page.evaluate(() => {
    window.rawHandlers = {}; window.rawModels = [];
    window.WPP.whatsapp = { MsgStore: { models: window.rawModels, on: (event, cb) => { window.rawHandlers[event] = cb; } } };
    window.fixtureHandlers['conn.online']();
  });
  await page.waitForFunction(() => Boolean(window.rawHandlers.add));
  const beforeRaw = received.filter(e => e.type === 'message').length;
  await page.evaluate(() => {
    const message = { id: { id: 'DECRYPTED', remote: { user: '123456789', server: 'c.us' }, fromMe: false }, type: 'ciphertext', t: Math.floor(Date.now() / 1000) };
    window.rawHandlers.add(message);
    message.type = 'chat'; message.body = 'New message after decryption';
    Object.defineProperty(message, 'quotedMsgId', { get() { throw new Error('Optional quote module missing'); } });
    window.rawHandlers['change:type'](message);
    window.fixtureHandlers['chat.new_message'](message);
    window.rawModels.push({ id: { id: 'MISSED_EVENT', remote: { _serialized: '987654321@c.us' }, fromMe: false }, type: 'chat', body: 'New chat without event callback', t: Math.floor(Date.now() / 1000) });
    window.rawModels.push({ id: { id: 'OLD_HISTORY', remote: { _serialized: '987654321@c.us' }, fromMe: false }, type: 'chat', body: 'Old history must not become live', t: Math.floor(Date.now() / 1000) - 86400 });
  });
  for (let i = 0; i < 40 && !received.some(e => e.type === 'message' && e.message.id === 'MISSED_EVENT'); i++) await new Promise(resolve => setTimeout(resolve, 200));
  const live = received.filter(e => e.type === 'message').slice(beforeRaw);
  assert.equal(live.filter(e => e.message.id === 'DECRYPTED').length, 1, 'ciphertext must not mask plaintext and dual events must deduplicate');
  assert.ok(live.some(e => e.message.id === 'MISSED_EVENT'), 'store sweep must recover a missed event in a new conversation');
  assert.ok(!live.some(e => e.message.id === 'OLD_HISTORY'), 'old history must not trigger live reception');
  const client = new WaJsClient({ profileDir: '/unused', onEvent() {} }); client.page = page;
  await page.evaluate(() => { window.WPP.contact = { getPnLidEntry: async to => ({ phoneNumber: { _serialized: '447700900123@c.us' }, contact: { pushname: 'Rose', name: 'Saved name' } }) }; });
  assert.deepEqual(await client.contactInfo('999999999999999@lid'), { name: 'Rose', phoneNumber: '447700900123' });
  await page.evaluate(() => { window.WPP.contact.getPnLidEntry = async () => { throw new Error('Unavailable'); }; });
  assert.deepEqual(await client.contactInfo('999999999999999@lid'), {});
  const node = { id: 'welcome', text: '请选择', options: [{ label: '产品介绍', next: 'products' }] };
  assert.equal(await sendFlow(client, reply.jid, node, 'buttons'), 'TEXT');
  assert.equal(await sendFlow(client, reply.jid, node, 'buttons', Buffer.from([255,216,255,0])), 'IMAGE');
  await page.evaluate(() => {
    window.WPP.chat.list = async () => [{ id: '123456789@c.us', name: 'Customer' }];
    window.WPP.chat.getMessages = async () => [{ id: 'false_123456789@c.us_HISTORY', body: 'Existing conversation', type: 'chat', t: 123 }];
  });
  const history = await client.fetchMessages();
  assert.equal(history.chatCount, 1); assert.equal(history.messages[0].history, true); assert.equal(history.messages[0].chatId, '123456789@c.us');
  assert.equal(normalizeWaMessage(history.messages[0]).text, 'Existing conversation');
  const calls = await page.evaluate(() => window.sent);
  assert.equal(calls[0].to, '123456789@c.us'); assert.deepEqual(calls[0].options.buttons, [{ id: 'flow:welcome:0', text: '产品介绍' }]);
  assert.equal(calls[0].options.waitForAck, true); assert.equal(calls[0].options.detectMentioned, false);
  assert.equal(calls[1].options.type, 'image'); assert.match(calls[1].data, /^data:image\/jpeg;base64,/); assert.equal(calls[1].options.buttons.length, 1);
  for (const [type, mime, name] of [['image', 'image/png', '图片.png'], ['video', 'video/mp4', 'video.mp4'], ['audio', 'audio/mpeg', 'audio.mp3'], ['document', 'application/pdf', '报价单.pdf']]) {
    assert.equal(await client.sendMedia(reply.jid, Buffer.from('fixture'), { type, mime, name }, '附件文案'), 'IMAGE');
    const sent = await page.evaluate(() => window.sent.at(-1));
    assert.equal(sent.options.type, type); assert.equal(sent.options.filename, name); assert.equal(sent.options.mimetype, mime); assert.equal(sent.options.caption, '附件文案');
    assert.equal(sent.data, `data:${mime};base64,${Buffer.from('fixture').toString('base64')}`);
  }
  const languageMenu = { id: 'languages', text: 'Please select your language\n请选择您的语言\n請選擇您的語言', options: ['English', '简体中文', '繁体中文'].map((label, index) => ({ label, next: `language-${index}` })) };
  await sendFlow(client, reply.jid, languageMenu, 'buttons', Buffer.from([255,216,255,0]));
  const splitMenu = await page.evaluate(() => window.sent.slice(-2));
  assert.equal(splitMenu[0].options.caption, '');
  assert.equal(splitMenu[1].text, languageMenu.text);
  assert.equal(splitMenu[1].options.buttons.length, 3);
  const identityPage = await browser.newPage(), identities = [];
  await identityPage.exposeFunction('__blueWaEvent', event => { identities.push(event); });
  await identityPage.evaluate(() => {
    window.handlers = {}; window.selfLookups = [];
    window.WPP = { isReady: true, on: (name, callback) => { window.handlers[name] = callback; },
      conn: { isMainReady: () => true, isOnline: () => true, isAuthenticated: () => true, getMyUserId: () => ({ _serialized: '999999999999999@lid' }) },
      contact: { getPnLidEntry: async id => { window.selfLookups.push(id); return { phoneNumber: { _serialized: '447700900123@c.us' } }; } }
    };
  });
  await identityPage.evaluate(installWaBridge);
  await identityPage.waitForFunction(() => window.selfLookups.length > 0);
  for (let i = 0; i < 20 && !identities.some(event => event.user?.phoneNumber === '447700900123'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(identities.some(event => event.user?.id === '999999999999999@lid' && event.user.phoneNumber === '447700900123'));
  assert.deepEqual(await identityPage.evaluate(() => window.selfLookups), ['999999999999999@lid']);
  await identityPage.evaluate(() => {
    window.WPP.conn.getMyUserId = () => ({ _serialized: '888888888888888@lid' });
    window.WPP.contact.getPnLidEntry = async () => ({}); window.handlers['conn.main_ready']();
  });
  for (let i = 0; i < 20 && !identities.some(event => event.user?.id === '888888888888888@lid'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(identities.find(event => event.user?.id === '888888888888888@lid').user.phoneNumber, '', 'LID digits are never displayed as a phone number');
  await identityPage.close();
  console.log('PASS: Chromium loads pinned WA-JS 4.7.1 bundle; browser bridge handles QR/status/replies and calls text/image button APIs. WhatsApp network and recipient rendering are not simulated as delivery.');
} finally { await browser.close(); }
