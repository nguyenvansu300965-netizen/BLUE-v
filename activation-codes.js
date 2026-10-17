import { createHash } from 'node:crypto';
export function activationHash(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^BLUE-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/.test(normalized)) return null;
  return createHash('sha256').update(normalized).digest('hex');
}
export function validateBatch(batch) {
  if (!batch || typeof batch.batchId !== 'string' || !/^[0-9a-f-]{36}$/.test(batch.batchId) || !Number.isFinite(Date.parse(batch.createdAt)) || !Array.isArray(batch.hashes) || !batch.hashes.length || batch.hashes.length > 100000 || batch.hashes.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) || new Set(batch.hashes).size !== batch.hashes.length) throw new Error('激活码批次文件无效');
  return createHash('sha256').update([...batch.hashes].sort().join('\n')).digest('hex');
}
