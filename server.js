import express from 'express';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, AppError, entitlement, plans } from './store.js';
import { WhatsAppAccount } from './whatsapp.js';
import { recipientJid } from './messages.js';
import { validateFlows, saveFlows } from './automation.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const store = new Store(dataDir);
await store.bootstrap(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
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
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
app.use(express.json({ limit: '256kb' }));
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
  next();
});
app.post('/api/auth/logout', (req, res) => { store.logout(req.sessionToken); setCookie(res, '', 0); reconcile(); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: store.publicUser(req.user), plans }));
app.use('/api/admin', (req, res, next) => { if (req.user.role !== 'admin') throw new AppError(403, '仅超级管理员可操作'); next(); });
app.get('/api/admin/users', (req, res) => res.json({ users: store.users(), plans, audit: store.audit() }));
app.patch('/api/admin/users/:id', (req, res) => {
  const user = store.grant(req.user.id, req.params.id, req.body);
  reconcile();
  res.json({ user });
});
app.get('/api/accounts', (req, res) => res.json({ accounts: store.accounts(req.user.id).map(a => ({ ...a, allowed: store.allowed(a), status: runtimes.get(a.id)?.state.status || 'idle', number: runtimes.get(a.id)?.state.user?.id || '' })), user: store.publicUser(req.user) }));
app.post('/api/accounts', (req, res) => res.status(201).json({ account: store.createAccount(req.user.id, req.body?.label) }));
app.use('/api/accounts/:id', async (req, res, next) => {
  const account = store.account(req.params.id);
  if (!account || account.user_id !== req.user.id) throw new AppError(404, '号码不存在');
  req.account = account;
  if (!(req.method === 'DELETE' && req.path === '/') && !store.allowed(account)) throw new AppError(403, '订阅未开通、已到期或号码超出套餐配额');
  req.runtime = await runtime(account);
  next();
});
const accountRouter = express.Router({ mergeParams: true });
accountRouter.delete('/', async (req, res) => {
  await req.runtime.stop();
  await rm(req.runtime.dir, { recursive: true, force: true });
  store.deleteAccount(req.account.id); runtimes.delete(req.account.id);
  reconcile(); res.json({ ok: true });
});
accountRouter.get('/state', (req, res) => res.json(req.runtime.snapshot()));
accountRouter.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  const rt = req.runtime;
  rt.clients.set(res, () => Boolean(store.session(req.sessionToken)) && store.allowed(req.account));
  res.write(`data: ${JSON.stringify(rt.snapshot())}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  res.on('close', () => { clearInterval(heartbeat); rt.clients.delete(res); });
});
accountRouter.post('/connect', async (req, res) => {
  if (req.body?.restart === true) await req.runtime.stop();
  void req.runtime.connect().catch(() => req.runtime.stop('blocked'));
  res.status(202).json({ ok: true });
});
accountRouter.post('/logout', async (req, res) => { await req.runtime.reset(); res.json({ ok: true }); });
accountRouter.post('/messages', async (req, res) => {
  const { text, phone, jid: selectedJid } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new AppError(400, '消息需要 1–4096 个字符');
  let jid;
  if (selectedJid) {
    if (typeof selectedJid !== 'string' || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(selectedJid) || !store.messages(req.account.id).some(m => m.jid === selectedJid)) throw new AppError(400, '请选择当前号码下的会话');
    jid = selectedJid;
  } else { try { jid = recipientJid(phone); } catch (error) { throw new AppError(400, error.message); } }
  req.runtime.requireConnected();
  const id = await req.runtime.sendText(jid, text.trim());
  req.runtime.remember({ id, jid, name: jid, text: text.trim(), outgoing: true, time: Date.now() });
  res.json({ ok: true, id });
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
    if (!store.allowed(req.account)) throw new AppError(403, '订阅权限已变更');
    rt.config = config; rt.automation.configure(config); rt.broadcast(); res.json({ ok: true });
  } finally { rt.savingFlows = false; }
});
app.use('/api/accounts/:id', accountRouter);
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof AppError ? error.status : [400, 404, 413].includes(error.status) ? error.status : 500;
  res.status(status).json({ error: status === 500 ? '操作失败，请检查服务存储及连接' : status === 413 ? '文件或配置超过大小限制' : status === 404 ? '资源不存在' : error.message });
});
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', error => {
  if (error) { console.error(`Unable to start server: ${error.code || 'listen failed'}`); process.exit(1); }
  console.log(`BLUE-v listening on port ${server.address().port}`);
  if (process.env.AUTO_CONNECT === 'true') {
    for (const user of store.users()) if (user.active) {
      for (const account of store.accounts(user.id)) if (store.allowed(account)) {
        void access(path.join(dataDir, 'tenants', user.id, account.id, 'wajs-session.json')).then(() => runtime(account)).then(rt => rt.connect()).catch(() => {});
      }
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
