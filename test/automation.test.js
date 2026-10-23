import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Automation, automationError, renderReplyText, validateFlows, loadFlows, saveFlows } from '../automation.js';
import { normalizeWaMessage } from '../messages.js';
import { sendFlow } from '../flow-sender.js';
const config = () => ({ enabled: true, mode: 'numbered', triggerMode: 'keywords', nodes: [
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
test('buttons require a previously sent menu; unrelated quotes and stale reply events do not advance', async () => {
  const sent = [];
  const engine = new Automation(config(), async (jid, node) => { sent.push(node.id); return 'prompt'; });
  await engine.handle(event('1', '', { selection: 'flow:start:0' }));
  await engine.handle(event('2', 'hi'));
  await engine.handle(event('3', '', { selection: 'flow:start:0', quotedId: 'wrong' }));
  await engine.handle(event('4', '', { selection: 'flow:start:0', quotedId: 'prompt' }));
  assert.deepEqual(sent, ['start', 'product']);
  await engine.handle(event('5', 'hi'));
  assert.equal(sent.length, 2, 'entry keywords must not restart an active branch');
  engine.sessions.get('123456789@s.whatsapp.net').expires = 0;
  await engine.handle(event('6', 'hi'));
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
  assert.equal(calls[0][3], '', 'split image must not repeat the node text as its caption');
  assert.equal(calls[1][2], three.text);
  assert.deepEqual(recorded.map(message => message.text), ['[图片]', three.text]);
  assert.equal(recorded[0].buttons.length, 0); assert.equal(recorded[1].buttons.length, 3);
  assert.deepEqual(calls.map(c => c[0]), ['image', 'text']); assert.deepEqual(calls[0][4], []); assert.equal(calls[1][3].length, 3);
  await assert.rejects(sendFlow({ sendText: async () => { throw new Error('offline'); } }, jid, node, 'buttons'), /offline/);
});

test('any-content trigger starts only the entry and never resets an active branch', async () => {
  const flow = { ...config(), triggerMode: 'any' }; flow.nodes[0].triggers = [];
  const sent = [];
  const engine = new Automation(validateFlows(flow), async (jid, node) => { sent.push(node.id); return 'prompt'; });
  await engine.handle(event('1', '任意问候'));
  await engine.handle(event('2', '无关文字'));
  assert.deepEqual(sent, ['start']);
  await engine.handle(event('3', 'Product'));
  await engine.handle(event('4', '另一句话'));
  assert.deepEqual(sent, ['start', 'product']);
  engine.sessions.get('123456789@s.whatsapp.net').expires = 0;
  await engine.handle(event('5', '[图片]'));
  assert.deepEqual(sent, ['start', 'product', 'start']);
});
test('native-button branches cannot be entered by typed labels, numbers or entry keywords', async () => {
  const flow = { ...config(), mode: 'buttons' }, sent = [];
  const engine = new Automation(validateFlows(flow), async (jid, node) => { sent.push(node.id); return 'prompt'; });
  await engine.handle(event('1', 'Product')); assert.deepEqual(sent, []);
  await engine.handle(event('2', 'Hi'));
  for (const [index, text] of ['Product', '1', 'Hi'].entries()) await engine.handle(event(`text-${index}`, text));
  assert.deepEqual(sent, ['start']);
  await engine.handle(event('3', '', { selection: 'flow:start:0', quotedId: 'prompt' }));
  assert.deepEqual(sent, ['start', 'product']);
});
test('single-entry validation rejects branch triggers and migrates legacy files without rewriting them', async () => {
  const branch = config(); branch.nodes[1].triggers = ['other'];
  assert.throws(() => validateFlows(branch), /只有第一个/);
  const missing = config(); missing.nodes[0].triggers = [];
  assert.throws(() => validateFlows(missing), /入口节点/);
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-entry-'));
  try {
    const file = path.join(dir, 'legacy.json'); const legacy = { ...branch }; delete legacy.triggerMode;
    await saveFlows(file, legacy);
    const loaded = await loadFlows(file);
    assert.deepEqual(loaded.nodes[1].triggers, []); assert.deepEqual(loaded.nodes[0].triggers, ['Hi']);
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).nodes[1].triggers, ['other']);
  } finally { await rm(dir, { recursive: true }); }
});

test('reply variables use recipient identity without mutating templates or confusing LIDs with phones', async () => {
  const text = 'Dear user {full_name}, hello! {phone_number} / {full_name} {unknown}';
  assert.equal(renderReplyText(text, '8613800138000@s.whatsapp.net', { name: 'Rose $&' }), 'Dear user Rose $&, hello! 8613800138000 / Rose $& {unknown}');
  assert.equal(renderReplyText('{full_name} {phone_number}', '999999999999999@lid', { name: 'Rose', phoneNumber: '447700900123' }), 'Rose 447700900123');
  assert.equal(renderReplyText('{full_name} {phone_number}', '999999999999999@lid'), '客户 未知号码');
  assert.equal(renderReplyText('{full_name}', '123456789@s.whatsapp.net', { name: '123456789@s.whatsapp.net' }), '123456789');
  assert.equal(renderReplyText('{full_name}', '123456789@s.whatsapp.net', { name: '{phone_number}' }), '{phone_number}');
  const flow = config(), received = [];
  flow.nodes[0].text = text; flow.nodes[1].text = '{full_name}';
  const engine = new Automation(flow, async (jid, node, mode, contact) => { received.push(renderReplyText(node.text, jid, contact)); return 'prompt'; });
  await engine.handle(event('a', 'hi', { name: 'Alice' }));
  await engine.handle(event('b', 'hi', { jid: '987654321@s.whatsapp.net', name: 'Bob' }));
  await engine.handle(event('c', '1'));
  assert.match(received[0], /Alice.*123456789/); assert.match(received[1], /Bob.*987654321/); assert.equal(received[2], 'Alice');
  assert.equal(flow.nodes[0].text, text);
});

test('older menu buttons work after another branch, session expiry and flow edits without mixing customers', async () => {
  const flow = { ...config(), mode: 'buttons' };
  flow.nodes.push({ id: 'other', name: 'Other', text: 'Other reply', triggers: [], image: '', options: [] });
  flow.nodes[0].options.push({ label: 'Other', next: 'other' });
  const sent = [], engine = new Automation(flow, async (jid, node) => { sent.push(node.id); return `menu-${sent.length}`; });
  await engine.handle(event('1', 'hi'));
  await engine.handle(event('2', '', { selection: 'flow:start:0', quotedId: 'menu-1' }));
  assert.deepEqual(sent, ['start', 'product']);
  await engine.handle(event('3', '', { selection: 'flow:start:1', quotedId: 'menu-1' }));
  assert.deepEqual(sent, ['start', 'product', 'other']);
  engine.sessions.get('123456789@s.whatsapp.net').expires = 0;
  flow.nodes[0].options[0].next = 'other';
  await engine.handle(event('4', '', { selection: 'flow:start:0', quotedId: 'menu-1' }));
  assert.equal(sent.at(-1), 'product', 'route using the original sent option, not a reordered current menu');
  await engine.handle(event('5', '', { selection: 'flow:start:1', quotedId: 'menu-1', jid: '987654321@s.whatsapp.net' }));
  await engine.handle(event('6', '', { selection: 'flow:start:1', quotedId: 'foreign-message' }));
  assert.equal(sent.length, 4);
  await engine.handle(event('7', '', { selection: 'flow:start:1' }));
  assert.equal(sent.at(-1), 'other', 'clients without quote IDs can use this customer’s previously sent menu');
  await engine.handle(event('7', '', { selection: 'flow:start:1' })); assert.equal(sent.length, 5, 'delivery duplicates remain ignored');
});

test('any-content entry with an image and three language buttons sends its text only once', async () => {
  const flow = { ...config(), triggerMode: 'any', mode: 'buttons' };
  flow.nodes[0].triggers = [];
  flow.nodes[0].text = 'Please select your language\n请选择您的语言\n請選擇您的語言';
  flow.nodes[0].options = ['English', '简体中文', '繁体中文'].map(label => ({ label, next: 'product' }));
  const calls = [], client = {
    sendImage: async (jid, image, caption, buttons) => { calls.push({ type: 'image', caption, buttons }); return 'entry-image'; },
    sendText: async (jid, text, buttons) => { calls.push({ type: 'text', text, buttons }); return `text-${calls.length}`; }
  };
  const engine = new Automation(validateFlows(flow), (jid, node, mode) => sendFlow(client, jid, node, mode, node.id === 'start' ? Buffer.from([255,216,255,0]) : undefined));
  await engine.handle(event('entry-input', '任意内容'));
  await engine.handle(event('entry-input', '任意内容'));
  await engine.handle(event('other-input', '其他内容'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].caption, '');
  assert.equal(calls[1].text, flow.nodes[0].text);
  assert.equal(calls[1].buttons.length, 3);
  await engine.handle(event('language-click', '', { selection: 'flow:start:2', quotedId: 'text-2' }));
  assert.equal(calls.at(-1).text, 'Description');
});

test('automation failures expose actionable safe diagnostics without leaking raw errors', () => {
  assert.match(automationError({ code: 'ENOENT', message: '/private/data/image' }), /重新上传/);
  assert.match(automationError(new Error('Protocol timeout')) , /超时/);
  assert.match(automationError({ status: 403 }), /订阅/);
  assert.match(automationError({ status: 409 }), /连接/);
  assert.doesNotMatch(automationError(new Error('secret token')), /secret/);
});
