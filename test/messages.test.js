import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientJid, messageText } from '../messages.js';
test('normalizes international numbers and rejects invalid destinations', () => {
  assert.equal(recipientJid('+86 138-0013-8000'), '8613800138000@s.whatsapp.net');
  for (const input of ['', '123', 'abc', '0123456789', '1234567890123456', '1234567@g.us']) assert.throws(() => recipientJid(input));
});
test('extracts plain, extended and ephemeral text without dropping media captions', () => {
  assert.equal(messageText({ conversation: 'hello' }), 'hello');
  assert.equal(messageText({ ephemeralMessage: { message: { extendedTextMessage: { text: 'reply' } } } }), 'reply');
  assert.equal(messageText({ imageMessage: { caption: 'photo' } }), 'photo');
  assert.equal(messageText(undefined), '');
});
