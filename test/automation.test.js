import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Automation, validateFlows, loadFlows, saveFlows } from '../automation.js';
import { normalizeWaMessage } from '../messages.js';
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
test('sends WA-JS text/image buttons, splitting three-button media and propagating failures', async () => {
  const calls = [];
  const client = { sendText: async (...args) => { calls.push(['text', ...args]); return 'text-id'; }, sendImage: async (...args) => { calls.push(['image', ...args]); return 'image-id'; } };
  const node = config().nodes[0];
  const jid = '987654321@s.whatsapp.net';
  const image = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.equal(await sendFlow(client, jid, node, 'numbered', image), 'image-id');
  assert.match(calls[0][2], /^data:image\/png;base64,/); assert.match(calls[0][3], /1\. Product/); assert.deepEqual(calls[0][4], []);
  calls.length = 0;
  assert.equal(await sendFlow(client, jid, node, 'buttons'), 'text-id');
  assert.deepEqual(calls[0][3], [{ id: 'flow:start:0', text: 'Product' }]);
  calls.length = 0;
  await sendFlow(client, jid, node, 'buttons', image);
  assert.equal(calls[0][0], 'image'); assert.equal(calls[0][4][0].id, 'flow:start:0');
  calls.length = 0;
  const three = { ...node, options: Array.from({ length: 3 }, (_, i) => ({ label: `Choice ${i}`, next: 'product' })) };
  const recorded = [];
  assert.equal(await sendFlow(client, jid, three, 'buttons', image, item => recorded.push(item)), 'text-id');
  assert.deepEqual(recorded.map(m => m.image), [true, false]);
  assert.equal(recorded[0].buttons.length, 0); assert.equal(recorded[1].buttons.length, 3);
  assert.deepEqual(calls.map(c => c[0]), ['image', 'text']); assert.deepEqual(calls[0][4], []); assert.equal(calls[1][3].length, 3);
  await assert.rejects(sendFlow({ sendText: async () => { throw new Error('offline'); } }, jid, node, 'buttons'), /offline/);
});
