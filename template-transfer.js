import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateFlows } from './automation.js';

export const MAX_PACKAGE = 16 * 1024 * 1024;
export const MAX_CODE = 22 * 1024 * 1024;
const prefix = 'BLUEFLOW1.';
function imageType(data) {
  return data.length >= 12 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : data.length >= 12 && data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpg' : data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
}
export async function exportTemplate(item, mediaDir) {
  const config = validateFlows(item.config), images = {};
  let total = 0;
  for (const name of new Set(config.nodes.map(n => n.image).filter(Boolean))) {
    const data = await readFile(path.join(mediaDir, name)); total += data.length;
    if (data.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024 || imageType(data) !== name.split('.').pop()) throw new Error('示例图片无效或总图片超过10MB');
    images[name] = data.toString('base64');
  }
  const payload = Buffer.from(JSON.stringify({ kind: 'blue-v-template', version: 1, name: item.name, config, images }));
  if (payload.length > MAX_PACKAGE) throw new Error('示例包超过16MB');
  return prefix + gzipSync(payload).toString('base64url');
}
export function importTemplate(code) {
  if (typeof code !== 'string' || code.length > MAX_CODE) throw new Error('复制码过大，最大22MB');
  code = code.trim();
  if (!code.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(code.slice(prefix.length))) throw new Error('复制码格式无效，请使用BLUEFLOW1示例复制码');
  let payload;
  try { payload = JSON.parse(gunzipSync(Buffer.from(code.slice(prefix.length), 'base64url'), { maxOutputLength: MAX_PACKAGE }).toString('utf8')); }
  catch { throw new Error('复制码损坏或解压后超过16MB，请重新导出'); }
  if (payload.kind !== 'blue-v-template' || payload.version !== 1 || typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80 || !payload.images || typeof payload.images !== 'object' || Array.isArray(payload.images)) throw new Error('示例包内容或版本无效');
  const config = validateFlows(payload.config), names = new Set(config.nodes.map(n => n.image).filter(Boolean)), images = new Map();
  if (Object.keys(payload.images).length !== names.size) throw new Error('图片资源数量不一致');
  let total = 0;
  for (const name of names) {
    const encoded = payload.images[name];
    if (typeof encoded !== 'string' || encoded.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('示例图片缺失或无效');
    const data = Buffer.from(encoded, 'base64'); total += data.length;
    if (data.toString('base64') !== encoded || data.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024 || imageType(data) !== name.split('.').pop()) throw new Error('示例图片无效或总图片超过10MB');
    images.set(name, data);
  }
  return { name: payload.name.trim(), config: { ...config, enabled: false }, images };
}
