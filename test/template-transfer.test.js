import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { exportTemplate, importTemplate, MAX_PACKAGE } from '../template-transfer.js';
import { defaultTemplates } from '../flow-templates.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9v8AAAAASUVORK5CYII=', 'base64');
const image = '1234567890abcdef1234567890abcdef.png';
const encode = obj => 'BLUEFLOW1.' + gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64url');

test('portable template codes preserve Unicode text, variables, button branches and complete images across directories', async () => {
  const dir = await mkdtemp('/tmp/blue-template-package-');
  try {
    const item = structuredClone(defaultTemplates[0]); item.name = '跨服务器语言菜单'; item.config.enabled = true;
    item.config.nodes[0].image = image; item.config.nodes[1].image = image; item.config.nodes[0].text = 'Dear {full_name}，您好 {phone_number}';
    await writeFile(`${dir}/${image}`, png);
    const code = await exportTemplate(item, dir); assert.match(code, /^BLUEFLOW1\./);
    const result = importTemplate(code);
    assert.equal(result.name, item.name); assert.deepEqual(result.config.nodes, item.config.nodes); assert.equal(result.config.enabled, false);
    assert.equal(result.images.size, 1); assert.deepEqual(result.images.get(image), png);
    assert.equal(code.includes(dir), false);
    const plain = importTemplate(await exportTemplate(defaultTemplates[1], dir)); assert.equal(plain.images.size, 0);
  } finally { await rm(dir, { recursive: true }); }
});

test('portable template imports reject corruption, path traversal, bad graphs, missing images and decompression bombs', () => {
  const payload = { kind: 'blue-v-template', version: 1, name: 'Example', config: structuredClone(defaultTemplates[0].config), images: {} };
  assert.throws(() => importTemplate('not-a-code'), /格式/);
  assert.throws(() => importTemplate('BLUEFLOW1.abc'), /损坏/);
  const pathAttack = structuredClone(payload); pathAttack.config.nodes[0].image = '../../credentials.png'; assert.throws(() => importTemplate(encode(pathAttack)), /图片无效/);
  const graphAttack = structuredClone(payload); graphAttack.config.nodes[0].options[0].next = 'missing'; assert.throws(() => importTemplate(encode(graphAttack)), /不存在/);
  const missing = structuredClone(payload); missing.config.nodes[0].image = image; assert.throws(() => importTemplate(encode(missing)), /资源数量/);
  missing.images[image] = Buffer.from('<html>unsafe</html>').toString('base64'); assert.throws(() => importTemplate(encode(missing)), /图片无效/);
  assert.throws(() => importTemplate('BLUEFLOW1.' + gzipSync(Buffer.alloc(MAX_PACKAGE + 1)).toString('base64url')), /超过16MB/);
});
