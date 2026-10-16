import QRCode from 'qrcode';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeWaMessage, toStoredJid } from './messages.js';
import { Automation, loadFlows, menuText } from './automation.js';
import { sendFlow } from './flow-sender.js';
import { AppError } from './store.js';
import { WaJsClient } from './wa-js-client.js';

export class WhatsAppAccount {
  constructor(account, store, dataDir, { createClient = options => new WaJsClient(options), connectTimeout = 120000 } = {}) {
    this.connectTimeout = connectTimeout;
    this.createClient = createClient;
    this.account = account; this.store = store;
    this.dir = path.join(dataDir, 'tenants', account.user_id, account.id);
    this.profileDir = path.join(this.dir, 'browser-profile'); this.sessionMarker = path.join(this.dir, 'wajs-session.json'); this.mediaDir = path.join(this.dir, 'media'); this.flowFile = path.join(this.dir, 'flows.json');
    this.clients = new Map(); this.generation = 0; this.connecting = false; this.client = null;
    this.state = { status: 'idle', qr: null, user: null, error: null };
    this.lastAutomation = null;
  }
  async init() {
    this.config = await loadFlows(this.flowFile);
    this.automation = new Automation(this.config, async (jid, node, mode) => {
      this.requireConnected();
      const image = node.image ? await readFile(path.join(this.mediaDir, node.image)) : undefined;
      this.requireConnected();
      const id = await sendFlow(this.client, jid, node, mode, image);
      this.remember({ id, jid, name: jid, text: `${node.image ? '[图片] ' : ''}${menuText(node)}`, outgoing: true, time: Date.now(), automatic: true });
      return id;
    }, result => { this.lastAutomation = { ...result, time: Date.now() }; this.broadcast(); });
    return this;
  }
  requireConnected() {
    if (!this.store.allowed(this.account)) throw new AppError(403, '订阅未开通、已到期或号码超出套餐配额');
    if (!this.client || this.state.status !== 'connected') throw new AppError(409, '请先扫码连接此号码');
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
  async onClientEvent(event, current) {
    if (current !== this.generation) return;
    if (!this.store.allowed(this.account)) { await this.stop('blocked'); return; }
    if (event.type === 'progress') {
      this.update({ progress: String(event.detail || '').slice(0, 200) });
    } else if (event.type === 'qr_image' && typeof event.image === 'string' && event.image.startsWith('data:image/png;base64,') && event.image.length < 1000000) {
      clearTimeout(this.startupTimer);
      if (this.state.status !== 'connected') this.update({ status: 'qr', qr: event.image, error: null, progress: null });
    } else if (event.type === 'qr' && typeof event.code === 'string') {
      const image = await QRCode.toDataURL(event.code);
      if (current === this.generation && this.state.status !== 'connected') { clearTimeout(this.startupTimer); this.update({ status: 'qr', qr: image, error: null, progress: null }); }
    } else if (event.type === 'state') {
      if (!['connected', 'connecting', 'disconnected', 'qr'].includes(event.status)) return;
      const user = event.user?.id ? { id: toStoredJid(event.user.id) } : null;
      this.update({ status: event.status, user, qr: event.status === 'connected' ? null : this.state.qr, error: event.status === 'disconnected' ? 'WhatsApp 连接中断，浏览器正在重连' : null });
      if (event.status === 'connected') {
        clearTimeout(this.startupTimer);
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (current === this.generation) await writeFile(this.sessionMarker, JSON.stringify({ engine: 'wa-js', registeredAt: Date.now() }), { mode: 0o600 });
      }
    } else if (event.type === 'message') {
      const item = normalizeWaMessage(event.message);
      if (!item || !Number.isFinite(item.time) || item.time <= 0) return;
      const { selection, quotedId, ...message } = item;
      if (!this.remember(message)) return;
      void this.automation.handle({ ...item, fromMe: item.outgoing, selection, quotedId }).catch(() => {});
    } else if (event.type === 'logout') {
      await rm(this.sessionMarker, { force: true });
      await this.stop('logged_out');
    } else if (event.type === 'needs_update') {
      await this.stop('error');
      this.update({ error: 'WhatsApp Web 要求更新，请更新 WA-JS 后重新连接' });
    } else if (event.type === 'closed') {
      await this.stop('disconnected');
      this.update({ error: '浏览器连接已关闭，5 秒后重试' });
      this.timer = setTimeout(() => { void this.connect().catch(() => this.stop('blocked')); }, 5000);
    } else if (event.type === 'injection_error') {
      await this.stop('error');
      this.update({ error: 'WA-JS 未能初始化，请检查 WhatsApp 网页可达性并重试' });
    }
  }
  async connect() {
    if (!this.store.allowed(this.account)) throw new AppError(403, '没有使用权限');
    if (this.connecting || this.client) return;
    this.connecting = true;
    clearTimeout(this.timer);
    const current = ++this.generation;
    this.update({ status: 'connecting', qr: null, error: null });
    this.startupTimer = setTimeout(() => {
      if (current !== this.generation || this.state.qr || this.state.status === 'connected') return;
      const progress = this.state.progress || '等待 WhatsApp 登录页面';
      const closing = this.stop('error'), stoppedGeneration = this.generation;
      void closing.then(() => { if (this.generation === stoppedGeneration) this.update({ error: `获取二维码超时：${progress}。请重新连接，或查看 Railway 网络、内存和浏览器日志。` }); });
    }, this.connectTimeout);
    this.startupTimer.unref();
    try {
      await this.closing;
      if (current !== this.generation || !this.store.allowed(this.account)) return;
      const client = this.createClient({ profileDir: this.profileDir, onEvent: event => this.onClientEvent(event, current).catch(() => {
        if (current === this.generation) this.update({ error: 'WhatsApp 事件处理失败，请检查数据目录权限' });
      }) });
      this.client = client;
      await client.start();
    } catch (error) {
      if (current === this.generation) {
        await this.stop('error');
        const hints = { PAGE_TIMEOUT: '打开 WhatsApp 网页超时，请检查 Railway 出站网络', CHROMIUM_MISSING: '未安装 Chromium，请检查 CHROMIUM_PATH', CERTIFICATE_UNTRUSTED: '浏览器不信任连接证书，请检查网络代理的 CA 信任配置', PROXY_REJECTED: '网络代理拒绝连接，请检查代理与 WhatsApp 域名放行设置', WEB_HTTP_403: 'WhatsApp 网页访问被拒绝，请检查出站网络设置' };
        this.update({ error: hints[error.code] || 'WA-JS 连接失败，请检查浏览器、WhatsApp 网络及数据卷权限' });
      }
    } finally { if (current === this.generation) this.connecting = false; }
  }
  stop(status = 'idle') {
    this.generation++; clearTimeout(this.timer); clearTimeout(this.startupTimer); this.connecting = false;
    const client = this.client; this.client = null;
    if (client) this.closing = Promise.resolve(client.close()).catch(() => {});
    this.automation?.sessions.clear();
    this.update({ status, qr: null, user: null, progress: null, error: status === 'blocked' ? '订阅或套餐权限已变更' : null });
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
    return this.closing || Promise.resolve();
  }
  async sendText(jid, text) {
    this.requireConnected();
    return this.client.sendText(jid, text);
  }
  async reset() {
    if (this.client && this.state.status === 'connected') {
      let timeout;
      try { await Promise.race([this.client.logout().catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, 3000); timeout.unref(); })]); }
      finally { clearTimeout(timeout); }
    }
    await this.stop();
    await rm(this.profileDir, { recursive: true, force: true });
    await rm(this.sessionMarker, { force: true });
  }
}
