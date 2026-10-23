import { AppError } from './store.js';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const quickReplyMediaDir = (dataDir, user) => path.join(dataDir, 'quick-replies', user);

export async function migrateQuickReplies(store, dataDir, report = detail => console.error(JSON.stringify(detail))) {
  const rows = store.db.prepare('SELECT q.*,a.user_id,a.storage_owner_id FROM quick_replies q JOIN accounts a ON a.id=q.account_id').all();
  for (const row of rows) {
    let assetId = null;
    try {
      if (row.attachment_id) {
        const asset = store.attachment(row.account_id, row.attachment_id);
        if (!asset || !/^[a-f0-9]{32}$/.test(asset.id)) throw Error('LEGACY_ASSET_MISSING');
        assetId = createHash('sha256').update(`${row.user_id}:${asset.id}`).digest('hex').slice(0, 32);
        const dir = quickReplyMediaDir(dataDir, row.user_id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await copyFile(path.join(dataDir, 'tenants', row.storage_owner_id || row.user_id, row.account_id, 'media', `${asset.id}.bin`), path.join(dir, `${assetId}.bin`));
        if (!store.quickReplyAsset(row.user_id, assetId)) store.addQuickReplyAsset(row.user_id, { ...asset, id: assetId });
      }
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.prepare('INSERT OR IGNORE INTO user_quick_replies VALUES(?,?,?,?,?)').run(row.id, row.user_id, row.title, row.text, assetId);
        store.db.prepare('DELETE FROM quick_replies WHERE id=?').run(row.id);
        store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    } catch { report({ event: 'quick_reply_migration_failed', accountId: row.account_id, replyId: row.id }); }
  }
}

export async function materializeQuickReplyAsset(store, user, account, asset, mediaDir, dataDir) {
  if (!store.canAccess(user, { id: account }) || !store.quickReplyAsset(user, asset.id)) throw new AppError(403, '快捷回复附件或号码不属于当前用户');
  const existing = store.db.prepare('SELECT attachment_id FROM quick_reply_copies WHERE asset_id=? AND account_id=?').get(asset.id, account);
  if (existing) return store.attachment(account, existing.attachment_id);
  const item = { id: randomBytes(16).toString('hex'), name: asset.name, mime: asset.mime, type: asset.type, size: asset.size };
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const file = path.join(mediaDir, `${item.id}.bin`);
  await copyFile(path.join(quickReplyMediaDir(dataDir, user), `${asset.id}.bin`), file);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const raced = store.db.prepare('SELECT attachment_id FROM quick_reply_copies WHERE asset_id=? AND account_id=?').get(asset.id, account);
    if (raced) { store.db.exec('COMMIT'); await rm(file, { force: true }).catch(() => {}); return store.attachment(account, raced.attachment_id); }
    store.addAttachment(account, item);
    store.db.prepare('INSERT INTO quick_reply_copies VALUES(?,?,?)').run(asset.id, account, item.id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); await rm(file, { force: true }); throw error; }
  return item;
}
