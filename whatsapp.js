import QRCode from 'qrcode';
import { resourceSample, connectionDiagnostic, safeStartupReason } from './connection-diagnostics.js';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeWaMessage, toStoredJid, toWaJid, stanzaId, receiptAck, mergeReceipt } from './messages.js';
import { Automation, loadFlows, menuText, renderReplyText } from './automation.js';
import { sendFlow } from './flow-sender.js';
import { AppError } from './store.js';
import { randomBytes } from 'node:crypto';
import { WaJsClient } from './wa-js-client.js';

export class WhatsAppAccount {
  constructor(account, store, dataDir, { createClient = options => new WaJsClient(options), connectTimeout = 120000, sampleResources = resourceSample, logFailure = detail => console.error(JSON.stringify(detail)) } = {}) {
    this.connectTimeout = connectTimeout; this.sampleResources = sampleResources; this.logFailure = logFailure;
    this.createClient = createClient;
    this.account = account; this.store = store;
    this.dir = path.join(dataDir, 'tenants', account.storage_owner_id || account.user_id, account.id);
    this.profileDir = path.join(this.dir, 'browser-profile'); this.sessionMarker = path.join(this.dir, 'wajs-session.json'); this.mediaDir = path.join(this.dir, 'media'); this.flowFile = path.join(this.dir, 'flows.json');
    this.pendingReceipts = new Map();
    this.contactLookups = new Map(); this.contactQueue = Promise.resolve();
    this.mediaDownloads = new Map(); this.mediaQueue = Promise.resolve();
    this.clients = new Map(); this.generation = 0; this.connecting = false; this.client = null;
    this.state = { status: 'idle', qr: null, user: null, error: null };
    this.receiver = { ready: false, received: 0, rejected: 0, lastEventAt: null, lastMessageAt: null, error: null };
    this.lastAutomation = null; this.sync = { status: 'idle', imported: 0, error: null }; this.syncRetries = 0;
  }
  async init() {
    this.config = await loadFlows(this.flowFile);
    this.automation = new Automation(this.config, async (jid, node, mode, contact) => {
      this.requireConnected();
      if (/\{(?:full_name|phone_number)\}/.test(node.text)) {
        let profile = {};
        try { profile = await this.client.contactInfo?.(jid) || {}; } catch { /* Use message profile and verified phone JID when unavailable. */ }
        node = { ...node, text: renderReplyText(node.text, jid, { ...contact, ...profile, name: profile.name || contact?.name, phoneNumber: profile.phoneNumber || contact?.phoneNumber }) };
      }
      const image = node.image ? await readFile(path.join(this.mediaDir, node.image)) : undefined;
      this.requireConnected();
      const id = await sendFlow(this.client, jid, node, mode, image, sent => {
        this.remember({ id: sent.id, jid, name: jid, text: sent.text, ...(sent.image ? { image: node.image } : {}), buttons: sent.buttons, ...(sent.buttons.length ? { flow: { nodeId: node.id, options: structuredClone(node.options) } } : {}), outgoing: true, time: Date.now(), automatic: true });
      });
      return id;
    }, result => { this.lastAutomation = { ...result, time: Date.now() }; this.broadcast(); }, ({ jid, quotedId, nodeId }) => this.store.flowMenu(this.account.id, jid, nodeId, quotedId, this.config.nodes));
    return this;
  }
  requireConnected() {
    if (this.handover) throw new AppError(409, '号码正在分配，请稍后重试');
    if (!this.store.allowed(this.account)) throw new AppError(403, '订阅未开通、已到期或号码超出套餐配额');
    if (!this.client || this.state.status !== 'connected' || !this.state.user?.id) throw new AppError(409, '请先扫码连接此号码');
  }
  snapshot(role = 'admin') { return { ...this.state, ...(role !== 'admin' ? { qr: null } : {}), account: this.account, messages: this.store.messages(this.account.id), contacts: this.store.contacts(this.account.id), sync: this.sync, receiver: this.receiver, automation: { enabled: this.config.enabled, last: this.lastAutomation } }; }
  broadcast() {
    for (const [response, valid] of this.clients) {
      if (!valid()) { response.write('event: revoked\ndata: {}\n\n'); response.end(); this.clients.delete(response); continue; }
      response.write(`data: ${JSON.stringify(this.snapshot(response.workspaceRole))}\n\n`);
    }
  }
  update(patch) { this.state = { ...this.state, ...patch }; this.broadcast(); }
  remember(item) {
    const key = `${item.jid}:${item.id}`, pending = this.pendingReceipts.get(key);
    if (item.outgoing && pending !== undefined) { item = { ...item, ack: mergeReceipt(item.ack, pending) }; this.pendingReceipts.delete(key); }
    const added = this.store.remember(this.account.id, item); if (added) this.broadcast(); return added; }
  async onClientEvent(event, current) {
    if (current !== this.generation) return;
    if (!this.store.allowed(this.account)) { await this.stop('blocked'); return; }
    if (event.type === 'receipt') {
      const id = stanzaId(event.id), jid = typeof event.jid === 'string' ? toStoredJid(event.jid) : '';
      if (!id || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(jid) || receiptAck(event.ack) === undefined) return;
      if (this.store.updateReceipt(this.account.id, id, jid, event.ack)) this.broadcast();
      else if (!this.store.messages(this.account.id).some(m => m.id === id)) {
        const key = `${jid}:${id}`; this.pendingReceipts.set(key, mergeReceipt(this.pendingReceipts.get(key), event.ack));
        if (this.pendingReceipts.size > 500) this.pendingReceipts.delete(this.pendingReceipts.keys().next().value);
      }
    } else if (event.type === 'receiver_ready') {
      this.receiver.ready = true; this.receiver.error = null; this.broadcast();
    } else if (event.type === 'receiver_error') {
      this.receiver.error = event.code === 'MESSAGE_SERIALIZATION' ? '新消息解析异常' : '备用接收通道暂不可用'; this.broadcast();
    } else if (event.type === 'progress') {
      this.update({ stage: ['browser', 'page', 'inject'].includes(event.stage) ? event.stage : null, progress: String(event.detail || '').slice(0, 200) });
    } else if (event.type === 'qr_image' && typeof event.image === 'string' && event.image.startsWith('data:image/png;base64,') && event.image.length < 1000000) {
      clearTimeout(this.startupTimer);
      if (!this.state.authenticated && this.state.status !== 'connected') this.update({ status: 'qr', qr: event.image, error: null, progress: null });
    } else if (event.type === 'qr' && typeof event.code === 'string') {
      const image = await QRCode.toDataURL(event.code);
      if (current === this.generation && !this.state.authenticated && this.state.status !== 'connected') { clearTimeout(this.startupTimer); this.update({ status: 'qr', qr: image, error: null, progress: null }); }
    } else if (event.type === 'state') {
      if (!['connected', 'connecting', 'disconnected', 'qr'].includes(event.status)) return;
      const user = typeof event.user?.id === 'string' && /^[0-9]+@(c\.us|s\.whatsapp\.net|lid)$/.test(event.user.id) ? { id: toStoredJid(event.user.id), phoneNumber: /^[1-9]\d{6,14}$/.test(event.user.phoneNumber || '') ? event.user.phoneNumber : /^([1-9]\d{6,14})@(c\.us|s\.whatsapp\.net)$/.exec(event.user.id)?.[1] || '' } : null;
      const missingIdentity = event.status === 'connected' && !user;
      if (missingIdentity) event = { ...event, status: 'connecting', authenticated: Boolean(event.authenticated) };
      if (event.authenticated && !this.state.authenticated && event.status !== 'connected') {
        clearTimeout(this.startupTimer);
        this.startupTimer = setTimeout(() => {
          const closing = this.stop('error'), stoppedGeneration = this.generation;
          void closing.then(() => { if (this.generation === stoppedGeneration) this.update({ error: '扫码后同步超时，浏览器档案已保留，请重新连接；同时检查手机端关联设备状态。' }); });
        }, 180000);
        this.startupTimer.unref();
      }

      this.update({ status: event.status, user, authenticated: Boolean(event.authenticated || event.status === 'connected'), progress: missingIdentity ? '正在核实 WhatsApp 登录身份，尚未取得当前账号，请等待二维码或登录完成…' : event.authenticated && event.status !== 'connected' ? '已扫码，正在关联设备并同步，请勿重复扫码或重新连接…' : this.state.progress, qr: event.authenticated || event.status === 'connected' ? null : this.state.qr, error: event.status === 'disconnected' ? 'WhatsApp 连接中断，浏览器正在重连' : null });
      if (event.status === 'connected') {
        clearTimeout(this.startupTimer);
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (current === this.generation) {
          await writeFile(this.sessionMarker, JSON.stringify({ engine: 'wa-js', registeredAt: Date.now() }), { mode: 0o600 });
          if (typeof this.client?.fetchMessages === 'function') void this.syncMessages().catch(() => {});
        }
      }
    } else if (event.type === 'message') {
      this.receiver.received++; this.receiver.lastEventAt = Date.now();
      const item = normalizeWaMessage(event.message);
      if (!item || !Number.isFinite(item.time) || item.time <= 0) { this.receiver.rejected++; this.broadcast(); return; }
      this.receiver.lastMessageAt = Date.now();
      const { selection, quotedId, history, ...message } = item;
      const added = this.remember(message);
      this.resolveContact(item.jid);
      if (!history && !item.outgoing && item.media?.type === 'image' && item.media.size <= 5 * 1024 * 1024) void this.downloadMessageMedia(item.id).catch(() => {});
      if (!added || history || this.store.account(this.account.id)?.managed === 1) return;
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
    if (this.handover) throw new AppError(409, '号码正在分配');
    if (!this.store.allowed(this.account)) throw new AppError(403, '没有使用权限');
    if (this.connecting || this.client) return;
    this.connecting = true;
    clearTimeout(this.timer);
    const current = ++this.generation;
    this.update({ status: 'connecting', authenticated: false, qr: null, error: null, stage: 'browser', diagnostic: null });
    this.startupTimer = setTimeout(() => {
      if (current !== this.generation || this.state.qr || this.state.status === 'connected') return;
      const progress = this.state.progress || '等待 WhatsApp 登录页面';
      const closing = this.stop('error'), stoppedGeneration = this.generation;
      void closing.then(() => { if (this.generation === stoppedGeneration) this.update({ error: `获取二维码超时：${progress}。请重新连接，或查看 Railway 网络、内存和浏览器日志。` }); });
    }, this.connectTimeout);
    this.startupTimer.unref();
    const beforeSample = Promise.resolve().then(() => this.sampleResources()).catch(() => ({}));
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
        const stage = this.state.stage;
        const [before, after] = await Promise.all([beforeSample, Promise.resolve().then(() => this.sampleResources()).catch(() => ({}))]);
        if (current !== this.generation) return;
        const diagnostic = connectionDiagnostic(error, stage, before, after);
        const closing = this.stop('error'), stoppedGeneration = this.generation;
        this.update({ error: diagnostic.message, diagnostic });
        this.logFailure({ event: 'whatsapp_connect_failed', accountId: this.account.id, reason: safeStartupReason(error), ...diagnostic });
        await closing;
        if (stoppedGeneration !== this.generation) return;
      }
    } finally { if (current === this.generation) this.connecting = false; }
  }
  stop(status = 'idle') {
    this.generation++; this.pendingReceipts.clear(); clearTimeout(this.timer); clearTimeout(this.startupTimer); clearTimeout(this.syncTimer); this.connecting = false;
    this.receiver.ready = false;
    const client = this.client; this.client = null;
    if (client) this.closing = Promise.resolve(client.close()).catch(() => {});
    this.automation?.sessions.clear();
    this.update({ status, authenticated: false, qr: null, user: null, progress: null, error: status === 'blocked' ? '订阅或套餐权限已变更' : null });
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
    return this.closing || Promise.resolve();
  }
  async syncMessages() {
    this.requireConnected();
    if (this.syncing) return this.syncing;
    const current = this.generation, client = this.client;
    clearTimeout(this.syncTimer);
    this.sync = { ...this.sync, status: 'syncing', error: null }; this.broadcast();
    this.syncing = (async () => {
      try {
        const result = await client.fetchMessages();
        if (current !== this.generation || !this.store.allowed(this.account)) return;
        let imported = 0;
        for (const raw of result.messages) {
          const item = normalizeWaMessage({ ...raw, history: true });
          if (!item || !Number.isFinite(item.time) || item.time <= 0) continue;
          const { selection, quotedId, history, ...message } = item;
          if (this.store.remember(this.account.id, message)) imported++;
          this.resolveContact(item.jid);
        }
        this.sync = { status: 'done', imported, chatCount: result.chatCount, failedChats: result.failedChats, updatedAt: Date.now(), error: result.failedChats ? '部分会话暂未读取成功，可稍后再次同步' : null };
        this.broadcast();
        if ((!result.messages.length || result.failedChats) && this.syncRetries++ < 3) this.syncTimer = setTimeout(() => { void this.syncMessages().catch(() => {}); }, 15000);
      } catch {
        if (current === this.generation) {
          this.sync = { ...this.sync, status: 'error', error: '消息同步失败，请稍后点击同步消息重试' }; this.broadcast();
        }
      }
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  resolveContact(jid) {
    if (!/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(jid) || typeof this.client?.contactInfo !== 'function') return;
    if (Date.now() - (this.contactLookups.get(jid) || 0) < 300000 || this.contactLookups.size >= 1000) return;
    this.contactLookups.set(jid, Date.now()); const current = this.generation;
    this.contactQueue = this.contactQueue.catch(() => {}).then(async () => {
      if (current !== this.generation || !this.store.allowed(this.account) || this.state.status !== 'connected') return;
      const info = await this.client.contactInfo(jid);
      if (current !== this.generation || !this.store.account(this.account.id)) return;
      const name = typeof info?.name === 'string' ? info.name.slice(0, 200) : '';
      const phone = /^[1-9]\d{6,14}$/.test(info?.phoneNumber || '') ? info.phoneNumber : '';
      if (name || phone) { this.store.updateContact(this.account.id, jid, { name, phone }); this.broadcast(); }
    }).catch(() => {});
  }
  downloadMessageMedia(id) {
    if (this.mediaDownloads.has(id)) return this.mediaDownloads.get(id);
    const message = this.store.messages(this.account.id).find(item => item.id === id);
    if (!message) return Promise.reject(new AppError(404, '消息不存在'));
    if (message.attachment) return Promise.resolve(message);
    if (!message.media) return Promise.reject(new AppError(400, '此消息尚无媒体信息，请先同步消息后再试'));
    if (this.mediaDownloads.size >= 20) return Promise.reject(new AppError(429, '媒体下载队列繁忙，请稍后重试'));
    const current = this.generation;
    const task = this.mediaQueue.then(async () => {
      this.requireConnected();
      if (current !== this.generation) throw new AppError(409, '号码连接已变更，请重试');
      let result;
      try { result = await this.client.downloadMessageMedia(message.media.sourceId); }
      catch (error) { throw new AppError(400, String(error.message).includes('MEDIA_TOO_LARGE') ? '媒体超过 20MB，请在手机 WhatsApp 查看' : '媒体下载失败，可能已过期或尚未同步，请稍后重试'); }
      this.requireConnected();
      if (current !== this.generation) throw new AppError(409, '号码连接已变更，请重试');
      if (typeof result?.base64 !== 'string' || result.base64.length > 28000000) throw new AppError(400, '媒体过大或无效');
      const data = Buffer.from(result.base64, 'base64');
      if (!data.length || data.length > 20 * 1024 * 1024) throw new AppError(400, '媒体超过 20MB 或内容为空');
      const mime = String(result.mime || message.media.mime || '').split(';')[0].trim().toLowerCase();
      const safe = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp3|ogg|wav|mp4|webm)|application\/pdf|text\/plain)$/.test(mime);
      const type = safe && mime.startsWith('image/') ? 'image' : safe && mime.startsWith('video/') ? 'video' : safe && mime.startsWith('audio/') ? 'audio' : 'document';
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'application/pdf': 'pdf' }[mime] || 'bin';
      const attachment = { id: randomBytes(16).toString('hex'), name: (message.media.name || `WhatsApp-${message.media.type}.${ext}`).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200), mime: safe ? mime : 'application/octet-stream', type, size: data.length };
      await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.mediaDir, `${attachment.id}.bin`), data, { mode: 0o600 });
      this.store.addAttachment(this.account.id, attachment);
      const updated = this.store.setMessageAttachment(this.account.id, id, attachment);
      if (!updated) throw new AppError(404, '消息已不在当前保留记录中');
      this.broadcast(); return updated;
    });
    this.mediaQueue = task.catch(() => {});
    this.mediaDownloads.set(id, task);
    void task.finally(() => this.mediaDownloads.delete(id)).catch(() => {});
    return task;
  }
  async sendMedia(jid, attachment, caption, voice = false) {
    this.requireConnected();
    const data = await readFile(path.join(this.mediaDir, `${attachment.id}.bin`));
    this.requireConnected();
    return this.client.sendMedia(jid, data, attachment, caption, voice);
  }
  async messageAction(id, action, target) {
    this.requireConnected();
    const message = this.store.messages(this.account.id).find(item => item.id === id);
    if (!message) throw new AppError(404, '消息不存在');
    if (message.revoked) throw new AppError(400, '消息已撤回');
    const source = message.sourceId || message.media?.sourceId || `${Boolean(message.outgoing)}_${toWaJid(message.jid)}_${message.id}`;
    if (action === 'revoke') {
      if (!message.outgoing) throw new AppError(400, '只能撤回自己发送的消息');
      try { await this.client.revokeMessage(source, message.jid); }
      catch { throw new AppError(400, '撤回失败，消息可能已超过 WhatsApp 允许的时限'); }
      this.store.revokeMessage(this.account.id, id); this.broadcast();
    } else if (action === 'forward') {
      if (typeof target !== 'string' || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(target)) throw new AppError(400, '转发目标无效');
      try { await this.client.forwardMessage(source, target); }
      catch { throw new AppError(400, '转发失败，此消息可能不支持转发或尚未同步'); }
      void this.syncMessages().catch(() => {});
    } else throw new AppError(400, '不支持的消息操作');
    return { ok: true };
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
