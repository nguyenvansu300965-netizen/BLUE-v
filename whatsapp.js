import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { messageText, messageSelection } from './messages.js';
import { Automation, loadFlows, menuText } from './automation.js';
import { sendFlow } from './flow-sender.js';
import { AppError } from './store.js';

export class WhatsAppAccount {
  constructor(account, store, dataDir) {
    this.account = account; this.store = store;
    this.dir = path.join(dataDir, 'tenants', account.user_id, account.id);
    this.authDir = path.join(this.dir, 'auth'); this.mediaDir = path.join(this.dir, 'media'); this.flowFile = path.join(this.dir, 'flows.json');
    this.clients = new Map(); this.generation = 0; this.connecting = false; this.socket = null;
    this.state = { status: 'idle', qr: null, user: null, error: null };
    this.lastAutomation = null;
  }
  async init() {
    this.config = await loadFlows(this.flowFile);
    this.automation = new Automation(this.config, async (jid, node, mode) => {
      this.requireConnected();
      const image = node.image ? await readFile(path.join(this.mediaDir, node.image)) : undefined;
      this.requireConnected();
      const id = await sendFlow(this.socket, jid, node, mode, image);
      this.remember({ id, jid, name: jid, text: `${node.image ? '[图片] ' : ''}${menuText(node)}`, outgoing: true, time: Date.now(), automatic: true });
      return id;
    }, result => { this.lastAutomation = { ...result, time: Date.now() }; this.broadcast(); });
    return this;
  }
  requireConnected() {
    if (!this.store.allowed(this.account)) throw new AppError(403, '订阅未开通、已到期或号码超出套餐配额');
    if (!this.socket || this.state.status !== 'connected') throw new AppError(409, '请先扫码连接此号码');
  }
  snapshot() { return { ...this.state, account: this.account, messages: this.store.messages(this.account.id), automation: { enabled: this.config.enabled, last: this.lastAutomation } }; }
  broadcast() {
    for (const [response, valid] of this.clients) {
      if (!valid()) { response.write('event: revoked\ndata: {}\n\n'); response.end(); this.clients.delete(response); continue; }
      response.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    }
  }
  update(patch) { this.state = { ...this.state, ...patch }; this.broadcast(); }
  remember(item) { const added = this.store.remember(this.account.id, item); if (added) this.broadcast(); return added; }
  async connect() {
    if (!this.store.allowed(this.account)) throw new AppError(403, '没有使用权限');
    if (this.connecting || this.socket) return;
    this.connecting = true;
    clearTimeout(this.timer);
    const current = ++this.generation;
    this.update({ status: 'connecting', qr: null, error: null });
    try {
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      const { state: auth, saveCreds } = await useMultiFileAuthState(this.authDir);
      if (current !== this.generation || !this.store.allowed(this.account)) return;
      const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
      const client = makeWASocket({ auth, logger: pino({ level: 'silent' }), agent, fetchAgent: agent, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
      this.socket = client;
      client.ev.on('creds.update', () => { if (current === this.generation) saveCreds().catch(() => this.update({ error: '无法保存会话，请检查磁盘权限' })); });
      client.ev.on('connection.update', change => { void (async () => {
        if (current !== this.generation) return;
        if (!this.store.allowed(this.account)) { this.stop('blocked'); return; }
        if (change.qr) {
          const image = await QRCode.toDataURL(change.qr);
          if (current === this.generation && this.state.status !== 'connected') this.update({ status: 'qr', qr: image });
        }
        if (change.connection === 'open') this.update({ status: 'connected', qr: null, user: { id: client.user?.id, name: client.user?.name }, error: null });
        if (change.connection === 'close') {
          this.socket = null;
          const loggedOut = change.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          this.update({ status: loggedOut ? 'logged_out' : 'disconnected', qr: null, user: null, error: loggedOut ? '请重置此号码会话后重新扫码' : '连接中断，5 秒后重试' });
          if (!loggedOut) this.timer = setTimeout(() => { void this.connect().catch(() => this.stop('blocked')); }, 5000);
        }
      })().catch(() => this.update({ error: '连接状态处理失败，请重试' })); });
      client.ev.on('messages.upsert', ({ messages: incoming, type }) => {
        if (current !== this.generation || type !== 'notify' || !this.store.allowed(this.account)) return;
        for (const msg of incoming) {
          const choice = messageSelection(msg.message);
          const text = choice.label || messageText(msg.message);
          if (!text || !msg.key.id || !msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') continue;
          const time = Number(msg.messageTimestamp || Date.now() / 1000) * 1000;
          const added = this.remember({ id: msg.key.id, jid: msg.key.remoteJid, name: msg.pushName || msg.key.remoteJid, text, outgoing: Boolean(msg.key.fromMe), time });
          if (!added) continue;
          void this.automation.handle({ id: msg.key.id, jid: msg.key.remoteJid, fromMe: msg.key.fromMe, text, ...choice, time: Number(msg.messageTimestamp || 0) * 1000 }).catch(() => {});
        }
      });
    } catch { if (current === this.generation) { this.socket?.end(undefined); this.socket = null; this.update({ status: 'error', error: '连接失败，请检查 WhatsApp 网络访问' }); } }
    finally { if (current === this.generation) this.connecting = false; }
  }
  stop(status = 'idle') {
    this.generation++; clearTimeout(this.timer); this.connecting = false;
    this.socket?.end(undefined); this.socket = null;
    this.automation?.sessions.clear();
    this.update({ status, qr: null, user: null, error: status === 'blocked' ? '订阅或套餐权限已变更' : null });
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
  }
  async reset() {
    const client = this.socket;
    this.stop();
    if (client?.user) {
      // The local session is always cleared even when the remote logout is unavailable.
      await Promise.race([client.logout().catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]);
    }
    await rm(this.authDir, { recursive: true, force: true });
  }
}
