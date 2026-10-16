import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Automation, validateFlows, loadFlows, saveFlows } from '../automation.js';
import { messageSelection } from '../messages.js';
import { sendFlow } from '../flow-sender.js';
const config = () => ({ enabled: true, mode: 'numbered', nodes: [
  { id: 'start', name: 'Welcome', triggers: ['Hi'], text: 'Choose', image: '', options: [{ label: 'Product', next: 'product' }] },
  { id: 'product', name: 'Product', triggers: [], text: 'Description', image: '', options: [] }
] });
const event = (id, text, extra = {}) => ({ id, text, jid: '123456789@s.whatsapp.net', time: Date.now(), ...extra });
test('matches trigger, tracks each customer, branches by number, ignores own/group/duplicate messages', async () => {
  const sent = [];
  const engine = new Automation(validateFlows(config()), async (jid, node) => { sent.push(node.id); return `sent-${sent.length}`; });
  await engine.handle(event('1', ' hi '));
  await engine.handle(event('1', 'hi'));
  await engine.handle(event('2', '1', { jid: '987654321@s.whatsapp.net' }));
  await engine.handle(event('3', 'hi', { fromMe: true }));
  await engine.handle(event('4', 'hi', { jid: '123@g.us' }));
  await engine.handle(event('5', '1'));
  assert.deepEqual(sent, ['start', 'product']);
  engine.configure({ ...config(), enabled: false });
  await engine.handle(event('6', 'hi')); assert.equal(sent.length, 2);
});
test('buttons require active context, expired sessions and stale messages do not advance', async () => {
  const sent = [];
  const engine = new Automation(config(), async (jid, node) => { sent.push(node.id); return 'prompt'; });
  await engine.handle(event('1', '', { selection: 'flow:start:0' }));
  await engine.handle(event('2', 'hi'));
  await engine.handle(event('3', '', { selection: 'flow:start:0', quotedId: 'wrong' }));
  await engine.handle(event('4', '', { selection: 'flow:start:0', quotedId: 'prompt' }));
  assert.deepEqual(sent, ['start', 'product']);
  await engine.handle(event('5', 'hi'));
  engine.sessions.get('123456789@s.whatsapp.net').expires = 0;
  await engine.handle(event('6', '1'));
  await engine.handle(event('7', 'hi', { time: Date.now() - 180000 }));
  assert.equal(sent.length, 3);
});
test('serializes rapid replies and reports sending failures without advancing session', async () => {
  const sent = [];
  const engine = new Automation(config(), async (jid, node) => { await new Promise(r => setTimeout(r, 5)); sent.push(node.id); return 'id'; });
  await Promise.all([engine.handle(event('1', 'hi')), engine.handle(event('2', 'Product'))]);
  assert.deepEqual(sent, ['start', 'product']);
  const reports = [];
  const broken = new Automation(config(), async () => { throw new Error('network'); }, r => reports.push(r));
  await assert.rejects(broken.handle(event('1', 'hi')));
  assert.equal(broken.sessions.size, 0); assert.equal(reports[0].ok, false);
});
test('validates graph and persists settings across reload', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'blue-flows-'));
  try {
    const file = path.join(folder, 'flows.json');
    assert.equal((await loadFlows(file)).enabled, false);
    await saveFlows(file, validateFlows(config()));
    assert.deepEqual(await loadFlows(file), config());
    const broken = config(); broken.nodes[0].options[0].next = 'missing'; assert.throws(() => validateFlows(broken));
    const duplicate = config(); duplicate.nodes[1].triggers = ['hi']; assert.throws(() => validateFlows(duplicate));
    const image = config(); image.nodes[0].image = '../../secret'; assert.throws(() => validateFlows(image));
  } finally { await rm(folder, { recursive: true }); }
});
test('decodes button response and builds native or image/text replies', async () => {
  assert.equal(messageSelection({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"flow:start:0"}' } } }).selection, 'flow:start:0');
  assert.equal(messageSelection({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{bad' } } }).selection, undefined);
  let content, relayed;
  const socket = { user: { id: '123456789@s.whatsapp.net' }, sendMessage: async (jid, data) => { content = data; return { key: { id: 'text' } }; }, relayMessage: async (jid, message) => { relayed = message; } };
  const node = config().nodes[0];
  await sendFlow(socket, '987654321@s.whatsapp.net', node, 'numbered', Buffer.from('image'));
  assert.ok(Buffer.isBuffer(content.image)); assert.match(content.caption, /1\. Product/);
  await sendFlow(socket, '987654321@s.whatsapp.net', node, 'buttons');
  const button = relayed.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons[0];
  assert.equal(JSON.parse(button.buttonParamsJson).id, 'flow:start:0');
});
