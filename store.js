import { displayMessage, isImageEncoding } from './messages.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
export const plans = { basic: { name: '基础套餐', limit: 1 }, pro: { name: '高级套餐', limit: 5 }, vip: { name: 'VIP 套餐', limit: 10 } };
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new AppError(status, message); };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) fail(400, '密码需要 6–128 个字符');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password, hash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, value] = hash.split(':');
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(value, 'hex'));
}
export function entitlement(user, now = Date.now()) {
  const limit = plans[user.plan]?.limit || 0;
  return { active: user.role === 'admin' || Boolean(user.enabled && user.expires_at > now && limit), limit, expiresAt: user.expires_at, plan: user.plan };
}
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'blue-v.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', enabled INTEGER NOT NULL DEFAULT 0, plan TEXT NOT NULL DEFAULT 'basic', expires_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_owner ON accounts(user_id, created_at, id);
      CREATE TABLE IF NOT EXISTS messages (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id,id));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flow_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, jid TEXT NOT NULL, remark TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', read_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,jid));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }
  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  byName(name) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(name); }
  publicUser(user) {
    return { id: user.id, username: user.username, role: user.role, enabled: Boolean(user.enabled), plan: user.plan, expiresAt: user.expires_at, createdAt: user.created_at, ...entitlement(user), accountCount: this.accounts(user.id).length };
  }
  async createUser(username, password, role = 'user') {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{4,64}$/.test(username)) fail(400, '用户名需要 4–64 位字母、数字、点、横线或 @');
    username = username.toLowerCase();
    if (this.byName(username)) fail(409, '用户名已被注册');
    const hash = await passwordHash(password);
    const id = randomUUID();
    try {
      this.db.prepare('INSERT INTO users(id,username,password_hash,role,enabled,plan,created_at) VALUES(?,?,?,?,?,?,?)').run(id, username, hash, role, role === 'admin' ? 1 : 0, role === 'admin' ? 'vip' : 'basic', Date.now());
    } catch (error) { if (this.byName(username)) fail(409, '用户名已被注册'); throw error; }
    return this.user(id);
  }
  async bootstrap(username, password) {
    if (this.db.prepare("SELECT id FROM users WHERE role='admin'").get()) return;
    if (!username || !password) throw new Error('First startup requires ADMIN_USER and ADMIN_PASSWORD (6+ characters)');
    await this.createUser(username, password, 'admin');
  }
  async login(username, password) {
    const user = typeof username === 'string' ? this.byName(username.toLowerCase()) : undefined;
    // Keep the expensive password operation on unknown accounts too.
    const placeholder = '00000000000000000000000000000000:' + '00'.repeat(64);
    if (!await passwordMatches(password, user?.password_hash || placeholder) || !user) fail(401, '用户名或密码错误');
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 7 * 86400000;
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), user.id, expires);
    return { token, expires, user };
  }
  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?').get(tokenHash(token), Date.now());
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(token)); }
  users() { return this.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(u => this.publicUser(u)); }
  grant(actor, id, grant) {
    const user = this.user(id);
    if (!user) fail(404, '用户不存在');
    if (user.role === 'admin') fail(400, '不能修改超级管理员的订阅');
    if (!grant || typeof grant.enabled !== 'boolean' || !plans[grant.plan]) fail(400, '请选择有效套餐和使用权限');
    const expires = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
    if ((grant.enabled && (!Number.isFinite(expires) || expires <= Date.now())) || (expires !== null && !Number.isFinite(expires))) fail(400, '开通订阅需要设置未来的到期时间');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET enabled=?,plan=?,expires_at=? WHERE id=?').run(grant.enabled ? 1 : 0, grant.plan, expires, id);
      this.db.prepare('INSERT INTO audit(actor,target,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, id, 'subscription', JSON.stringify({ enabled: grant.enabled, plan: grant.plan, expiresAt: expires }), Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.publicUser(this.user(id));
  }
  async changePassword(actor, id, password, reset = false) {
    if (this.user(actor)?.role !== 'admin') fail(403, '仅超级管理员可修改密码');
    if (!this.user(id)) fail(404, '用户不存在');
    const hash = await passwordHash(password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      this.db.prepare('INSERT INTO audit(actor,target,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, id, reset ? 'password_reset' : 'password_change', '{}', Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  attachment(account, id) { return typeof id === 'string' ? this.db.prepare('SELECT id,name,mime,type,size FROM attachments WHERE account_id=? AND id=?').get(account, id) : undefined; }
  addAttachment(account, item) { this.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(item.id, account, item.name, item.mime, item.type, item.size); }
  accounts(userId) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY created_at,id').all(userId); }
  account(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id); }
  allowed(account) {
    const user = this.user(account.user_id);
    if (!user || !entitlement(user).active) return false;
    return this.accounts(user.id).slice(0, entitlement(user).limit).some(a => a.id === account.id);
  }
  createAccount(userId, label) {
    if (typeof label !== 'string' || !label.trim() || label.length > 60) fail(400, '号码备注需要 1–60 个字符');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.user(userId);
      const access = entitlement(user);
      if (!access.active) fail(403, '订阅未开通或已到期，请联系管理员');
      if (this.accounts(userId).length >= access.limit) fail(409, `当前套餐最多可添加 ${access.limit} 个号码`);
      const id = randomUUID();
      const previous = this.accounts(userId).at(-1);
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?)').run(id, userId, label.trim(), Math.max(Date.now(), (previous?.created_at || 0) + 1));
      this.db.exec('COMMIT');
      return this.account(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteAccount(id) { this.db.prepare('DELETE FROM accounts WHERE id=?').run(id); }
  messages(id) { return this.db.prepare('SELECT payload FROM messages WHERE account_id=? ORDER BY created_at,rowid').all(id).map(m => displayMessage(JSON.parse(m.payload))); }
  contacts(account) { return this.db.prepare('SELECT jid,remark,name,phone,read_at AS readAt FROM contacts WHERE account_id=?').all(account); }
  updateContact(account, jid, fields) {
    this.db.prepare('INSERT OR IGNORE INTO contacts(account_id,jid) VALUES(?,?)').run(account, jid);
    if (fields.remark !== undefined) this.db.prepare('UPDATE contacts SET remark=? WHERE account_id=? AND jid=?').run(fields.remark, account, jid);
    if (fields.readAt !== undefined) this.db.prepare('UPDATE contacts SET read_at=MAX(read_at,?) WHERE account_id=? AND jid=?').run(fields.readAt, account, jid);
    if (fields.name) this.db.prepare('UPDATE contacts SET name=? WHERE account_id=? AND jid=?').run(fields.name, account, jid);
    if (fields.phone) this.db.prepare('UPDATE contacts SET phone=? WHERE account_id=? AND jid=?').run(fields.phone, account, jid);
    return this.contacts(account).find(contact => contact.jid === jid);
  }
  revokeMessage(account, id) {
    const row = this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND id=?').get(account, id);
    if (!row) return false;
    const old = JSON.parse(row.payload);
    const message = { id: old.id, jid: old.jid, name: old.name, outgoing: old.outgoing, time: old.time, text: '此消息已撤回', revoked: true };
    this.db.prepare('UPDATE messages SET payload=? WHERE account_id=? AND id=?').run(JSON.stringify(message), account, id);
    return message;
  }
  setMessageAttachment(account, id, attachment) {
    const row = this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND id=?').get(account, id);
    if (!row) return false;
    const old = JSON.parse(row.payload);
    if (old.revoked) return false;
    const message = { ...old, attachment };
    this.db.prepare('UPDATE messages SET payload=? WHERE account_id=? AND id=?').run(JSON.stringify(message), account, id);
    return message;
  }
  flowMenu(account, jid, nodeId, quotedId, nodes) {
    const current = nodes.find(node => node.id === nodeId);
    for (const message of this.messages(account).reverse()) {
      if (message.jid !== jid || !message.outgoing || !message.automatic || !message.buttons?.length || (quotedId && message.id !== quotedId)) continue;
      if (message.flow?.nodeId === nodeId) return message.flow;
      // Before menu snapshots were recorded, only reuse a menu whose complete labels still match.
      if (!message.flow && current && message.buttons.length === current.options.length && message.buttons.every((button, index) => button.label === current.options[index].label)) return { nodeId, options: current.options };
    }
    return null;
  }
  remember(account, item) {
    const result = this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(account, item.id, JSON.stringify(item), item.time);
    if (!result.changes) {
      const previous = JSON.parse(this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND id=?').get(account, item.id).payload);
      if (previous.revoked) return false;
      const repair = isImageEncoding(previous.text) || (['[图片]', '[非文本消息]'].includes(previous.text) && item.text !== previous.text && !isImageEncoding(item.text));
      const mediaRepair = item.media && !previous.media && !previous.image && !previous.attachment;
      if (((item.automatic || item.manual) && item.outgoing) || repair || mediaRepair) {
        const merged = JSON.stringify(mediaRepair && !repair && !item.automatic && !item.manual ? { ...previous, media: item.media, ...(item.thumbnail && !previous.thumbnail ? { thumbnail: item.thumbnail } : {}) } : { ...previous, ...item });
        if (merged !== JSON.stringify(previous)) {
          this.db.prepare('UPDATE messages SET payload=? WHERE account_id=? AND id=?').run(merged, account, item.id);
          return true;
        }
      }
    }
    this.db.prepare('DELETE FROM messages WHERE account_id=? AND rowid NOT IN (SELECT rowid FROM messages WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500)').run(account, account);
    return result.changes > 0;
  }
  audit() { return this.db.prepare('SELECT audit.*, users.username AS target_name FROM audit LEFT JOIN users ON users.id=audit.target ORDER BY audit.id DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}
