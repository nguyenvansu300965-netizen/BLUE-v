import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { stanzaId, toWaJid } from './messages.js';

const require = createRequire(import.meta.url);
export const waScript = require.resolve('@wppconnect/wa-js');

// Runs entirely inside the WhatsApp browser page. Send only selected, serializable
// fields to Node; never serialize auth state, a complete MsgModel, or page storage.
export function installWaBridge() {
  if (window.__blueWaBridge) return;
  window.__blueWaBridge = true;
  const emit = event => { void window.__blueWaEvent(event).catch(() => {}); };
  const wid = value => typeof value === 'string' ? value : value?._serialized || value?.toString?.();
  let bound = false, lastState = '', lastQr = '', lastImage = '';
  function readVisibleQr() {
    const container = document.querySelector('[data-ref]');
    const code = container?.getAttribute('data-ref');
    if (code && code.split(',').length >= 4) {
      if (code !== lastQr) { lastQr = code; emit({ type: 'qr', code }); }
      return;
    }
    const canvas = container?.querySelector('canvas') || document.querySelector('canvas[aria-label]');
    if (!container || !canvas || canvas.width < 100) return;
    try {
      const image = canvas.toDataURL('image/png');
      if (image !== lastImage) { lastImage = image; emit({ type: 'qr_image', image }); }
    } catch { /* WA-JS auth code events remain available if canvas cannot be read. */ }
  }
  async function refresh() {
    // Login QR rendering must not depend on the internal module loader being ready.
    readVisibleQr();
    const wpp = window.WPP;
    if (!wpp?.isReady) return;
    if (!bound) {
      bound = true;
      wpp.on('conn.auth_code_change', code => {
        if (code?.fullCode && code.fullCode !== lastQr) { lastQr = code.fullCode; emit({ type: 'qr', code: code.fullCode }); }
        void refresh();
      });
      for (const event of ['conn.authenticated', 'conn.main_ready', 'conn.online', 'conn.require_auth']) wpp.on(event, () => { void refresh(); });
      wpp.on('conn.logout', () => emit({ type: 'logout' }));
      wpp.on('conn.needs_update', () => emit({ type: 'needs_update' }));
      wpp.on('chat.new_message', msg => {
        const key = msg.id;
        const fromMe = Boolean(key?.fromMe);
        const chatId = wid(key?.remote || (fromMe ? msg.to : msg.from));
        const native = msg.nativeFlowResponseMessage || msg.interactiveResponseMessage?.nativeFlowResponseMessage;
        emit({ type: 'message', message: {
          id: key?.id || key?._serialized || String(key), chatId, fromMe,
          body: typeof msg.body === 'string' ? msg.body : '', caption: typeof msg.caption === 'string' ? msg.caption : '',
          name: typeof msg.notifyName === 'string' ? msg.notifyName : '', timestamp: Number(msg.t || 0), type: msg.type,
          history: Boolean(msg.isMdHistoryMsg), selectedButtonId: msg.selectedButtonId || msg.buttonsResponse?.selectedButtonId,
          selectedId: msg.selectedId || msg.listResponse?.singleSelectReply?.selectedRowId,
          label: msg.selectedButtonText || msg.buttonsResponse?.selectedDisplayText,
          nativeFlowParams: native?.paramsJson,
          quotedId: msg.quotedStanzaID || msg.quotedMsgId?.id || msg.quotedMsgKey?.id
        } });
      });
    }
    try {
      const ready = wpp.conn.isMainReady();
      const status = ready ? (wpp.conn.isOnline() ? 'connected' : 'disconnected') : wpp.conn.isAuthenticated() ? 'connecting' : 'qr';
      const user = ready ? { id: wid(wpp.conn.getMyUserId()) } : null;
      if (status !== lastState) { lastState = status; emit({ type: 'state', status, user }); }
      if (!ready && !wpp.conn.isAuthenticated()) {
        const code = await wpp.conn.getAuthCode();
        if (code?.fullCode && code.fullCode !== lastQr) { lastQr = code.fullCode; emit({ type: 'qr', code: code.fullCode }); }
      }
    } catch { /* The loader may be transitioning between auth and the main app. */ }
  }
  void refresh();
  setInterval(() => { void refresh(); }, 2000);
}

export async function browserExecutable() {
  const paths = process.env.CHROMIUM_PATH ? [process.env.CHROMIUM_PATH] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const candidate of paths) { try { await access(candidate, constants.X_OK); return candidate; } catch {} }
  throw Object.assign(new Error('Chromium executable is unavailable'), { code: 'CHROMIUM_MISSING' });
}
export class WaJsClient {
  constructor({ profileDir, onEvent, launch = options => puppeteer.launch(options) }) {
    this.profileDir = profileDir; this.onEvent = onEvent; this.launch = launch; this.closed = false;
  }
  async start() {
    this.onEvent({ type: 'progress', stage: 'browser', detail: '正在启动 Chromium 浏览器…' });
    const executablePath = await browserExecutable();
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    if (this.closed) return;
    const args = ['--disable-dev-shm-usage', '--no-first-run', '--disable-extensions'];
    if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
    const proxyValue = process.env.CHROMIUM_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = proxyValue ? new URL(proxyValue) : null;
    if (proxy) args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
    this.launching = this.launch({ executablePath, userDataDir: this.profileDir, headless: true, args, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, protocolTimeout: 120000 });
    this.browser = await this.launching;
    if (this.closed) { await this.browser.close(); return; }
    this.browser.on('disconnected', () => { if (!this.closed) this.onEvent({ type: 'closed' }); });
    this.page = (await this.browser.pages())[0] || await this.browser.newPage();
    if (proxy?.username) await this.page.authenticate({ username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) });
    await this.page.setBypassCSP(true);
    await this.page.exposeFunction('__blueWaEvent', event => { if (!this.closed) return this.onEvent(event); });
    // Install the DOM QR reader before navigation; it also survives page reloads.
    await this.page.evaluateOnNewDocument(installWaBridge);
    this.page.on('domcontentloaded', () => { if (!this.closed) void this.inject().catch(() => { if (!this.closed) this.onEvent({ type: 'injection_error' }); }); });
    this.page.on('error', () => { if (!this.closed) this.onEvent({ type: 'closed' }); });
    this.page.on('framenavigated', frame => { if (frame === this.page.mainFrame()) this.injecting = null; });
    let response;
    this.onEvent({ type: 'progress', stage: 'page', detail: '正在打开 WhatsApp 登录页面…' });
    try { response = await this.page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }); }
    catch (error) {
      if (error.name === 'TimeoutError') error.code = 'PAGE_TIMEOUT';
      if (error.message.includes('ERR_CERT_')) error.code = 'CERTIFICATE_UNTRUSTED';
      if (error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) error.code = 'PROXY_REJECTED';
      throw error;
    }
    if (response && response.status() >= 400) throw Object.assign(new Error('WhatsApp page was rejected'), { code: `WEB_HTTP_${response.status()}` });
    await this.inject();
  }
  inject() {
    if (!this.injecting) this.injecting = (async () => {
      if (this.closed) return;
      this.onEvent({ type: 'progress', stage: 'inject', detail: '正在载入 WA-JS，等待 WhatsApp 显示二维码…' });
      await this.page.addScriptTag({ path: waScript });
      if (!this.closed) await this.page.evaluate(installWaBridge);
    })();
    return this.injecting;
  }
  async sendText(jid, text, buttons = []) {
    const result = await this.page.evaluate(async ({ to, text, buttons }) => {
      const result = await window.WPP.chat.sendTextMessage(to, text, { buttons: buttons.length ? buttons : undefined, detectMentioned: false, markIsRead: false, waitForAck: true });
      return { id: result.id, ack: result.ack };
    }, { to: toWaJid(jid), text, buttons });
    if (!result?.id) throw new Error('WA-JS returned no message ID');
    return stanzaId(result.id);
  }
  async sendImage(jid, dataUrl, caption, buttons = []) {
    const result = await this.page.evaluate(async ({ to, dataUrl, caption, buttons }) => {
      const result = await window.WPP.chat.sendFileMessage(to, dataUrl, { type: 'image', caption, buttons: buttons.length ? buttons : undefined, detectMentioned: false, markIsRead: false, waitForAck: true });
      return { id: result.id, ack: result.ack };
    }, { to: toWaJid(jid), dataUrl, caption, buttons });
    if (!result?.id) throw new Error('WA-JS returned no message ID');
    return stanzaId(result.id);
  }
  async logout() { if (this.page && !this.page.isClosed()) await this.page.evaluate(() => window.WPP?.conn.logout()); }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      let browser;
      try { browser = this.browser || await this.launching; } catch { return; }
      if (!browser) return;
      let timeout;
      try { await Promise.race([browser.close(), new Promise(resolve => { timeout = setTimeout(() => { browser.process()?.kill('SIGKILL'); resolve(); }, 5000); timeout.unref(); })]); }
      finally { clearTimeout(timeout); }
    })();
    return this.closing;
  }
}
