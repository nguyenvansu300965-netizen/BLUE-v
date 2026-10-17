import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { browserExecutable } from '../wa-js-client.js';

const dir = await mkdtemp('/tmp/blue-account-browser-');
const service = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'development', ADMIN_USER: 'isolation-admin', ADMIN_PASSWORD: '123456', PUBLIC_ORIGIN: '', AUTO_CONNECT: 'false', PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    let output = ''; service.stdout.on('data', chunk => { output += chunk; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); });
    service.once('exit', code => reject(new Error(`Test server exited: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function request(page, url, method = 'GET', body) {
    return page.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    }, { url, method, body });
  }
  async function login(page, username) {
    await page.goto(base); await page.type('#username', username); await page.type('#password', '123456'); await page.click('#auth-submit');
    await page.waitForFunction(() => !document.getElementById('workspace').hidden);
  }
  await login(page, 'isolation-admin');
  const admin = (await request(page, '/api/auth/me')).data.user;
  const original = (await request(page, '/api/accounts', 'POST', { label: 'Existing connected number' })).data.account;
  await page.reload(); await page.waitForFunction(() => document.getElementById('account-select').value.length > 0);
  // Only the old connected status is a fixture; accounts, ownership and new-number creation use the real API.
  await page.evaluate(async id => {
    const state = await (await fetch(`/api/accounts/${id}/state`)).json(); closeStream();
    renderState({ ...state, status: 'connected', user: { id: '123456789@s.whatsapp.net' } });
  }, original.id);
  assert.equal(await page.$eval('#self-number', element => element.textContent), '我的号码：+123456789');
  assert.match(await page.$eval('#account-select', element => element.selectedOptions[0].textContent), /\+123456789/);
  assert.equal(await page.$eval('#account', element => element.textContent), '已关联 WhatsApp 手机号：+123456789');
  const oldList = (await request(page, '/api/accounts')).data;
  let armed = true, staleRequest, freshRequest;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = new URL(req.url());
    if (armed && url.pathname === '/api/accounts' && req.method() === 'GET') {
      if (!staleRequest) staleRequest = req; else freshRequest = req;
      return;
    }
    void req.continue();
  });
  await page.evaluate(() => { window.oldRefreshDone = false; void refreshAccounts().finally(() => { window.oldRefreshDone = true; }); });
  for (let i = 0; !staleRequest && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(staleRequest, 'must intercept an older list refresh');
  page.once('dialog', dialog => dialog.accept('Fresh number awaiting QR'));
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/accounts' && response.request().method() === 'POST');
  await page.click('#add-account');
  const created = (await (await createdResponse).json()).account;
  for (let i = 0; !freshRequest && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(freshRequest, 'creation must refresh the new list');
  await staleRequest.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(oldList) });
  await page.waitForFunction(() => window.oldRefreshDone);
  armed = false; await freshRequest.continue();
  await page.waitForFunction(id => document.getElementById('account-select').value === id && document.getElementById('device-dialog').open, {}, created.id);
  assert.notEqual(await page.$eval('#connection-hint', element => element.textContent), '✓ 已关联，可以收发消息');
  assert.equal(await page.$eval('#account', element => element.textContent), '');
  assert.equal((await request(page, `/api/accounts/${created.id}/state`)).data.user, null);
  assert.equal(await page.$eval('#self-number', element => element.hidden), true, 'switching numbers clears the former own phone');
  await page.evaluate(async id => {
    const state = await (await fetch(`/api/accounts/${id}/state`)).json(); closeStream();
    renderState({ ...state, status: 'connected', user: { id: '999999999999999@lid', phoneNumber: '' } });
  }, created.id);
  assert.equal(await page.$eval('#self-number', element => element.textContent), '手机号暂未解析');
  assert.ok(!(await page.$eval('#account', element => element.textContent)).includes('999999999999999'));
  await page.evaluate(async id => { renderState(await (await fetch(`/api/accounts/${id}/state`)).json()); }, created.id);

  // Replayed events for another number or another owner must never replace the current state.
  await page.evaluate(({ original, created }) => {
    renderState({ account: original, status: 'connected', user: { id: 'WRONG-NUMBER' } });
    renderState({ account: { ...created, user_id: 'another-owner' }, status: 'connected', user: { id: 'WRONG-OWNER' } });
  }, { original, created });
  assert.equal(await page.$eval('#account', element => element.textContent), '');
  await page.evaluate(async id => { const state = await (await fetch(`/api/accounts/${id}/state`)).json(); renderState({ ...state, status: 'connected', user: null }); }, created.id);
  assert.ok(!(await page.$eval('#connection-hint', element => element.textContent)).includes('已关联'));
  assert.match(await page.$eval('#connection-hint', element => element.textContent), /核实/);
  assert.equal(await page.$eval('#send', element => element.disabled), true);
  await page.click('#close-device');

  // Incoming media rendering uses real owner-scoped attachment URLs; download responses are fixtures.
  const imageAsset = await page.evaluate(async id => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9v8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
    return (await (await fetch(`/api/accounts/${id}/attachments?mime=image/png&name=received.png`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json()).attachment;
  }, created.id);
  const incoming = { id: 'received-image', jid: '987654321@s.whatsapp.net', name: 'Media contact', text: '[图片]', outgoing: false, time: Date.now(), thumbnail: 'data:image/png;base64,AA==', media: { type: 'image', size: 68 } };
  await page.evaluate(async ({ id, incoming }) => { closeStream(); const state = await (await fetch(`/api/accounts/${id}/state`)).json(); renderState({ ...state, messages: [incoming] }); }, { id: created.id, incoming });
  await page.click('.chat-item');
  assert.equal(await page.$eval('.load-message-media', el => el.textContent), '加载原图');
  let mediaAttempts = 0;
  const mediaHandler = req => {
    if (!req.url().endsWith('/messages/received-image/media')) return;
    mediaAttempts++;
    void req.respond({ status: mediaAttempts === 1 ? 400 : 200, contentType: 'application/json', body: JSON.stringify(mediaAttempts === 1 ? { error: '暂时无法下载' } : { message: { ...incoming, attachment: imageAsset } }) });
  };
  // Replace the earlier interception listener, which otherwise continues every request.
  page.removeAllListeners('request');
  page.on('request', req => { if (req.url().endsWith('/messages/received-image/media')) mediaHandler(req); else void req.continue(); });
  await page.click('.load-message-media');
  await page.waitForFunction(() => document.querySelector('.load-message-media')?.textContent.includes('重试'));
  await page.click('.load-message-media');
  await page.waitForSelector('.bubble a[title="点击查看原图"] img');
  assert.equal(await page.$$eval('.bubble img', els => els.length), 1, 'full image replaces thumbnail');
  assert.equal(await page.$$eval('.load-message-media', els => els.length), 0);
  assert.ok(!(await page.$eval('.bubble', el => el.textContent)).includes('[图片]'));
  const src = await page.$eval('.bubble img', el => el.src);
  assert.equal((await page.goto(src)).status(), 200, 'original image endpoint is accessible to its owner');
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('workspace').hidden);
  await page.evaluate(async ({ id, incoming, imageAsset }) => { closeStream(); const state = await (await fetch(`/api/accounts/${id}/state`)).json(); renderState({ ...state, messages: [{ ...incoming, id: 'voice', text: '[语音]', attachment: { ...imageAsset, type: 'audio', name: 'voice.ogg' } }] }); }, { id: created.id, incoming, imageAsset });
  await page.click('.chat-item');
  assert.equal(await page.$eval('.bubble audio', el => el.controls), true);
  assert.ok(!(await page.$eval('.bubble', el => el.textContent)).includes('[语音]'));

  // Exercise browser microphone recording, upload, PTT request, forwarding and revoke UI.
  await page.evaluate(async ({ id, incoming }) => {
    closeStream(); const state = await (await fetch(`/api/accounts/${id}/state`)).json();
    renderState({ ...state, status: 'connected', user: { id: '123456789@s.whatsapp.net' }, messages: [incoming, { ...incoming, id: 'outgoing-action', outgoing: true, text: 'Own outgoing', media: undefined }] });
  }, { id: created.id, incoming });
  await page.click('.chat-item');
  await page.evaluate(() => {
    window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Requested device not found', 'NotFoundError'); };
  });
  await page.click('#record-voice');
  await page.waitForSelector('#microphone-dialog[open]');
  assert.match(await page.$eval('#microphone-error', el => el.textContent), /未找到可用的麦克风/);
  assert.equal(await page.evaluate(() => voiceRecorder), null);
  await page.evaluate(() => {
    const files = new DataTransfer(); files.items.add(new File(['audio-fixture'], 'voice.mp3', { type: 'audio/mpeg' }));
    document.getElementById('voice-file').files = files.files; document.getElementById('voice-file').dispatchEvent(new Event('change'));
  });
  assert.equal(await page.evaluate(() => attachmentDraft.voice), true);
  assert.equal(await page.evaluate(() => attachmentDraft.file.type), 'audio/mpeg');
  assert.equal(await page.$eval('#microphone-dialog', el => el.open), false);
  await page.evaluate(() => { clearAttachment(); navigator.mediaDevices.getUserMedia = window.realGetUserMedia; });
  await page.click('#record-voice');
  await page.waitForFunction(() => document.getElementById('record-voice').getAttribute('aria-label') === '停止录音');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1200)));
  await page.click('#record-voice');
  await page.waitForFunction(() => attachmentDraft?.voice === true);
  assert.equal(await page.evaluate(() => voiceStream), null, 'microphone tracks released after stop');
  assert.ok(await page.evaluate(() => attachmentDraft.file.size > 0));
  let voiceRequest, forwardRequest, revokeCount = 0;
  page.removeAllListeners('request');
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path.endsWith('/messages')) {
      voiceRequest = JSON.parse(req.postData()); void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 'VOICE-SENT' }) });
    } else if (path.endsWith('/forward')) {
      forwardRequest = JSON.parse(req.postData()); void req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    } else if (path.endsWith('/revoke')) {
      revokeCount++; void req.respond({ status: revokeCount === 1 ? 400 : 200, contentType: 'application/json', body: JSON.stringify(revokeCount === 1 ? { error: '撤回失败，超过时限' } : { ok: true }) });
    } else void req.continue();
  });
  await page.click('#send');
  await page.waitForFunction(() => attachmentDraft === null);
  assert.equal(voiceRequest.voice, true); assert.match(voiceRequest.attachment, /^[a-f0-9]{32}$/);
  await page.click('.bubble .message-actions button');
  await page.waitForSelector('#forward-dialog[open]');
  await page.type('#forward-phone', '447700900123'); await page.click('#forward-confirm');
  await page.waitForFunction(() => !document.getElementById('forward-dialog').open);
  assert.deepEqual(forwardRequest, { phone: '447700900123' });
  assert.equal(await page.$$eval('.bubble:not(.outgoing) .message-actions button', els => els.length), 1, 'incoming messages cannot be revoked');
  page.once('dialog', dialog => dialog.accept());
  await page.click('.bubble.outgoing .message-actions button:last-child');
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('超过时限'));
  assert.ok((await page.$eval('.bubble.outgoing', el => el.textContent)).includes('Own outgoing'));
  page.once('dialog', dialog => dialog.accept());
  await page.click('.bubble.outgoing .message-actions button:last-child');
  await page.waitForFunction(() => document.querySelector('.bubble.outgoing')?.textContent.includes('此消息已撤回'));
  assert.equal(await page.$$eval('.bubble.outgoing .message-actions', els => els.length), 0);
  await page.click('#record-voice');
  await page.waitForFunction(() => voiceRecorder?.state === 'recording');
  await page.evaluate(() => clearAttachment());
  assert.equal(await page.evaluate(() => voiceRecorder), null, 'cancelling draft releases recording');

  await page.evaluate(() => {
    const files = new DataTransfer(); files.items.add(new File(['video-fixture'], 'clip.mp4', { type: 'video/mp4' }));
    document.getElementById('video-file').files = files.files; document.getElementById('video-file').dispatchEvent(new Event('change'));
  });
  assert.equal(await page.evaluate(() => attachmentDraft.file.type), 'video/mp4');
  await page.click('#send');
  await page.waitForFunction(() => attachmentDraft === null);
  assert.equal(voiceRequest.voice, false, 'video is sent as a normal video attachment');

  const registered = await request(page, '/api/auth/register', 'POST', { username: 'isolated-user', password: '123456' });
  await request(page, `/api/admin/users/${registered.data.user.id}`, 'PATCH', { enabled: true, plan: 'basic', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  // Same-page logout/login must remove the old DOM even when the next user has no numbers.
  await page.evaluate(async id => {
    closeStream();
    const state = await (await fetch(`/api/accounts/${id}/state`)).json();
    renderState({ ...state, status: 'connected', user: { id: '123456789@s.whatsapp.net' }, messages: [{ id: 'PRIVATE-A', jid: '987654321@s.whatsapp.net', name: 'Private contact A', text: 'Private preview A', outgoing: false, time: Date.now() }] });
  }, created.id);
  await page.click('.chat-item');
  assert.equal(await page.$eval('#chat-name', element => element.textContent), 'Private contact A');
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  async function signInHere(username) {
    await page.$eval('#username', (element, value) => { element.value = value; }, username);
    await page.$eval('#password', element => { element.value = '123456'; });
    await page.click('#auth-submit');
    await page.waitForFunction(name => !document.getElementById('workspace').hidden && document.getElementById('current-user').textContent === name, {}, username);
  }
  await signInHere('isolated-user');
  await page.waitForFunction(() => document.getElementById('account-select').textContent.includes('尚未添加号码'));
  assert.equal(await page.$$eval('.chat-item', elements => elements.length), 0, 'new user without numbers must not inherit the previous chat list');
  assert.equal(await page.$eval('#chat-name', element => element.textContent), 'BLUE-v 网页工作台');
  assert.ok(!(await page.$eval('#workspace', element => element.textContent)).includes('Private preview A'));
  assert.ok(!(await page.$eval('#workspace', element => element.textContent)).includes('Private contact A'));
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  await signInHere('isolation-admin');
  await page.waitForFunction(() => document.getElementById('account-select').value.length > 0);
  // Repeat switching with a number already owned by B, without reloading the document.
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  await signInHere('isolated-user');
  const ownedB = (await request(page, '/api/accounts', 'POST', { label: 'B own number' })).data.account;
  await page.evaluate(() => refreshAccounts());
  await page.waitForFunction(id => document.getElementById('account-select').value === id, {}, ownedB.id);
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  await signInHere('isolation-admin');
  await page.waitForFunction(() => document.getElementById('account-select').value.length > 0);
  await page.evaluate(async () => {
    closeStream();
    const state = await (await fetch(`${flowBase()}/state`)).json();
    renderState({ ...state, status: 'connected', user: { id: '123456789@s.whatsapp.net' }, messages: [{ id: 'PRIVATE-A-2', jid: '987654321@s.whatsapp.net', name: 'Private contact A', text: 'Private preview A', outgoing: false, time: Date.now() }] });
  });
  await page.click('.chat-item');
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  await signInHere('isolated-user');
  await page.waitForFunction(id => document.getElementById('account-select').value === id, {}, ownedB.id);
  assert.equal(await page.$$eval('.chat-item', elements => elements.length), 0);
  assert.ok(!(await page.$eval('#workspace', element => element.textContent)).includes('Private contact A'));
  assert.ok(!(await page.$eval('#workspace', element => element.textContent)).includes('Private preview A'));
  assert.equal((await request(page, `/api/accounts/${ownedB.id}`, 'DELETE')).status, 200);
  await page.click('#signout'); await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  await signInHere('isolation-admin');
  await page.waitForFunction(() => document.getElementById('account-select').value.length > 0);
  // A second tab shares the browser's cookie jar: the first tab must not act as this newly logged-in user.
  const tab = await browser.newPage(); let oldBoot;
  await tab.setRequestInterception(true);
  tab.on('request', req => {
    if (!oldBoot && new URL(req.url()).pathname === '/api/auth/me') oldBoot = req;
    else void req.continue();
  });
  await tab.goto(base);
  for (let i = 0; !oldBoot && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(oldBoot);
  await tab.type('#username', 'isolated-user'); await tab.type('#password', '123456'); await tab.click('#auth-submit');
  await tab.waitForFunction(() => document.getElementById('current-user').textContent === 'isolated-user');
  await tab.waitForFunction(() => document.getElementById('account-select').textContent.includes('尚未添加号码'));
  await oldBoot.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: admin }) });
  await tab.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.equal(await tab.$eval('#current-user', element => element.textContent), 'isolated-user', 'late startup identity must not restore the former user');
  assert.equal(await tab.$eval('#workspace', element => element.hidden), false);
  await page.bringToFront();
  page.once('dialog', dialog => dialog.accept('Must not be created for the other user'));
  await page.click('#add-account');
  await page.waitForFunction(() => !document.getElementById('auth-screen').hidden);
  assert.match(await page.$eval('#auth-notice', element => element.textContent), /其他页面切换/);
  const otherAccounts = (await request(tab, '/api/accounts')).data.accounts;
  assert.equal(otherAccounts.length, 0, 'old tab must not create a number for a different cookie identity');
  const other = (await request(tab, '/api/accounts', 'POST', { label: 'Independent user number' })).data.account;
  const forbidden = await request(tab, `/api/accounts/${original.id}/state`); assert.equal(forbidden.status, 404);
  const state = (await request(tab, `/api/accounts/${other.id}/state`)).data;
  assert.equal(state.status, 'idle'); assert.equal(state.user, null); assert.equal(state.account.user_id, registered.data.user.id);
  assert.notEqual(state.account.user_id, admin.id);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed list responses cannot reselect an old connected number; mismatched state is ignored; shared-cookie account switches block old-tab actions; other owners cannot read the connection; same-page account switches clear old chat DOM.');
} finally {
  await browser?.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited; }
  await rm(dir, { recursive: true, force: true });
}
