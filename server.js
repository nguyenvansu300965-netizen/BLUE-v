import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recipientJid, messageText, messageSelection } from './messages.js';
import { Automation, loadFlows, validateFlows, saveFlows, menuText } from './automation.js';
import { sendFlow } from './flow-sender.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.resolve(process.env.AUTH_DIR || path.join(root, '.data/auth'));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const mediaDir = path.join(dataDir, 'media');
const flowFile = path.join(dataDir, 'flows.json');
let flowConfig = await loadFlows(flowFile);
let lastAutomation = null;
const logger = pino({ level: 'silent' });
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const app = express();
const clients = new Set();
const messages = [];
let socket, timer, generation = 0, connecting = false;
let state = { status: 'idle', qr: null, user: null, error: null };
const snapshot = () => ({ ...state, messages, automation: { enabled: flowConfig.enabled, last: lastAutomation } });
const automation = new Automation(flowConfig, async (jid, node, mode) => {
  if (!socket || state.status !== 'connected') throw new Error('Disconnected');
  const image = node.image ? await readFile(path.join(mediaDir, node.image)) : undefined;
  const id = await sendFlow(socket, jid, node, mode, image);
  remember({ id, jid, name: jid, text: `${node.image ? '[图片] ' : ''}${menuText(node)}`, outgoing: true, time: Date.now(), automatic: true });
  return id;
}, result => { lastAutomation = { ...result, time: Date.now() }; broadcast(); });
function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(payload);
}
function update(patch) { state = { ...state, ...patch }; broadcast(); }
function remember(item) {
  if (messages.some(m => m.id === item.id)) return;
  messages.push(item);
  if (messages.length > 200) messages.shift();
  broadcast();
}
async function connect() {
  if (connecting || socket) return;
  connecting = true;
  const current = ++generation;
  update({ status: 'connecting', qr: null, error: null });
  try {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    if (current !== generation) return;
    const client = makeWASocket({ auth, logger, agent, fetchAgent: agent, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
    socket = client;
    client.ev.on('creds.update', () => { if (current === generation) saveCreds().catch(() => update({ error: '无法保存登录会话，请检查存储权限' })); });
    client.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (current !== generation) return;
      if (qr) {
        const image = await QRCode.toDataURL(qr);
        if (current === generation && state.status !== 'connected') update({ status: 'qr', qr: image });
      }
      if (connection === 'open') update({ status: 'connected', qr: null, user: client.user, error: null });
      if (connection === 'close') {
        socket = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        update({ status: loggedOut ? 'logged_out' : 'disconnected', qr: null, user: null, error: loggedOut ? '会话已退出，请重置会话后重新扫码' : '连接中断，5 秒后自动重试' });
        if (!loggedOut) timer = setTimeout(() => connect(), 5000);
      }
    });
    client.ev.on('messages.upsert', ({ messages: incoming, type }) => {
      if (current !== generation || type !== 'notify') return;
      for (const msg of incoming) {
        const choice = messageSelection(msg.message);
        const text = choice.label || messageText(msg.message);
        if (!text || !msg.key.id) continue;
        remember({ id: msg.key.id, jid: msg.key.remoteJid, name: msg.pushName || msg.key.remoteJid, text, outgoing: Boolean(msg.key.fromMe), time: Number(msg.messageTimestamp || Date.now() / 1000) * 1000 });
        void automation.handle({ id: msg.key.id, jid: msg.key.remoteJid, fromMe: msg.key.fromMe, text, ...choice, time: Number(msg.messageTimestamp || 0) * 1000 }).catch(() => {});
      }
    });
  } catch (error) {
    if (current === generation) { socket = null; update({ status: 'error', error: '连接失败，请检查网络并重试' }); }
  } finally { if (current === generation) connecting = false; }
}

// This local app has no remote-user authentication. Reject cross-origin mutations.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: '禁止跨域请求' });
  next();
});
app.post('/api/media', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), async (req, res, next) => {
  try {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 12) return res.status(400).json({ error: '请选择 PNG、JPEG 或 WebP 图片（最大 5MB）' });
    const ext = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpg' : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!ext) return res.status(400).json({ error: '图片格式无效' });
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    const id = `${randomBytes(16).toString('hex')}.${ext}`;
    await writeFile(path.join(mediaDir, id), data, { mode: 0o600 });
    res.json({ id });
  } catch (error) { next(error); }
});
app.get('/api/media/:id', (req, res) => {
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(req.params.id)) return res.sendStatus(404);
  res.sendFile(path.join(mediaDir, req.params.id));
});
app.use(express.json({ limit: '256kb' }));
app.get('/api/flows', (req, res) => res.json(flowConfig));
let savingFlows = false;
app.post('/api/flows', async (req, res) => {
  if (savingFlows) return res.status(409).json({ error: '正在保存，请稍后重试' });
  savingFlows = true;
  try {
    const config = validateFlows(req.body);
    for (const node of config.nodes) if (node.image) await access(path.join(mediaDir, node.image));
    await saveFlows(flowFile, config);
    flowConfig = config; automation.configure(config); broadcast();
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.code ? '保存失败，请检查图片是否已上传及存储目录权限' : error.message }); }
  finally { savingFlows = false; }
});
app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
});
app.post('/api/connect', (req, res) => { clearTimeout(timer); void connect(); res.json({ ok: true }); });
app.post('/api/logout', async (req, res, next) => {
  try {
    clearTimeout(timer);
    if (socket && state.status === 'connected') await socket.logout();
    generation++;
    connecting = false;
    socket?.end(undefined); socket = null;
    await rm(authDir, { recursive: true, force: true });
    clearTimeout(timer);
    messages.length = 0;
    automation.sessions.clear();
    update({ status: 'idle', qr: null, user: null, error: null });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post('/api/messages', async (req, res, next) => {
  let jid;
  try { jid = recipientJid(req.body?.phone); } catch (error) { return res.status(400).json({ error: error.message }); }
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) return res.status(400).json({ error: '消息需要 1–4096 个字符' });
  if (!socket || state.status !== 'connected') return res.status(409).json({ error: '请先扫码连接 WhatsApp' });
  try {
    const result = await socket.sendMessage(jid, { text: text.trim() });
    remember({ id: result.key.id, jid, name: jid, text: text.trim(), outgoing: true, time: Date.now() });
    res.json({ ok: true, id: result.key.id });
  } catch (error) { next(error); }
});
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => res.status(error.status === 413 ? 413 : 500).json({ error: error.status === 413 ? '文件或配置超过大小限制' : '操作失败，请检查 WhatsApp 连接后重试' }));
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', error => {
  if (error) { console.error(`Unable to start server: ${error.code || 'listen failed'}`); process.exit(1); }
  console.log(`BLUE-v listening on port ${server.address().port}`);
});
function shutdown() { clearTimeout(timer); generation++; socket?.end(undefined); for (const client of clients) client.end(); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
