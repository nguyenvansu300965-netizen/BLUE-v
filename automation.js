import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const emptyFlows = { enabled: false, mode: 'numbered', nodes: [] };
const norm = value => value.trim().toLocaleLowerCase();
export function validateFlows(input) {
  if (!input || typeof input.enabled !== 'boolean' || !['numbered', 'buttons'].includes(input.mode) || !Array.isArray(input.nodes) || input.nodes.length > 50) throw new Error('流程格式错误，最多支持 50 个节点');
  const ids = new Set();
  const nodes = input.nodes.map(n => {
    if (!n || !/^[a-zA-Z0-9_-]{1,40}$/.test(n.id) || ids.has(n.id)) throw new Error('节点 ID 必须唯一，由字母、数字、横线组成');
    ids.add(n.id);
    if (typeof n.name !== 'string' || !n.name.trim() || n.name.length > 80 || typeof n.text !== 'string' || n.text.length > 3000) throw new Error('请填写节点名称，文案最多 3000 字');
    if (!Array.isArray(n.triggers) || n.triggers.length > 20 || n.triggers.some(t => typeof t !== 'string' || !t.trim() || t.length > 100)) throw new Error('触发词格式错误');
    if (n.image && !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(n.image)) throw new Error('图片无效，请重新上传');
    if (!n.text.trim() && !n.image) throw new Error('每个节点至少需要文案或图片');
    if (!Array.isArray(n.options) || n.options.length > 3) throw new Error('每个节点最多 3 个选项');
    const labels = new Set();
    const options = n.options.map(o => {
      if (!o || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 20 || labels.has(norm(o.label)) || typeof o.next !== 'string') throw new Error('选项名称须唯一，最多 20 字，并选择目标节点');
      labels.add(norm(o.label)); return { label: o.label.trim(), next: o.next };
    });
    return { id: n.id, name: n.name.trim(), text: n.text, image: n.image || '', triggers: n.triggers.map(t => t.trim()), options };
  });
  const triggers = new Set();
  for (const n of nodes) {
    for (const o of n.options) if (!ids.has(o.next)) throw new Error(`节点「${n.name}」的选项指向不存在的节点`);
    for (const t of n.triggers) { if (triggers.has(norm(t))) throw new Error('触发词不能重复'); triggers.add(norm(t)); }
  }
  return { enabled: input.enabled, mode: input.mode, nodes };
}
export async function loadFlows(file) {
  try { return validateFlows(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(emptyFlows); throw error; }
}
export async function saveFlows(file, config) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export function menuText(node) {
  return [node.text, node.options.length ? node.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') + '\n回复序号或选项文字继续' : ''].filter(Boolean).join('\n\n');
}
export class Automation {
  constructor(config, send, report = () => {}) { this.config = config; this.send = send; this.report = report; this.sessions = new Map(); this.seen = new Set(); this.queue = Promise.resolve(); }
  configure(config) { this.config = config; this.sessions.clear(); }
  handle(event) {
    const run = this.queue.then(() => this.process(event));
    this.queue = run.catch(() => {});
    return run;
  }
  async process({ id, jid, fromMe, text, selection, quotedId, time = Date.now() }) {
    if (!this.config.enabled || fromMe || !id || !/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(jid || '') || Date.now() - time > 120000 || this.seen.has(`${jid}:${id}`)) return;
    this.seen.add(`${jid}:${id}`);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
    const session = this.sessions.get(jid);
    let node;
    if (selection) {
      if (!session || session.expires < Date.now()) return;
      const match = /^flow:([^:]+):(\d+)$/.exec(selection);
      if (!match || match[1] !== session.node || (quotedId && quotedId !== session.messageId)) return;
      const prior = this.config.nodes.find(n => n.id === session.node);
      node = this.config.nodes.find(n => n.id === prior?.options[Number(match[2])]?.next);
    } else {
      const input = norm(text || '');
      if (session && session.expires > Date.now()) {
        const prior = this.config.nodes.find(n => n.id === session.node);
        const option = prior?.options.find((o, i) => input === String(i + 1) || input === norm(o.label));
        node = this.config.nodes.find(n => n.id === option?.next);
      }
      node ||= this.config.nodes.find(n => n.triggers.some(t => norm(t) === input));
    }
    if (!node) return;
    try {
      const messageId = await this.send(jid, node, this.config.mode);
      if (this.sessions.size >= 10000) this.sessions.delete(this.sessions.keys().next().value);
      this.sessions.set(jid, { node: node.id, messageId, expires: Date.now() + 30 * 60000 });
      this.report({ ok: true, node: node.name });
    } catch (error) { this.report({ ok: false, node: node.name }); throw error; }
  }
}
