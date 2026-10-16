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
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码需要 12–128 个字符');
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
    if (!username || !password) throw new Error('First startup requires ADMIN_USER and ADMIN_PASSWORD (12+ characters)');
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
  messages(id) { return this.db.prepare('SELECT payload FROM messages WHERE account_id=? ORDER BY created_at,rowid').all(id).map(m => JSON.parse(m.payload)); }
  remember(account, item) {
    const result = this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(account, item.id, JSON.stringify(item), item.time);
    this.db.prepare('DELETE FROM messages WHERE account_id=? AND rowid NOT IN (SELECT rowid FROM messages WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500)').run(account, account);
    return result.changes > 0;
  }
  audit() { return this.db.prepare('SELECT audit.*, users.username AS target_name FROM audit LEFT JOIN users ON users.id=audit.target ORDER BY audit.id DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}
