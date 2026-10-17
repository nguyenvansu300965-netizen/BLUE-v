import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activationHash } from '../activation-codes.js';
export { activationHash } from '../activation-codes.js';

export function generateCodes(count) {
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('生成数量需要1–100000的整数');
  const batchId = randomUUID(), codes = new Set();
  while (codes.size < count) codes.add(`BLUE-${randomBytes(20).toString('hex').toUpperCase().match(/.{8}/g).join('-')}`);
  return { batchId, codes: [...codes] };
}
export async function exportCodes(count, directory) {
  const { batchId, codes } = generateCodes(count), createdAt = new Date().toISOString();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const csv = path.join(directory, `${batchId}.csv`), manifest = path.join(directory, `${batchId}.json`);
  await writeFile(csv, '\uFEFF序号,激活码\n' + codes.map((code, i) => `${i + 1},${code}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(manifest, JSON.stringify({ batchId, createdAt, hashes: codes.map(activationHash) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { batchId, count: codes.length, csv, manifest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const count = Number(process.argv[2] || 1000), directory = process.argv[3];
  if (!directory) throw new Error('用法: node scripts/generate-activation-codes.mjs [数量] <导出目录>');
  console.log(JSON.stringify(await exportCodes(count, path.resolve(directory))));
}
