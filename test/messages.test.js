import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientJid, normalizeWaMessage, stanzaId, toWaJid } from '../messages.js';
test('normalizes international numbers and rejects invalid destinations', () => {
  assert.equal(recipientJid('+86 138-0013-8000'), '8613800138000@s.whatsapp.net');
  for (const input of ['', '123', 'abc', '0123456789', '1234567890123456', '1234567@g.us']) assert.throws(() => recipientJid(input));
  assert.equal(toWaJid('8613800138000@s.whatsapp.net'), '8613800138000@c.us');
  assert.equal(toWaJid('123@lid'), '123@lid');
});
test('normalizes WA-JS message keys and native button responses including history while excluding status', () => {
  const raw = { id: 'false_123456789@c.us_MESSAGE', chatId: '123456789@c.us', timestamp: 123, body: 'hi', fromMe: false };
  const message = normalizeWaMessage(raw);
  assert.equal(message.id, 'MESSAGE'); assert.equal(message.jid, '123456789@s.whatsapp.net'); assert.equal(message.time, 123000);
  const reply = normalizeWaMessage({ ...raw, type: 'native_flow_response', body: '{"id":"flow:start:0"}', quotedId: 'true_123456789@c.us_PROMPT' });
  assert.equal(reply.selection, 'flow:start:0'); assert.equal(reply.quotedId, 'PROMPT');
  assert.equal(normalizeWaMessage({ ...raw, selectedButtonId: 'flow:start:1' }).selection, 'flow:start:1');
  assert.equal(normalizeWaMessage({ ...raw, history: true }).history, true);
  assert.equal(normalizeWaMessage({ ...raw, chatId: 'status@broadcast' }), null);
  assert.equal(normalizeWaMessage({ ...raw, type: 'ciphertext' }), null);
  assert.equal(stanzaId({ id: 'PLAIN' }), 'PLAIN');
  assert.equal(normalizeWaMessage({ ...raw, body: '', caption: 'Photo caption' }).text, 'Photo caption');
});

test('image and interactive echoes show captions/previews instead of base64 bodies', () => {
  const base64 = '/9j/' + 'A'.repeat(200);
  const raw = { id: 'IMAGE', chatId: '123456789@c.us', type: 'interactive', body: base64, caption: '产品介绍', timestamp: 123, hasMediaAttachment: true, buttons: [{ label: '了解更多' }] };
  const item = normalizeWaMessage(raw);
  assert.equal(item.text, '产品介绍'); assert.match(item.thumbnail, /^data:image\/jpeg;base64,/); assert.equal(item.buttons[0].label, '了解更多');
  assert.equal(normalizeWaMessage({ ...raw, caption: base64 }).text, '[图片]');
  assert.equal(normalizeWaMessage({ ...raw, body: '/9j/' + 'A'.repeat(300000) }).thumbnail, undefined);
  assert.equal(normalizeWaMessage({ ...raw, type: 'chat', body: '正常文字', caption: '' }).text, '正常文字');
});

test('incoming media retain download identity and readable type labels', () => {
  const raw = { id: 'false_123456789@c.us_MEDIA', chatId: '123456789@c.us', timestamp: 123, body: '', mime: 'audio/ogg; codecs=opus', filename: 'voice.ogg', size: 2048 };
  for (const [type, label] of [['ptt','[语音]'],['audio','[音频]'],['video','[视频]'],['document','[文件]'],['sticker','[贴图]'],['image','[图片]']]) {
    const message = normalizeWaMessage({ ...raw, type });
    assert.equal(message.text, label); assert.equal(message.media.type, type); assert.equal(message.media.sourceId, 'false_123456789@c.us_MEDIA'); assert.equal(message.media.size, 2048);
  }
  assert.equal(normalizeWaMessage({ ...raw, type: 'image', caption: '客户截图' }).text, '客户截图');
});
