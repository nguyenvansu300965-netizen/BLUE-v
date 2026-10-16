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
  const wid = value => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value._serialized || (value.user && value.server ? `${value.user}@${value.server}` : value.toString?.() !== '[object Object]' ? value.toString?.() : '');
  };
  window.__blueSerializeWaMessage = (msg, history = false, fallbackChat = '', fallbackName = '') => {
    // Optional model getters can throw before WhatsApp finishes loading modules.
    const safe = new Proxy(msg, { get(target, key) { try { return target[key]; } catch { return undefined; } } });
    msg = safe;
    const key = msg.id;
    const serialized = typeof key === 'string' ? key : key?._serialized || '';
    const fromMe = typeof key?.fromMe === 'boolean' ? key.fromMe : serialized.startsWith('true_');
    const native = msg.nativeFlowResponseMessage || msg.interactiveResponseMessage?.nativeFlowResponseMessage;
    const buttons = [];
    for (const button of msg.interactivePayload?.buttons || []) {
      try { const params = JSON.parse(button.buttonParamsJson || '{}'); if (typeof params.display_text === 'string') buttons.push({ label: params.display_text }); } catch {}
    }

    return {
      id: typeof key === 'string' ? key : key?.id || key?._serialized,
      chatId: wid(key?.remote) || fallbackChat || serialized.split('_')[1] || wid(fromMe ? msg.to : msg.from), fromMe,
      body: typeof msg.body === 'string' ? msg.body : '', caption: typeof msg.caption === 'string' ? msg.caption : '',
      buttons, hasMediaAttachment: Boolean(msg.interactiveHeader?.hasMediaAttachment || msg.interactiveHeader?.hasmediaAttachment), mediaType: msg.interactiveHeader?.mediaType, thumbnail: typeof msg.interactiveHeader?.thumbnail === 'string' ? msg.interactiveHeader.thumbnail : undefined,
      name: fallbackName || (typeof msg.notifyName === 'string' ? msg.notifyName : ''), timestamp: Number(msg.t || 0), type: msg.type,
      history: history || Boolean(msg.isMdHistoryMsg), selectedButtonId: msg.selectedButtonId || msg.buttonsResponse?.selectedButtonId,
      selectedId: msg.selectedId || msg.listResponse?.singleSelectReply?.selectedRowId,
      label: msg.selectedButtonText || msg.buttonsResponse?.selectedDisplayText,
      nativeFlowParams: native?.paramsJson, quotedId: msg.quotedStanzaID || msg.quotedMsgId?.id || msg.quotedMsgKey?.id
    };
  };
  let bound = false, lastState = '', lastQr = '', lastImage = '', domQrSeen = false, authenticated = false, refreshing = false;
  const liveSince = Math.floor(Date.now() / 1000);
  const delivered = new Map();
  let rawStore = null, lastSweep = 0;
  function receiveMessage(msg, source = 'event') {
    try {
      if (!window.WPP?.conn.isMainReady()) return;
      const raw = window.__blueSerializeWaMessage(msg);
      if (['ciphertext', 'protocol', 'notification', 'e2e_notification', 'gp2'].includes(raw.type)) return;
      if (!raw.id || !raw.chatId || !raw.timestamp) return;
      if (!raw.body && !raw.caption && !raw.selectedButtonId && !raw.selectedId && !raw.nativeFlowParams && !['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard'].includes(raw.type)) return;
      if (source !== 'event' && raw.timestamp < liveSince - 2) return;
      const key = `${raw.chatId}:${typeof raw.id === 'string' ? raw.id : ''}`;
      if (delivered.has(key)) return;
      delivered.set(key, true);
      if (delivered.size > 2000) delivered.delete(delivered.keys().next().value);
      emit({ type: 'message', message: raw, source });
    } catch { emit({ type: 'receiver_error', code: 'MESSAGE_SERIALIZATION' }); }
  }
  function watchMessageStore(wpp) {
    try {
      const store = wpp.whatsapp?.MsgStore;
      if (!store) return;
      if (store !== rawStore) {
        if (rawStore) for (const event of ['add', 'change:type', 'change:body', 'change:caption']) rawStore.off?.(event, rawHandler);
        rawStore = store;
        for (const event of ['add', 'change:type', 'change:body', 'change:caption']) store.on(event, rawHandler);
        emit({ type: 'receiver_ready' });
      }
      if (Date.now() - lastSweep < 3000) return;
      lastSweep = Date.now();
      const models = store.getModelsArray?.() || store.models || store._models || [];
      for (const msg of Array.isArray(models) ? models.slice(-200) : []) receiveMessage(msg, 'store-sweep');
    } catch { emit({ type: 'receiver_error', code: 'MESSAGE_STORE_UNAVAILABLE' }); }
  }
  function rawHandler(msg) { receiveMessage(msg, 'store-event'); }
  function publishCode(code) {
    if (authenticated || domQrSeen || !code || code === lastQr) return;
    lastQr = code; emit({ type: 'qr', code });
  }
  function readVisibleQr() {
    if (authenticated) return;
    const container = document.querySelector('[data-ref]');
    const canvas = container?.querySelector('canvas');
    if (!container || !canvas || canvas.width < 100 || !container.getClientRects().length) return;
    try {
      // Copy the exact rendered QR, including any fields not known to WA-JS.
      // Do not reconstruct it from data-ref or race it against getAuthCode().
      const image = canvas.toDataURL('image/png');
      domQrSeen = true;
      if (image !== lastImage) { lastImage = image; emit({ type: 'qr_image', image }); }
    } catch { /* Use the auth-code fallback only before a native QR was seen. */ }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { await refreshOnce(); } finally { refreshing = false; }
  }
  async function refreshOnce() {
    readVisibleQr();
    const wpp = window.WPP;
    if (!wpp?.isReady) return;
    if (!bound) {
      bound = true;
      wpp.on('conn.auth_code_change', code => {
        publishCode(code?.fullCode);
        void refresh();
      });
      wpp.on('conn.authenticated', () => { authenticated = true; emit({ type: 'state', status: 'connecting', authenticated: true, user: null }); void refresh(); });
      wpp.on('conn.require_auth', () => { authenticated = false; domQrSeen = false; lastImage = ''; lastQr = ''; lastState = ''; void refresh(); });
      for (const event of ['conn.main_ready', 'conn.online']) wpp.on(event, () => { void refresh(); });
      wpp.on('conn.logout', () => emit({ type: 'logout' }));
      wpp.on('conn.needs_update', () => emit({ type: 'needs_update' }));
      wpp.on('chat.new_message', msg => receiveMessage(msg));
      emit({ type: 'receiver_ready' });
    }
    watchMessageStore(wpp);
    try {
      const ready = wpp.conn.isMainReady();
      authenticated = authenticated || ready || wpp.conn.isAuthenticated();
      const status = ready ? (wpp.conn.isOnline() ? 'connected' : 'disconnected') : authenticated ? 'connecting' : 'qr';
      const user = ready ? { id: wid(wpp.conn.getMyUserId()) } : null;
      if (status !== lastState) { lastState = status; emit({ type: 'state', status, user, authenticated }); }
      if (!authenticated && !domQrSeen) {
        const code = await wpp.conn.getAuthCode();
        publishCode(code?.fullCode);
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
    const userAgent = (await this.browser.userAgent()).replace('HeadlessChrome/', 'Chrome/');
    await this.page.setUserAgent(userAgent);
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
  async fetchMessages() {
    return this.page.evaluate(async () => {
      if (!window.WPP?.conn.isMainReady() || !window.__blueSerializeWaMessage) throw new Error('WhatsApp is not ready for synchronization');
      const chats = await window.WPP.chat.list({ count: 50, ignoreGroupMetadata: true });
      const messages = []; let failedChats = 0;
      for (const chat of chats.slice(0, 50)) {
        const id = typeof chat.id === 'string' ? chat.id : chat.id?._serialized || chat.id?.toString();
        if (!/^[0-9-]+@(c\.us|lid|g\.us)$/.test(id || '')) continue;
        try {
          const recent = await window.WPP.chat.getMessages(id, { count: 10, includeCallMessages: false });
          for (const msg of recent.slice(-10)) {
            if (['protocol', 'notification', 'e2e_notification', 'gp2', 'ciphertext'].includes(msg.type)) continue;
            messages.push(window.__blueSerializeWaMessage(msg, true, id, chat.name || chat.formattedTitle || ''));
          }
        } catch { failedChats++; }
      }
      return { messages, chatCount: chats.length, failedChats };
    });
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
