import { activationHash, validateBatch } from './activation-codes.js';
import { displayMessage, isImageEncoding, isMessagePlaceholder, receiptAck, mergeReceipt } from './messages.js';
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
  const limit = Number.isInteger(user.number_limit) ? user.number_limit : plans[user.plan]?.limit || 0;
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
      CREATE TABLE IF NOT EXISTS quick_replies (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, title TEXT NOT NULL, text TEXT NOT NULL, attachment_id TEXT);
      CREATE TABLE IF NOT EXISTS quick_reply_assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_quick_replies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, text TEXT NOT NULL, attachment_id TEXT REFERENCES quick_reply_assets(id));
      CREATE TABLE IF NOT EXISTS quick_reply_copies (asset_id TEXT NOT NULL REFERENCES quick_reply_assets(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, PRIMARY KEY(asset_id,account_id));
      CREATE TABLE IF NOT EXISTS flow_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, jid TEXT NOT NULL, remark TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', read_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,jid));
      CREATE TABLE IF NOT EXISTS activation_batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, code_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activation_codes (hash TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES activation_batches(id), redeemed_at INTEGER, redeemed_by TEXT, account_id TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'number_limit')) this.db.exec('ALTER TABLE users ADD COLUMN number_limit INTEGER');
    if (!this.db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'managed')) this.db.exec('ALTER TABLE accounts ADD COLUMN managed INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'storage_owner_id')) this.db.exec('ALTER TABLE accounts ADD COLUMN storage_owner_id TEXT');
    this.db.exec('UPDATE accounts SET storage_owner_id=user_id WHERE storage_owner_id IS NULL');
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
    if (grant.limit !== undefined && (!Number.isInteger(grant.limit) || grant.limit < 0 || grant.limit > 1000)) fail(400, '号码数量需要0–1000的整数');
    const customLimit = grant.limit === undefined ? null : grant.limit;
    const expires = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
    if ((grant.enabled && (!Number.isFinite(expires) || expires <= Date.now())) || (expires !== null && !Number.isFinite(expires))) fail(400, '开通订阅需要设置未来的到期时间');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET enabled=?,plan=?,expires_at=?,number_limit=? WHERE id=?').run(grant.enabled ? 1 : 0, grant.plan, expires, customLimit, id);
      this.db.prepare('INSERT INTO audit(actor,target,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, id, 'subscription', JSON.stringify({ enabled: grant.enabled, plan: grant.plan, limit: customLimit, expiresAt: expires }), Date.now());
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
  quickReplyAsset(user, id) {
    const item = typeof id === 'string' ? this.db.prepare('SELECT id,name,mime,type,size FROM quick_reply_assets WHERE user_id=? AND id=?').get(user, id) : null;
    return item ? { ...item, scope: 'quick-reply' } : null;
  }
  addQuickReplyAsset(user, item) { this.db.prepare('INSERT INTO quick_reply_assets VALUES(?,?,?,?,?,?)').run(item.id, user, item.name, item.mime, item.type, item.size); }
  userQuickReplies(user) {
    return this.db.prepare('SELECT id,title,text,attachment_id FROM user_quick_replies WHERE user_id=? ORDER BY rowid').all(user).map(row => ({ id: row.id, title: row.title, text: row.text, attachment: this.quickReplyAsset(user, row.attachment_id) }));
  }
  saveUserQuickReply(user, id, input) {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80 || typeof input.text !== 'string' || input.text.length > 4096) fail(400, '标题需要 1–80 字，文本最多 4096 字');
    const attachment = input.attachment || null;
    if (attachment && !this.quickReplyAsset(user, attachment)) fail(400, '附件不存在或不属于当前用户');
    if (!input.text.trim() && !attachment) fail(400, '请填写文本或选择媒体');
    if (id && !this.userQuickReplies(user).some(item => item.id === id)) fail(404, '快捷回复不存在');
    if (!id && this.userQuickReplies(user).length >= 1000) fail(400, '每个用户最多保存 1000 条快捷回复');
    const key = id || randomUUID();
    if (id) this.db.prepare('UPDATE user_quick_replies SET title=?,text=?,attachment_id=? WHERE user_id=? AND id=?').run(input.title.trim(), input.text, attachment, user, key);
    else this.db.prepare('INSERT INTO user_quick_replies VALUES(?,?,?,?,?)').run(key, user, input.title.trim(), input.text, attachment);
    return this.userQuickReplies(user).find(item => item.id === key);
  }
  deleteUserQuickReply(user, id) {
    if (!this.db.prepare('DELETE FROM user_quick_replies WHERE user_id=? AND id=?').run(user, id).changes) fail(404, '快捷回复不存在');
  }
  quickReplies(account) {
    return this.db.prepare('SELECT id,title,text,attachment_id FROM quick_replies WHERE account_id=? ORDER BY rowid').all(account).map(row => ({ id: row.id, title: row.title, text: row.text, attachment: this.attachment(account, row.attachment_id) || null }));
  }
  saveQuickReply(account, id, input) {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80 || typeof input.text !== 'string' || input.text.length > 4096) fail(400, '标题需要 1–80 字，文本最多 4096 字');
    const attachment = input.attachment || null;
    if (attachment && !this.attachment(account, attachment)) fail(400, '附件不存在或不属于当前号码');
    if (!input.text.trim() && !attachment) fail(400, '请填写文本或选择媒体');
    if (id && !this.quickReplies(account).some(item => item.id === id)) fail(404, '快捷回复不存在');
    if (!id && this.quickReplies(account).length >= 100) fail(400, '每个号码最多保存 100 条快捷回复');
    const key = id || randomUUID();
    if (id) this.db.prepare('UPDATE quick_replies SET title=?,text=?,attachment_id=? WHERE account_id=? AND id=?').run(input.title.trim(), input.text, attachment, account, key);
    else this.db.prepare('INSERT INTO quick_replies VALUES(?,?,?,?,?)').run(key, account, input.title.trim(), input.text, attachment);
    return this.quickReplies(account).find(item => item.id === key);
  }
  deleteQuickReply(account, id) {
    if (!this.db.prepare('DELETE FROM quick_replies WHERE account_id=? AND id=?').run(account, id).changes) fail(404, '快捷回复不存在');
  }
  attachment(account, id) { return typeof id === 'string' ? this.db.prepare('SELECT id,name,mime,type,size FROM attachments WHERE account_id=? AND id=?').get(account, id) : undefined; }
  addAttachment(account, item) { this.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(item.id, account, item.name, item.mime, item.type, item.size); }
  accounts(userId) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=? AND managed<>1 ORDER BY created_at,id').all(userId); }
  account(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id); }
  allowed(account) {
    account = this.account(account.id);
    if (!account) return false;
    if (account.managed === 1) return true;
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
      this.db.prepare('INSERT INTO accounts(id,user_id,label,created_at,storage_owner_id) VALUES(?,?,?,?,?)').run(id, userId, label.trim(), Math.max(Date.now(), (previous?.created_at || 0) + 1), userId);
      this.db.exec('COMMIT');
      return this.account(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  canAccess(userId, account) { const current = this.account(account.id); return Boolean(current && current.managed !== 1 && current.user_id === userId); }
  managedAccounts() { return this.db.prepare('SELECT * FROM accounts WHERE managed<>0 ORDER BY created_at,id').all(); }
  importActivationBatch(batch) {
    const fingerprint = validateBatch(batch);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT fingerprint FROM activation_batches WHERE id=?').get(batch.batchId);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('同一批次的激活码内容不一致');
      this.db.prepare('INSERT OR IGNORE INTO activation_batches VALUES(?,?,?,?)').run(batch.batchId, batch.createdAt, fingerprint, batch.hashes.length);
      const insert = this.db.prepare('INSERT OR IGNORE INTO activation_codes(hash,batch_id) VALUES(?,?)'); let added = 0;
      for (const hash of batch.hashes) added += Number(insert.run(hash, batch.batchId).changes);
      this.db.exec('COMMIT'); return { batchId: batch.batchId, added, count: batch.hashes.length };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createManaged(actor, label, activationCode) {
    if (this.user(actor)?.role !== 'admin') fail(403, '仅超级管理员可添加号码');
    if (typeof label !== 'string' || !label.trim() || label.length > 60) fail(400, '号码备注需要1–60个字符');
    if (typeof activationCode !== 'string' || !activationCode.trim()) fail(400, '添加新号码必须填写激活码，请联系卖家购买');
    const hash = activationHash(activationCode);
    if (!hash) fail(400, '激活码无效或已使用');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const code = this.db.prepare('SELECT * FROM activation_codes WHERE hash=? AND redeemed_at IS NULL').get(hash);
      if (!code) fail(400, '激活码无效或已使用');
      const id = randomUUID(), now = Date.now();
      const result = this.db.prepare('UPDATE activation_codes SET redeemed_at=?,redeemed_by=?,account_id=? WHERE hash=? AND redeemed_at IS NULL').run(now, actor, id, hash);
      if (result.changes !== 1) fail(409, '激活码已使用');
      this.db.prepare('INSERT INTO accounts(id,user_id,label,created_at,managed,storage_owner_id) VALUES(?,?,?,?,1,?)').run(id, actor, label.trim(), now, actor);
      this.db.prepare('INSERT INTO audit(actor,target,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, actor, 'number_activation', JSON.stringify({ accountId: id, batchId: code.batch_id }), now);
      this.db.exec('COMMIT'); return this.account(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assignAccount(actor, id, target) {
    if (this.user(actor)?.role !== 'admin') fail(403, '仅超级管理员可分配');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const account = this.account(id);
      if (!account || !account.managed) fail(404, '仅可分配管理员新建的托管号码');
      if (target !== null) {
        const user = this.user(target);
        if (!user || user.role === 'admin' || !entitlement(user).active) fail(400, '请选择订阅有效的普通用户');
        if (account.managed !== 2 || account.user_id !== target) if (this.accounts(target).length >= entitlement(user).limit) fail(409, '用户号码额度不足，已有自有号码也计入额度');
      }
      this.db.prepare('UPDATE accounts SET user_id=?,managed=? WHERE id=?').run(target || account.storage_owner_id, target ? 2 : 1, id);
      this.db.prepare('INSERT INTO audit(actor,target,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, target || actor, 'number_assignment', JSON.stringify({ accountId: id, previousUser: account.managed === 2 ? account.user_id : null, userId: target }), Date.now());
      this.db.exec('COMMIT'); return this.account(id);
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
  updateReceipt(account, id, jid, ack) {
    if (receiptAck(ack) === undefined) return false;
    const row = this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND id=?').get(account, id);
    if (!row) return false;
    const message = JSON.parse(row.payload);
    if (!message.outgoing || message.revoked || message.jid !== jid) return false;
    const merged = mergeReceipt(message.ack, ack);
    if (merged === message.ack) return false;
    message.ack = merged;
    this.db.prepare('UPDATE messages SET payload=? WHERE account_id=? AND id=?').run(JSON.stringify(message), account, id);
    return true;
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
    const ackChanged = item.outgoing && this.updateReceipt(account, item.id, item.jid, item.ack);
    const result = this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(account, item.id, JSON.stringify(item), item.time);
    if (!result.changes) {
      const previous = JSON.parse(this.db.prepare('SELECT payload FROM messages WHERE account_id=? AND id=?').get(account, item.id).payload);
      if (previous.revoked) return false;
      if (item.outgoing && previous.ack !== undefined) item = { ...item, ack: mergeReceipt(previous.ack, item.ack) };
      const repair = isImageEncoding(previous.text) || (isMessagePlaceholder(previous.text) && item.text !== previous.text && !isImageEncoding(item.text) && (!isMessagePlaceholder(item.text) || previous.text === '[非文本消息]'));
      const typeRepair = item.messageType && (!previous.messageType || previous.messageType === 'unknown') && item.messageType !== previous.messageType;
      const mediaRepair = item.media && !previous.media && !previous.image && !previous.attachment;
      if (((item.automatic || item.manual) && item.outgoing) || repair || mediaRepair || typeRepair) {
        const merged = JSON.stringify((mediaRepair || typeRepair) && !repair && !item.automatic && !item.manual ? { ...previous, ...(item.messageType ? { messageType: item.messageType } : {}), ...(item.media ? { media: item.media } : {}), ...(item.thumbnail && !previous.thumbnail ? { thumbnail: item.thumbnail } : {}) } : { ...previous, ...item });
        if (merged !== JSON.stringify(previous)) {
          this.db.prepare('UPDATE messages SET payload=? WHERE account_id=? AND id=?').run(merged, account, item.id);
          return true;
        }
      }
    }
    this.db.prepare('DELETE FROM messages WHERE account_id=? AND rowid NOT IN (SELECT rowid FROM messages WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500)').run(account, account);
    return result.changes > 0 || Boolean(ackChanged);
  }
  audit() { return this.db.prepare('SELECT audit.*, users.username AS target_name FROM audit LEFT JOIN users ON users.id=audit.target ORDER BY audit.id DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}
