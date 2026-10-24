import { migrateQuickReplies, quickReplyMediaDir, materializeQuickReplyAsset } from './quick-replies.js';
import { exportTemplate, importTemplate } from './template-transfer.js';
import express from 'express';
import { defaultTemplates } from './flow-templates.js';
import { mkdir, rm, writeFile, access, copyFile, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, AppError, entitlement, plans } from './store.js';
import { WhatsAppAccount } from './whatsapp.js';
import { recipientJid } from './messages.js';
import { validateFlows, saveFlows } from './automation.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const store = new Store(dataDir);
for (const file of [path.join(root, 'activation-batches', 'initial.json'), ...(process.env.ACTIVATION_CODE_MANIFEST ? [path.resolve(process.env.ACTIVATION_CODE_MANIFEST)] : [])]) store.importActivationBatch(JSON.parse(await readFile(file, 'utf8')));
await store.bootstrap(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
await migrateQuickReplies(store, dataDir);
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
const production = process.env.NODE_ENV === 'production';
if (production && (!publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('PUBLIC_ORIGIN must be your HTTPS public domain in production');
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
const runtimes = new Map();
const pending = new Map();
async function runtime(account) {
  if (runtimes.has(account.id)) return runtimes.get(account.id);
  if (!pending.has(account.id)) {
    pending.set(account.id, new WhatsAppAccount(account, store, dataDir).init().then(rt => { runtimes.set(account.id, rt); return rt; }).finally(() => pending.delete(account.id)));
  }
  return pending.get(account.id);
}
function reconcile() {
  for (const rt of runtimes.values()) {
    if (!store.allowed(rt.account)) rt.stop('blocked');
    else if (rt.state.status === 'blocked') rt.update({ status: 'idle', error: null });
    else rt.broadcast();
  }
}
const subscriptionTimer = setInterval(reconcile, 5000);
subscriptionTimer.unref();
const cookieName = production ? '__Host-blue_session' : 'blue_session';
function token(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1);
}
function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`);
}
const limits = new Map();
function rate(key, max, duration) {
  const now = Date.now();
  if (limits.size > 10000) for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
  if (limits.size > 10000 && !limits.has(key)) throw new AppError(429, '请求过多，请稍后重试');
  let entry = limits.get(key);
  if (!entry || entry.until <= now) { entry = { count: 0, until: now + duration }; limits.set(key, entry); }
  if (++entry.count > max) throw new AppError(429, '请求过多，请稍后重试');
}
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== (publicOrigin || `${req.protocol}://${req.get('host')}`))) throw new AppError(403, '禁止跨域请求');
  }
  next();
});
const smallJson = express.json({ limit: '256kb' });
app.use((req, res, next) => req.path === '/api/admin/templates/import' ? next() : smallJson(req, res, next));
app.post('/api/auth/register', async (req, res) => {
  rate(`register:${req.ip}`, 20, 3600000);
  const user = await store.createUser(req.body?.username, req.body?.password);
  res.status(201).json({ user: store.publicUser(user), message: '注册成功，请登录并联系管理员开通订阅' });
});
app.post('/api/auth/login', async (req, res) => {
  rate(`login:${req.ip}`, 40, 900000);
  rate(`login-user:${String(req.body?.username).toLowerCase().slice(0, 64)}`, 15, 900000);
  const session = await store.login(req.body?.username, req.body?.password);
  setCookie(res, session.token, 7 * 86400);
  res.json({ user: store.publicUser(session.user) });
});
app.use('/api', (req, res, next) => {
  req.sessionToken = token(req);
  req.user = store.session(req.sessionToken);
  if (!req.user) throw new AppError(401, '请先登录');
  const expectedUser = req.get('X-Workspace-User') || req.query.workspaceUser;
  if (expectedUser && expectedUser !== req.user.id) {
    const error = new AppError(409, '登录账号已在其他页面切换，请重新登录'); error.code = 'SESSION_CHANGED'; throw error;
  }
  next();
});
app.post('/api/auth/logout', (req, res) => { store.logout(req.sessionToken); setCookie(res, '', 0); reconcile(); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: store.publicUser(req.user), plans }));
app.use('/api/admin', (req, res, next) => { if (req.user.role !== 'admin') throw new AppError(403, '仅超级管理员可操作'); next(); });
const poolView = account => {
  const rt = runtimes.get(account.id);
  return { id: account.id, label: account.label, managed: account.managed, userId: account.managed !== 1 ? account.user_id : null, username: account.managed !== 1 ? store.user(account.user_id)?.username : null, status: rt?.state.status || 'idle', number: rt?.state.user?.phoneNumber || '', allowed: store.allowed(account) };
};
app.get('/api/admin/numbers', (req, res) => res.json({ accounts: store.db.prepare('SELECT * FROM accounts ORDER BY created_at,id').all().map(poolView) }));
app.post('/api/admin/numbers', (req, res) => { rate(`activation:${req.user.id}`, 30, 60000); res.status(201).json({ account: poolView(store.createManaged(req.user.id, req.body?.label, req.body?.activationCode)) }); });
app.get('/api/admin/numbers/:id/state', async (req, res) => {
  const account = store.account(req.params.id); if (!account) throw new AppError(404, '号码不存在');
  const rt = await runtime(account); res.json({ ...poolView(account), qr: account.managed !== 2 ? rt.state.qr : null, pairing: account.managed !== 2 ? rt.state.pairing : null, error: rt.state.error, progress: rt.state.progress });
});
app.post('/api/admin/numbers/:id/connect', async (req, res) => {
  const account = store.account(req.params.id); if (!account || account.managed === 2) throw new AppError(400, '请先收回托管号码再管理连接');
  const rt = await runtime(account); if (rt.handover) throw new AppError(409, '号码正在分配');
  void rt.connect().catch(() => {}); res.status(202).json({ ok: true });
});
app.post('/api/admin/numbers/:id/pairing', async (req, res) => {
  const account = store.account(req.params.id); if (!account || account.managed === 2) throw new AppError(400, '请先收回托管号码再管理连接');
  if (req.body?.cancel !== true) rate(`pairing:${req.user.id}:${account.id}`, 5, 60000);
  const rt = await runtime(account); if (rt.handover) throw new AppError(409, '号码正在分配');
  const pairing = req.body?.cancel === true ? (await rt.cancelPairing(), null) : await rt.requestPairingCode(req.body?.phone);
  if (store.session(req.sessionToken)?.id !== req.user.id) throw new AppError(401, '请重新登录');
  res.json({ pairing });
});
app.post('/api/admin/numbers/:id/sync', async (req, res) => {
  const account = store.account(req.params.id); if (!account) throw new AppError(404, '号码不存在');
  const rt = await runtime(account); rt.requireConnected(); void rt.syncMessages().catch(() => {}); res.status(202).json({ ok: true });
});
app.post('/api/admin/numbers/:id/logout', async (req, res) => {
  const account = store.account(req.params.id); if (!account || account.managed === 2) throw new AppError(400, '请先收回托管号码再重置');
  const rt = await runtime(account); if (rt.handover) throw new AppError(409, '号码正在分配');
  await rt.reset(); res.json({ ok: true });
});
app.delete('/api/admin/numbers/:id', async (req, res) => {
  const account = store.account(req.params.id); if (!account) throw new AppError(404, '号码不存在');
  const rt = await runtime(account); if (rt.handover) throw new AppError(409, '号码正在分配');
  rt.handover = true;
  try {
    // Keep the stream until ownership checks can report definitive removal.
    await rt.stop('idle', true);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rt.drain = null; reject(new AppError(409, '号码操作尚未结束，请稍后删除')); }, 15000);
      rt.drain = () => { if (!rt.activeRequests) { clearTimeout(timer); rt.drain = null; resolve(); } }; rt.drain();
    });
    await Promise.all([rt.mediaQueue, rt.automation.queue, rt.syncing].filter(Boolean));
    await rm(rt.dir, { recursive: true, force: true }); store.deleteAccount(account.id);
    rt.broadcast(); runtimes.delete(account.id);
  }
  finally { rt.handover = false; }
  res.json({ ok: true });
});
app.patch('/api/admin/numbers/:id/assignment', async (req, res) => {
  const account = store.account(req.params.id); if (!account?.managed) throw new AppError(404, '托管号码不存在');
  const target = req.body?.userId; if (target !== null && typeof target !== 'string') throw new AppError(400, '请选择用户或收回号码');
  const rt = await runtime(account); if (rt.handover) throw new AppError(409, '号码正在分配');
  rt.handover = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rt.drain = null; reject(new AppError(409, '号码操作尚未结束，请稍后分配')); }, 15000);
      rt.drain = () => { if (!rt.activeRequests) { clearTimeout(timer); rt.drain = null; resolve(); } }; rt.drain();
    });
    let queueTimer;
    try { await Promise.race([rt.automation.queue, new Promise((_, reject) => { queueTimer = setTimeout(() => reject(new AppError(409, '自动回复尚未结束，请稍后分配')), 15000); })]); } finally { clearTimeout(queueTimer); }
    // Existing operations finish before access changes; the Chromium connection stays alive.
    const updated = store.assignAccount(req.user.id, account.id, target);
    rt.account = updated; rt.automation.configure(rt.config); rt.broadcast(); reconcile();
    res.json({ account: poolView(updated) });
  } finally { rt.handover = false; }
});
app.get('/api/admin/users', (req, res) => res.json({ users: store.users(), plans, audit: store.audit() }));
app.patch('/api/admin/users/:id', (req, res) => {
  const user = store.grant(req.user.id, req.params.id, req.body);
  reconcile();
  res.json({ user });
});
if (!store.db.prepare('PRAGMA table_info(flow_templates)').all().some(column => column.name === 'revision')) store.db.exec('ALTER TABLE flow_templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
store.db.exec('CREATE TABLE IF NOT EXISTS template_settings (key TEXT PRIMARY KEY)');
if (!store.db.prepare("SELECT key FROM template_settings WHERE key='seeded'").get()) {
  store.db.exec('BEGIN');
  try {
    for (const item of defaultTemplates) store.db.prepare('INSERT INTO flow_templates(id,name,config) VALUES(?,?,?)').run(item.id, item.name, JSON.stringify(validateFlows(item.config)));
    store.db.prepare("INSERT INTO template_settings(key) VALUES('seeded')").run();
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
const templateMedia = path.join(dataDir, 'template-media');
function template(id) {
  const row = store.db.prepare('SELECT * FROM flow_templates WHERE id=?').get(id);
  if (!row) throw new AppError(404, '示例不存在');
  return { id: row.id, name: row.name, config: JSON.parse(row.config), revision: row.revision };
}
app.get('/api/templates', (req, res) => res.json({ templates: store.db.prepare('SELECT id,name,revision FROM flow_templates ORDER BY rowid').all() }));
app.get('/api/admin/templates/:templateId', (req, res) => res.json(template(req.params.templateId)));
app.post('/api/admin/templates', (req, res) => saveSharedTemplate(req, res, templateMedia));
app.post('/api/admin/template-assets/media', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), async (req, res) => {
  const data = req.body;
  if (!Buffer.isBuffer(data) || data.length < 12) throw new AppError(400, '请选择PNG、JPEG或WebP图片，最大5MB');
  const ext = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpg' : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!ext) throw new AppError(400, '图片格式无效');
  await mkdir(templateMedia, { recursive: true, mode: 0o700 }); const id = `${randomBytes(16).toString('hex')}.${ext}`;
  await writeFile(path.join(templateMedia, id), data, { mode: 0o600 }); res.json({ id });
});
app.get('/api/admin/template-assets/media/:asset', (req, res) => {
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(req.params.asset)) throw new AppError(404, '图片不存在');
  res.sendFile(path.join(templateMedia, req.params.asset));
});
app.get('/api/admin/templates/:templateId/export', async (req, res) => {
  rate(`template-export:${req.user.id}`, 20, 60000);
  const item = template(req.params.templateId);
  try { res.json({ name: item.name, code: await exportTemplate(item, templateMedia) }); }
  catch { throw new AppError(400, '示例图片缺失、格式异常或资源过大，请检查后重新导出'); }
});
app.post('/api/admin/templates/import', express.json({ limit: '24mb' }), async (req, res) => {
  rate(`template-import:${req.user.id}`, 20, 60000);
  let item;
  try { item = importTemplate(req.body?.code); } catch (error) { throw new AppError(400, error.message); }
  if (store.db.prepare('SELECT count(*) AS n FROM flow_templates').get().n >= 100) throw new AppError(400, '最多100个示例');
  await mkdir(templateMedia, { recursive: true, mode: 0o700 }); const created = [];
  try {
    const mapping = new Map();
    for (const [old, data] of item.images) {
      const filename = `${randomBytes(16).toString('hex')}.${old.split('.').pop()}`;
      const file = path.join(templateMedia, filename); await writeFile(file, data, { mode: 0o600, flag: 'wx' }); created.push(file); mapping.set(old, filename);
    }
    const config = { ...item.config, nodes: item.config.nodes.map(n => ({ ...n, image: n.image ? mapping.get(n.image) : '' })) };
    const id = randomUUID();
    // Recheck after file writes so concurrent imports cannot exceed the template limit.
    if (store.db.prepare('SELECT count(*) AS n FROM flow_templates').get().n >= 100) throw new AppError(400, '最多100个示例');
    store.db.prepare('INSERT INTO flow_templates(id,name,config) VALUES(?,?,?)').run(id, item.name, JSON.stringify(config));
    res.status(201).json({ template: { id, name: item.name, revision: 1 } });
  } catch (error) { await Promise.all(created.map(file => rm(file, { force: true }))); throw error; }
});
app.delete('/api/admin/templates/:templateId', (req, res) => {
  template(req.params.templateId);
  store.db.prepare('DELETE FROM flow_templates WHERE id=?').run(req.params.templateId);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/password', async (req, res) => {
  rate(`password-admin:${req.user.id}`, 60, 900000);
  const reset = req.body?.reset === true;
  if (reset && req.body.password !== undefined) throw new AppError(400, '请选择修改密码或随机重置');
  const password = reset ? randomBytes(18).toString('base64url') : req.body?.password;
  await store.changePassword(req.user.id, req.params.id, password, reset);
  reconcile();
  res.json({ ok: true, ...(reset ? { password } : {}) });
});
app.get('/api/accounts', (req, res) => res.json({ accounts: store.accounts(req.user.id).map(a => ({ ...a, allowed: store.allowed(a), status: runtimes.get(a.id)?.state.status || 'idle', number: runtimes.get(a.id)?.state.user?.phoneNumber || '' })), user: store.publicUser(req.user) }));
app.post('/api/accounts', (req, res) => { throw new AppError(403, req.user.role === 'admin' ? '请在托管号码管理中添加并分配号码' : '请联系管理员分配号码，已有自有号码可继续使用'); });
app.use('/api/accounts/:id', async (req, res, next) => {
  const account = store.account(req.params.id);
  if (!account || !store.canAccess(req.user.id, account)) throw new AppError(404, '号码不存在');
  req.account = account;
  if (!(req.method === 'DELETE' && req.path === '/') && !store.allowed(account)) throw new AppError(403, '订阅未开通、已到期或号码超出套餐配额');
  req.runtime = await runtime(account);
  if (req.runtime.handover) throw new AppError(409, '号码正在分配，请稍后重试');
  if (req.path !== '/events') {
    req.runtime.activeRequests = (req.runtime.activeRequests || 0) + 1;
    let done = false; const release = () => { if (!done) { done = true; req.runtime.activeRequests--; req.runtime.drain?.(); } };
    res.once('finish', release); res.once('close', release);
  }
  next();
});
const accountRouter = express.Router({ mergeParams: true });
accountRouter.delete('/', async (req, res) => {
  if (req.user.role !== 'admin') throw new AppError(403, '仅管理员可管理号码');
  if (req.account.managed) throw new AppError(403, '托管号码请联系管理员收回');
  await req.runtime.stop();
  await rm(req.runtime.dir, { recursive: true, force: true });
  store.deleteAccount(req.account.id); runtimes.delete(req.account.id);
  reconcile(); res.json({ ok: true });
});
accountRouter.post('/sync', (req, res) => { req.runtime.requireConnected(); void req.runtime.syncMessages().catch(() => {}); res.status(202).json({ sync: req.runtime.sync }); });
accountRouter.get('/diagnostics', async (req, res) => res.json(await req.runtime.diagnostics()));
accountRouter.get('/state', (req, res) => res.json(req.runtime.snapshot(req.user.role)));
accountRouter.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.flushHeaders(); res.setTimeout(0); res.socket?.setKeepAlive(true, 15000);
  const rt = req.runtime; res.workspaceRole = req.user.role;
  rt.clients.set(res, () => store.session(req.sessionToken)?.id === req.user.id && store.canAccess(req.user.id, req.account) && store.allowed(req.account));
  res.write(`retry: 3000\ndata: ${JSON.stringify(rt.snapshot(req.user.role))}\n\n`);
  const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 10000);
  res.on('close', () => { clearInterval(heartbeat); rt.clients.delete(res); });
});
accountRouter.post('/connect', async (req, res) => {
  if (req.user.role !== 'admin') throw new AppError(403, '仅管理员可管理号码');
  if (req.account.managed) throw new AppError(403, '托管号码请联系管理员管理连接');
  if (req.body?.restart === true) await req.runtime.stop();
  void req.runtime.connect().catch(() => req.runtime.stop('blocked'));
  res.status(202).json({ ok: true });
});
accountRouter.post('/pairing', async (req, res) => {
  if (req.user.role !== 'admin' || req.account.managed) throw new AppError(403, '仅管理员可管理号码关联');
  if (req.body?.cancel !== true) rate(`pairing:${req.user.id}:${req.account.id}`, 5, 60000);
  const pairing = req.body?.cancel === true ? (await req.runtime.cancelPairing(), null) : await req.runtime.requestPairingCode(req.body?.phone);
  if (store.session(req.sessionToken)?.id !== req.user.id) throw new AppError(401, '请重新登录');
  res.json({ pairing });
});
accountRouter.post('/logout', async (req, res) => { if (req.user.role !== 'admin') throw new AppError(403, '仅管理员可管理号码'); if (req.account.managed) throw new AppError(403, '托管号码请联系管理员管理连接'); await req.runtime.reset(); res.json({ ok: true }); });
accountRouter.patch('/contacts', (req, res) => {
  const { jid, remark, readAt } = req.body || {};
  if (typeof jid !== 'string' || !store.messages(req.account.id).some(m => m.jid === jid)) throw new AppError(404, '会话不存在');
  if ((remark !== undefined && (typeof remark !== 'string' || remark.length > 100)) || (readAt !== undefined && (!Number.isSafeInteger(readAt) || readAt < 0 || readAt > Date.now() + 5000)) || (remark === undefined && readAt === undefined)) throw new AppError(400, '备注最多100字，已读时间必须有效');
  const contact = store.updateContact(req.account.id, jid, { ...(remark !== undefined ? { remark: remark.trim() } : {}), ...(readAt !== undefined ? { readAt: Math.min(readAt, Date.now()) } : {}) });
  req.runtime.broadcast(); res.json({ contact });
});
accountRouter.post('/messages', async (req, res) => {
  const { text = '', phone, jid: selectedJid, attachment: attachmentId, voice = false } = req.body || {};
  const attachment = attachmentId ? store.attachment(req.account.id, attachmentId) : null;
  if (typeof voice !== 'boolean' || (voice && attachment?.type !== 'audio')) throw new AppError(400, '语音消息需要音频附件');
  if (attachmentId && !attachment) throw new AppError(400, '附件不存在，请重新选择');
  if (typeof text !== 'string' || (!text.trim() && !attachment) || text.length > 4096) throw new AppError(400, '请输入消息或选择附件，文案最多 4096 字');
  let jid;
  if (selectedJid) {
    if (typeof selectedJid !== 'string' || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(selectedJid) || !store.messages(req.account.id).some(m => m.jid === selectedJid)) throw new AppError(400, '请选择当前号码下的会话');
    jid = selectedJid;
  } else { try { jid = recipientJid(phone); } catch (error) { throw new AppError(400, error.message); } }
  req.runtime.requireConnected();
  const id = attachment ? await req.runtime.sendMedia(jid, attachment, text.trim(), voice) : await req.runtime.sendText(jid, text.trim());
  req.runtime.remember({ id, jid, name: jid, text: text.trim() || `[${attachment?.name || '附件'}]`, ...(attachment ? { attachment } : {}), manual: true, outgoing: true, time: Date.now() });
  res.json({ ok: true, id });
});
accountRouter.post('/messages/:messageId/forward', async (req, res) => {
  let target;
  if (req.body?.jid) {
    target = req.body.jid;
    if (!store.messages(req.account.id).some(m => m.jid === target)) throw new AppError(400, '请选择当前号码下的目标会话');
  } else { try { target = recipientJid(req.body?.phone); } catch (error) { throw new AppError(400, error.message); } }
  res.json(await req.runtime.messageAction(req.params.messageId, 'forward', target));
});
accountRouter.post('/messages/:messageId/revoke', async (req, res) => res.json(await req.runtime.messageAction(req.params.messageId, 'revoke')));
accountRouter.post('/messages/:messageId/refresh', async (req, res) => res.json(await req.runtime.refreshMessage(req.params.messageId)));
accountRouter.post('/messages/:messageId/media', async (req, res) => res.json({ message: await req.runtime.downloadMessageMedia(req.params.messageId) }));
const mediaTypes = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio', 'audio/mp4': 'audio', 'audio/webm': 'audio',
  'application/pdf': 'document', 'text/plain': 'document', 'application/zip': 'document', 'application/octet-stream': 'document',
  'application/msword': 'document', 'application/vnd.ms-excel': 'document', 'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document'
};
app.use(['/api/quick-replies', '/api/quick-reply-assets'], (req, res, next) => {
  if (!entitlement(req.user).active) throw new AppError(403, '订阅未开通或已到期');
  next();
});
accountRouter.all(['/quick-replies', '/quick-replies/:replyId'], () => { throw new AppError(409, '快捷回复已升级为用户共享，请刷新页面后重试'); });
app.get('/api/quick-replies', (req, res) => res.json({ replies: store.userQuickReplies(req.user.id) }));
app.post('/api/quick-replies', (req, res) => res.json({ reply: store.saveUserQuickReply(req.user.id, null, req.body) }));
app.put('/api/quick-replies/:replyId', (req, res) => res.json({ reply: store.saveUserQuickReply(req.user.id, req.params.replyId, req.body) }));
app.delete('/api/quick-replies/:replyId', (req, res) => { store.deleteUserQuickReply(req.user.id, req.params.replyId); res.json({ ok: true }); });
app.post('/api/quick-reply-assets', express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
  const mime = req.query.mime, name = req.query.name;
  if (typeof mime !== 'string' || !Object.hasOwn(mediaTypes, mime) || typeof name !== 'string' || !name.trim() || name.length > 200) throw new AppError(400, '文件类型或名称无效');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(400, '请选择非空附件（最大 20MB）');
  const item = { id: randomBytes(16).toString('hex'), name: name.replace(/[\x00-\x1f\x7f/\\]/g, '_'), mime, type: mediaTypes[mime], size: req.body.length };
  const dir = quickReplyMediaDir(dataDir, req.user.id); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${item.id}.bin`); await writeFile(file, req.body, { mode: 0o600 });
  try { store.addQuickReplyAsset(req.user.id, item); } catch (error) { await rm(file, { force: true }); throw error; }
  res.json({ attachment: store.quickReplyAsset(req.user.id, item.id) });
});
app.get('/api/quick-reply-assets/:asset', (req, res) => {
  const item = store.quickReplyAsset(req.user.id, req.params.asset);
  if (!item || !/^[a-f0-9]{32}$/.test(item.id)) throw new AppError(404, '附件不存在');
  res.type(item.mime); if (item.type === 'document') res.attachment(item.name);
  res.sendFile(path.join(quickReplyMediaDir(dataDir, req.user.id), `${item.id}.bin`));
});
accountRouter.post('/quick-reply-attachments', async (req, res) => {
  const asset = store.quickReplyAsset(req.user.id, req.body?.attachment);
  if (!asset) throw new AppError(404, '快捷回复附件不存在');
  const attachment = await materializeQuickReplyAsset(store, req.user.id, req.account.id, asset, req.runtime.mediaDir, dataDir);
  res.json({ attachment });
});
accountRouter.post('/attachments', express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
  const mime = req.query.mime, name = req.query.name;
  if (typeof mime !== 'string' || !Object.hasOwn(mediaTypes, mime) || typeof name !== 'string' || !name.trim() || name.length > 200) throw new AppError(400, '文件类型或名称无效');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(400, '请选择非空附件（最大 20MB）');
  const item = { id: randomBytes(16).toString('hex'), name: name.replace(/[\x00-\x1f\x7f/\\]/g, '_'), mime, type: mediaTypes[mime], size: req.body.length };
  await mkdir(req.runtime.mediaDir, { recursive: true, mode: 0o700 });
  const file = path.join(req.runtime.mediaDir, `${item.id}.bin`);
  await writeFile(file, req.body, { mode: 0o600 });
  try { store.addAttachment(req.account.id, item); } catch (error) { await rm(file, { force: true }); throw error; }
  res.json({ attachment: item });
});
accountRouter.get('/attachments/:asset', (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.asset)) throw new AppError(404, '附件不存在');
  const item = store.attachment(req.account.id, req.params.asset);
  if (!item) throw new AppError(404, '附件不存在');
  res.type(item.mime);
  if (item.type === 'document' || req.query.download === '1') res.attachment(item.name);
  res.sendFile(path.join(req.runtime.mediaDir, `${item.id}.bin`));
});
accountRouter.post('/media', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), async (req, res) => {
  const data = req.body;
  if (!Buffer.isBuffer(data) || data.length < 12) throw new AppError(400, '请选择 PNG、JPEG 或 WebP 图片（最大 5MB）');
  const ext = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpg' : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!ext) throw new AppError(400, '图片格式无效');
  await mkdir(req.runtime.mediaDir, { recursive: true, mode: 0o700 });
  const id = `${randomBytes(16).toString('hex')}.${ext}`;
  await writeFile(path.join(req.runtime.mediaDir, id), data, { mode: 0o600 }); res.json({ id });
});
accountRouter.get('/media/:asset', (req, res) => {
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(req.params.asset)) throw new AppError(404, '图片不存在');
  res.sendFile(path.join(req.runtime.mediaDir, req.params.asset));
});
async function saveSharedTemplate(req, res, sourceMedia) {
  if (req.user.role !== 'admin') throw new AppError(403, '仅超级管理员可编辑示例');
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new AppError(400, '示例名称需要 1–80 字');
  let config;
  try { config = validateFlows(req.body.config); } catch (error) { throw new AppError(400, error.message); }
  const id = req.body.id || randomUUID();
  const existing = req.body.id ? template(id) : null;
  if (existing && req.body.revision !== undefined && req.body.revision !== existing.revision) throw new AppError(409, '示例已被其他页面更新，请重新载入最新版本后再保存');
  if (!existing && store.db.prepare('SELECT count(*) AS n FROM flow_templates').get().n >= 100) throw new AppError(400, '最多 100 个示例');
  await mkdir(templateMedia, { recursive: true, mode: 0o700 });
  for (const node of config.nodes) if (node.image) {
    try { if (sourceMedia === templateMedia) await access(path.join(templateMedia, node.image)); else await copyFile(path.join(sourceMedia, node.image), path.join(templateMedia, node.image)); }
    catch { throw new AppError(400, '示例图片不存在，请重新上传'); }
  }
  const serialized = JSON.stringify({ ...config, enabled: false });
  if (existing) {
    const updated = store.db.prepare('UPDATE flow_templates SET name=?,config=?,revision=revision+1 WHERE id=? AND revision=?').run(name.trim(), serialized, id, existing.revision);
    if (!updated.changes) throw new AppError(409, '示例已被其他页面更新或删除，请重新载入后再保存');
  } else store.db.prepare('INSERT INTO flow_templates(id,name,config) VALUES(?,?,?)').run(id, name.trim(), serialized);
  res.json({ id, name: name.trim(), revision: existing ? existing.revision + 1 : 1 });
}
accountRouter.post('/templates', (req, res) => saveSharedTemplate(req, res, req.runtime.mediaDir));
accountRouter.post('/templates/:templateId/load', async (req, res) => {
  const item = template(req.params.templateId);
  const config = validateFlows(item.config);
  await mkdir(req.runtime.mediaDir, { recursive: true, mode: 0o700 });
  for (const node of config.nodes) if (node.image) await copyFile(path.join(templateMedia, node.image), path.join(req.runtime.mediaDir, node.image));
  const loaded = { ...config, enabled: false };
  res.json(req.query.details === '1' ? { config: loaded, template: { id: item.id, name: item.name, revision: item.revision } } : loaded);
});
accountRouter.get('/flows', (req, res) => res.json(req.runtime.config));
accountRouter.post('/flows', async (req, res) => {
  const rt = req.runtime;
  if (rt.savingFlows) throw new AppError(409, '正在保存，请稍后重试');
  rt.savingFlows = true;
  try {
    let config;
    try { config = validateFlows(req.body); } catch (error) { throw new AppError(400, error.message); }
    for (const node of config.nodes) if (node.image) { try { await access(path.join(rt.mediaDir, node.image)); } catch { throw new AppError(400, '请先为此号码上传图片'); } }
    await saveFlows(rt.flowFile, config);
    if (!store.canAccess(req.user.id, req.account) || !store.allowed(req.account)) throw new AppError(403, '订阅权限已变更');
    rt.config = config; rt.automation.configure(config); rt.broadcast(); res.json({ ok: true });
  } finally { rt.savingFlows = false; }
});
app.use('/api/accounts/:id', accountRouter);
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(root, 'public'), { setHeaders(res, file) { if (/\.(html|js)$/.test(file)) res.set('Cache-Control', 'no-store'); } }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof AppError ? error.status : [400, 404, 413].includes(error.status) ? error.status : 500;
  res.status(status).json({ ...(error.code === 'SESSION_CHANGED' ? { code: error.code } : {}), error: status === 500 ? '操作失败，请检查服务存储及连接' : status === 413 ? '文件或配置超过大小限制' : status === 404 ? '资源不存在' : error.message });
});
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', error => {
  if (error) { console.error(`Unable to start server: ${error.code || 'listen failed'}`); process.exit(1); }
  console.log(`BLUE-v listening on port ${server.address().port}`);
  if (process.env.AUTO_CONNECT === 'true') {
    for (const account of store.db.prepare('SELECT * FROM accounts').all()) if (store.allowed(account)) {
      void access(path.join(dataDir, 'tenants', account.storage_owner_id || account.user_id, account.id, 'wajs-session.json')).then(() => runtime(account)).then(rt => rt.connect()).catch(() => {});
    }
  }
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(subscriptionTimer);
  setTimeout(() => process.exit(0), 15000).unref();
  const closed = new Promise(resolve => server.close(resolve));
  await Promise.all([...runtimes.values()].map(rt => rt.stop()));
  await closed; store.close(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
