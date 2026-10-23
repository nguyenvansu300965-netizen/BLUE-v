import puppeteer from 'puppeteer-core';
import { browserResources, scheduleBrowserStart } from './browser-resources.js';
import { launchWithProfileRecovery } from './profile-recovery.js';
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
    const safe = new Proxy(msg, { get(target, key) {
      try { const value = target[key]; if (value !== undefined && value !== null && value !== '') return value; } catch {}
      // WA-JS ModelProxy getters may be unavailable while modules reload.
      // Read only the same explicitly selected fields from model attributes.
      try { return target.attributes?.[key]; } catch { return undefined; }
    } });
    msg = safe;
    const key = msg.id;
    const serialized = typeof key === 'string' ? key : key?._serialized || '';
    const fromMe = typeof key?.fromMe === 'boolean' ? key.fromMe : serialized.startsWith('true_');
    const native = msg.nativeFlowResponseMessage || msg.interactiveResponseMessage?.nativeFlowResponseMessage;
    const string = (...values) => values.find(value => typeof value === 'string' && value.length) || '';
    const buttons = [];
    for (const button of msg.interactivePayload?.buttons || []) {
      try { const params = JSON.parse(button.buttonParamsJson || '{}'); if (typeof params.display_text === 'string') buttons.push({ label: params.display_text }); } catch {}
    }

    return {
      id: typeof key === 'string' ? key : key?.id || key?._serialized,
      chatId: wid(key?.remote) || fallbackChat || serialized.split('_')[1] || wid(fromMe ? msg.to : msg.from), fromMe, sourceId: serialized, ack: Number.isInteger(msg.ack) ? msg.ack : undefined,
      mime: typeof msg.mimetype === 'string' ? msg.mimetype : '', filename: typeof msg.filename === 'string' ? msg.filename : '', size: Number(msg.size || 0),
      body: string(msg.body, msg.text, msg.content, msg.pollName, msg.vcardFormattedName), caption: string(msg.caption),
      buttons, hasMediaAttachment: Boolean(msg.interactiveHeader?.hasMediaAttachment || msg.interactiveHeader?.hasmediaAttachment), mediaType: msg.interactiveHeader?.mediaType, thumbnail: typeof msg.thumbnail === 'string' ? msg.thumbnail : typeof msg.interactiveHeader?.thumbnail === 'string' ? msg.interactiveHeader.thumbnail : undefined,
      name: fallbackName || (typeof msg.notifyName === 'string' ? msg.notifyName : ''), timestamp: Number(msg.t || 0), type: msg.type,
      history: history || Boolean(msg.isMdHistoryMsg), selectedButtonId: msg.selectedButtonId || msg.buttonsResponse?.selectedButtonId,
      selectedId: msg.selectedId || msg.listResponse?.singleSelectReply?.selectedRowId,
      label: msg.selectedButtonText || msg.buttonsResponse?.selectedDisplayText || msg.listResponse?.title,
      nativeFlowParams: native?.paramsJson || msg.nativeFlowParams, quotedId: msg.quotedStanzaID || msg.quotedMsgId?.id || msg.quotedMsgKey?.id
    };
  };
  let selfPhone = { identity: '', number: '', attemptedAt: 0 };
  const phoneFromId = value => /^([1-9]\d{6,14})@(c\.us|s\.whatsapp\.net)$/.exec(value || '')?.[1] || '';
  let bound = null, bindings = [], lastHeartbeat = 0, lastState = '', lastQr = '', lastImage = '', domQrSeen = false, authenticated = false, refreshing = false;
  const liveSince = Math.floor(Date.now() / 1000);
  const delivered = new Map();
  let rawStore = null, lastSweep = 0;
  const receiptStates = new Map();
  function publishReceipt(key, ack, fallbackChat = '') {
    const serialized = typeof key === 'string' ? key : key?._serialized || '';
    if (key?.fromMe !== true && !serialized.startsWith('true_')) return;
    if (!Number.isInteger(ack) || ack < -7 || ack > 4) return;
    const id = typeof key === 'string' ? key : key?.id || serialized;
    const jid = wid(key?.remote) || fallbackChat || serialized.split('_')[1];
    if (!id || !jid) return;
    const identity = `${jid}:${id}`;
    if (receiptStates.get(identity) === ack) return;
    receiptStates.set(identity, ack);
    if (receiptStates.size > 2000) receiptStates.delete(receiptStates.keys().next().value);
    emit({ type: 'receipt', id, jid, ack });
  }
  function receiptHandler(msg) { try { publishReceipt(msg.id, msg.ack); } catch {} }
  const textReads = new Map(), pendingTextReads = new Set();
  function recoverText(raw, source) {
    if (!['chat', 'unknown', undefined].includes(raw.type) || pendingTextReads.size >= 10 || typeof window.WPP?.chat?.getMessageById !== 'function') return;
    const key = `${raw.chatId}:${raw.id}`, previous = textReads.get(key);
    if (pendingTextReads.has(key) || previous && (previous.count >= 3 || Date.now() - previous.time < 5000)) return;
    textReads.set(key, { count: (previous?.count || 0) + 1, time: Date.now() });
    if (textReads.size > 2000) textReads.delete(textReads.keys().next().value);
    pendingTextReads.add(key);
    const sourceId = /^(true|false)_/.test(raw.sourceId || '') ? raw.sourceId : /^(true|false)_/.test(raw.id) ? raw.id : `${Boolean(raw.fromMe)}_${raw.chatId}_${raw.id}`;
    void (async () => {
      let timer;
      try {
        const model = await Promise.race([window.WPP.chat.getMessageById(sourceId), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEXT_READ_TIMEOUT')), 10000); })]);
        if (!model) return;
        const recovered = window.__blueSerializeWaMessage(model, false, raw.chatId);
        if (recovered.id !== raw.id || recovered.chatId !== raw.chatId || recovered.fromMe !== raw.fromMe || !recovered.body && !recovered.caption) return;
        receiveMessage(model, source);
      } catch { /* The periodic store sweep retries temporary loader failures. */ }
      finally { clearTimeout(timer); pendingTextReads.delete(key); }
    })();
  }
  function receiveMessage(msg, source = 'event') {
    try {
      if (!window.WPP?.conn.isMainReady()) return;
      const raw = window.__blueSerializeWaMessage(msg);
      if (['ciphertext', 'protocol', 'notification', 'e2e_notification', 'gp2'].includes(raw.type)) return;
      if (!raw.id || !raw.chatId || !raw.timestamp) return;
      if (source !== 'event' && raw.timestamp < liveSince - 2) return;
      if (!raw.body && !raw.caption && !raw.selectedButtonId && !raw.selectedId && !raw.nativeFlowParams && !raw.label && !raw.hasMediaAttachment && !raw.mime && !['poll_creation', 'poll_update', 'multi_vcard', 'live_location', 'reaction', 'revoked', 'call_log', 'album', 'interactive', 'list', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard'].includes(raw.type)) { recoverText(raw, source); return; }
      const key = `${raw.chatId}:${typeof raw.id === 'string' ? raw.id : ''}`;
      // A MsgModel can arrive before its body/caption/type finishes loading.
      // Suppress identical snapshots, but publish later content enrichment.
      const content = JSON.stringify([raw.type, raw.body, raw.caption, raw.selectedButtonId, raw.selectedId, raw.nativeFlowParams, raw.label, raw.mime, raw.filename, raw.size, raw.buttons, raw.thumbnail, raw.mediaType]);
      let hash = 2166136261;
      for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
      const signature = `${content.length}:${hash >>> 0}`;
      if (delivered.get(key) === signature) return;
      delivered.set(key, signature);
      if (delivered.size > 2000) delivered.delete(delivered.keys().next().value);
      emit({ type: 'message', message: raw, source });
    } catch { emit({ type: 'receiver_error', code: 'MESSAGE_SERIALIZATION' }); }
  }
  function watchMessageStore(wpp) {
    try {
      const store = wpp.whatsapp?.MsgStore;
      if (!store) return;
      if (store !== rawStore) {
        if (rawStore) { try { rawStore.off?.('change:ack', receiptHandler); } catch {} }
        if (rawStore) for (const event of ['add', 'change:type', 'change:body', 'change:caption']) { try { rawStore.off?.(event, rawHandler); } catch {} }
        try {
          store.on('change:ack', receiptHandler);
          for (const event of ['add', 'change:type', 'change:body', 'change:caption']) store.on(event, rawHandler);
          rawStore = store;
        } catch (error) {
          try { store.off?.('change:ack', receiptHandler); } catch {}
          for (const event of ['add', 'change:type', 'change:body', 'change:caption']) { try { store.off?.(event, rawHandler); } catch {} }
          rawStore = null; throw error;
        }
        emit({ type: 'receiver_ready' });
      }
      if (Date.now() - lastSweep < 3000) return;
      lastSweep = Date.now();
      const models = store.getModelsArray?.() || store.models || store._models || [];
      for (const msg of Array.isArray(models) ? models.slice(-200) : []) { receiptHandler(msg); receiveMessage(msg, 'store-sweep'); }
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
    try { await refreshOnce(); } catch { emit({ type: 'receiver_error', code: 'RECEIVER_BINDING' }); } finally { refreshing = false; }
  }
  async function refreshOnce() {
    readVisibleQr();
    const wpp = window.WPP;
    if (!wpp?.isReady) return;
    if (bound !== wpp) {
      for (const [owner, event, handler] of bindings) { try { owner.off?.(event, handler); } catch {} }
      bindings = []; bound = null;
      const listen = (event, handler) => { wpp.on(event, handler); bindings.push([wpp, event, handler]); };
      listen('conn.auth_code_change', code => {
        publishCode(code?.fullCode);
        void refresh();
      });
      listen('conn.authenticated', () => { authenticated = true; emit({ type: 'state', status: 'connecting', authenticated: true, user: null }); void refresh(); });
      listen('conn.require_auth', () => { authenticated = false; selfPhone = { identity: '', number: '', attemptedAt: 0 }; domQrSeen = false; lastImage = ''; lastQr = ''; lastState = ''; void refresh(); });
      for (const event of ['conn.main_ready', 'conn.online']) listen(event, () => { void refresh(); });
      listen('conn.logout', () => emit({ type: 'logout' }));
      listen('conn.needs_update', () => emit({ type: 'needs_update' }));
      listen('chat.new_message', msg => receiveMessage(msg));
      listen('chat.msg_ack_change', event => { for (const key of event?.ids || []) publishReceipt(key, event.ack, wid(event.chat)); });
      bound = wpp; lastState = '';
      emit({ type: 'receiver_ready' });
    }
    watchMessageStore(wpp);
    try {
      const ready = wpp.conn.isMainReady();
      let identity = '';
      if (ready) for (const name of ['getMyUserId', 'getMyUserWid', 'getMyUserLid']) {
        try { const candidate = wid(wpp.conn[name]?.()); if (/^[0-9]+@(c\.us|s\.whatsapp\.net|lid)$/.test(candidate)) { if (!identity || phoneFromId(candidate)) identity = candidate; if (phoneFromId(candidate)) break; } } catch { /* Identity modules may load after main_ready. */ }
      }
      const verifiedReady = Boolean(ready && identity);
      if (verifiedReady && Date.now() - lastHeartbeat >= 10000) {
        lastHeartbeat = Date.now(); emit({ type: 'receiver_heartbeat' });
      }
      authenticated = authenticated || verifiedReady || wpp.conn.isAuthenticated();
      const status = verifiedReady ? (wpp.conn.isOnline() ? 'connected' : 'disconnected') : authenticated ? 'connecting' : 'qr';
      let phoneNumber = phoneFromId(identity);
      if (verifiedReady && !phoneNumber) {
        if (selfPhone.identity !== identity) selfPhone = { identity, number: '', attemptedAt: 0 };
        if (!selfPhone.number && Date.now() - selfPhone.attemptedAt > 10000) {
          selfPhone.attemptedAt = Date.now(); let timer;
          try {
            const entry = await Promise.race([wpp.contact?.getPnLidEntry(identity), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
            const mapped = entry?.phoneNumber;
            selfPhone.number = phoneFromId(wid(mapped)) || phoneFromId(mapped?.id && mapped?.server ? `${mapped.id}@${mapped.server}` : '');
          } catch { /* Keep the verified LID and retry the phone mapping later. */ }
          finally { clearTimeout(timer); }
        }
        phoneNumber = selfPhone.number;
      }
      const user = verifiedReady ? { id: identity, phoneNumber } : null;
      const stateKey = `${status}:${identity}:${phoneNumber}:${authenticated}`;
      if (stateKey !== lastState) { lastState = stateKey; emit({ type: 'state', status, user, authenticated }); }
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
    const resources = await browserResources(executablePath);
    const args = [...resources.args, '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions'];
    if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
    const proxyValue = process.env.CHROMIUM_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = proxyValue ? new URL(proxyValue) : null;
    if (proxy) args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
    const launchOptions = { ...resources, userDataDir: this.profileDir, headless: true, args, timeout: 60000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, protocolTimeout: 120000 };
    this.onEvent({ type: 'progress', stage: 'browser', detail: '正在排队启动此号码的独立浏览器…' });
    this.launching = scheduleBrowserStart(() => {
      if (this.closed) return null;
      this.onEvent({ type: 'progress', stage: 'browser', detail: '正在启动 Chromium 浏览器…' });
      return launchWithProfileRecovery(() => this.launch(launchOptions), this.profileDir, { allowForeignHost: process.env.CHROMIUM_SINGLE_REPLICA === 'true', canceled: () => this.closed, onRecovery: () => this.onEvent({ type: 'progress', stage: 'browser', detail: '已清理残留的浏览器锁，正在恢复此号码登录档案…' }) });
    });
    this.browser = await this.launching;
    if (this.closed) { await this.browser?.close(); return; }
    this.browser.on('disconnected', () => { if (!this.closed) this.onEvent({ type: 'closed' }); });
    this.page = (await this.browser.pages())[0] || await this.browser.newPage();
    if (proxy?.username) await this.page.authenticate({ username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) });
    const userAgent = (await this.browser.userAgent()).replace('HeadlessChrome/', 'Chrome/');
    await this.page.setUserAgent(userAgent);
    await this.page.setBypassCSP(true);
    await this.page.exposeFunction('__blueWaEvent', event => {
      if (this.closed) return;
      if (event.type === 'receiver_heartbeat' || event.type === 'state' && event.status === 'connected') this.lastBridgeAt = Date.now();
      return this.onEvent(event);
    });
    // Watch bridge health, never customer activity: a quiet account must stay connected.
    this.healthTimer = setInterval(() => this.checkBridgeHealth(), 15000);
    this.healthTimer.unref();
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
  checkBridgeHealth(now = Date.now()) {
    if (this.closed || this.healthFailed || !this.lastBridgeAt || now - this.lastBridgeAt < 90000) return;
    this.healthFailed = true;
    void Promise.resolve(this.onEvent({ type: 'closed', reason: 'RECEIVER_HEARTBEAT_TIMEOUT' })).catch(() => {});
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
      // List results can contain a partial plain-text snapshot. Resolve a bounded
      // batch from the canonical message models before persisting placeholders.
      const incomplete = messages.map((message, index) => ({ message, index })).filter(({ message }) => !message.body && !message.caption && ['chat', 'unknown', undefined].includes(message.type)).slice(0, 10);
      await Promise.all(incomplete.map(async ({ message, index }) => {
        let timer;
        const sourceId = /^(true|false)_/.test(message.sourceId || '') ? message.sourceId : /^(true|false)_/.test(message.id) ? message.id : `${Boolean(message.fromMe)}_${message.chatId}_${message.id}`;
        try {
          const model = await Promise.race([window.WPP.chat.getMessageById(sourceId), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEXT_READ_TIMEOUT')), 10000); })]);
          if (!model) return;
          const recovered = window.__blueSerializeWaMessage(model, true, message.chatId, message.name);
          if (recovered.id === message.id && recovered.chatId === message.chatId && recovered.fromMe === message.fromMe && (recovered.body || recovered.caption)) messages[index] = recovered;
        } catch { /* Preserve the original snapshot for an explicit single-message retry. */ }
        finally { clearTimeout(timer); }
      }));
      return { messages, chatCount: chats.length, failedChats };
    });
  }
  async readMessage(sourceId, jid) {
    return this.page.evaluate(async ({ sourceId, chatId }) => {
      let timer;
      try {
        const model = await Promise.race([
          window.WPP.chat.getMessageById(sourceId),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MESSAGE_READ_TIMEOUT')), 10000); })
        ]);
        if (!model) throw new Error('MESSAGE_NOT_AVAILABLE');
        return window.__blueSerializeWaMessage(model, true, chatId);
      } finally { clearTimeout(timer); }
    }, { sourceId, chatId: toWaJid(jid) });
  }
  async downloadMessageMedia(sourceId) {
    return this.page.evaluate(async id => {
      let timer;
      const operation = async () => {
        const msg = await window.WPP.chat.getMessageById(id);
        if (Number(msg?.size || 0) > 20 * 1024 * 1024) throw new Error('MEDIA_TOO_LARGE');
        const blob = await window.WPP.chat.downloadMedia(id);
        if (!(blob instanceof Blob) || !blob.size) throw new Error('MEDIA_UNAVAILABLE');
        if (blob.size > 20 * 1024 * 1024) throw new Error('MEDIA_TOO_LARGE');
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('MEDIA_UNAVAILABLE')); reader.readAsDataURL(blob); });
        return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: blob.type || msg.mimetype || 'application/octet-stream' };
      };
      try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MEDIA_TIMEOUT')), 30000); })]); }
      finally { clearTimeout(timer); }
    }, sourceId);
  }
  async contactInfo(jid) {
    return this.page.evaluate(async to => {
      let timer;
      try {
        const entry = await Promise.race([
          window.WPP.contact.getPnLidEntry(to),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Contact lookup timeout')), 3000); })
        ]);
        const phone = entry?.phoneNumber?._serialized || '';
        return { name: String(entry?.contact?.pushname || entry?.contact?.name || entry?.contact?.verifiedName || '').slice(0, 200), phoneNumber: /^([1-9]\d{6,14})@c\.us$/.exec(phone)?.[1] || '' };
      } catch { return {}; }
      finally { clearTimeout(timer); }
    }, toWaJid(jid));
  }
  async sendText(jid, text, buttons = []) {
    const result = await this.page.evaluate(async ({ to, text, buttons }) => {
      const result = await window.WPP.chat.sendTextMessage(to, text, { buttons: buttons.length ? buttons : undefined, detectMentioned: false, markIsRead: false, waitForAck: true });
      return { id: result.id, ack: result.ack };
    }, { to: toWaJid(jid), text, buttons });
    if (!result?.id) throw new Error('WA-JS returned no message ID');
    if (Number.isInteger(result.ack)) await this.onEvent({ type: 'receipt', id: stanzaId(result.id), jid, ack: result.ack });
    return stanzaId(result.id);
  }
  async sendMedia(jid, data, attachment, caption, voice = false) {
    const result = await this.page.evaluate(async ({ to, dataUrl, type, filename, mime, caption, voice }) => {
      const result = await window.WPP.chat.sendFileMessage(to, dataUrl, { type, filename, mimetype: mime, caption, ...(voice ? { isPtt: true, waveform: true } : {}), markIsRead: false, waitForAck: true });
      return { id: result.id, ack: result.ack };
    }, { to: toWaJid(jid), dataUrl: `data:${attachment.mime};base64,${data.toString('base64')}`, type: attachment.type, filename: attachment.name, mime: attachment.mime, caption, voice });
    if (!result?.id) throw new Error('WA-JS returned no message ID');
    if (Number.isInteger(result.ack)) await this.onEvent({ type: 'receipt', id: stanzaId(result.id), jid, ack: result.ack });
    return stanzaId(result.id);
  }
  async sendImage(jid, dataUrl, caption, buttons = []) {
    const result = await this.page.evaluate(async ({ to, dataUrl, caption, buttons }) => {
      const result = await window.WPP.chat.sendFileMessage(to, dataUrl, { type: 'image', caption, buttons: buttons.length ? buttons : undefined, detectMentioned: false, markIsRead: false, waitForAck: true });
      return { id: result.id, ack: result.ack };
    }, { to: toWaJid(jid), dataUrl, caption, buttons });
    if (!result?.id) throw new Error('WA-JS returned no message ID');
    if (Number.isInteger(result.ack)) await this.onEvent({ type: 'receipt', id: stanzaId(result.id), jid, ack: result.ack });
    return stanzaId(result.id);
  }
  async forwardMessage(sourceId, jid) {
    const failed = await this.page.evaluate(async ({ sourceId, to }) => {
      const failed = await window.WPP.chat.forwardMessages(to, [sourceId]);
      return Array.isArray(failed) ? failed.length : -1;
    }, { sourceId, to: toWaJid(jid) });
    if (failed !== 0) throw new Error('FORWARD_FAILED');
  }
  async revokeMessage(sourceId, jid) {
    const revoked = await this.page.evaluate(async ({ sourceId, to }) => {
      const result = await window.WPP.chat.deleteMessage(to, sourceId, true, true);
      return !Array.isArray(result) && result?.isRevoked === true;
    }, { sourceId, to: toWaJid(jid) });
    if (!revoked) throw new Error('REVOKE_FAILED');
  }
  async logout() { if (this.page && !this.page.isClosed()) await this.page.evaluate(() => window.WPP?.conn.logout()); }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.healthTimer);
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
