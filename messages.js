export function recipientJid(value) {
  const phone = String(value ?? '').replace(/[\s()+-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error('请输入含国家区号的手机号（7–15 位数字）');
  return `${phone}@s.whatsapp.net`;
}

// Keep existing database conversation IDs while translating at the WA-JS boundary.
export const toWaJid = jid => jid.replace(/@s\.whatsapp\.net$/, '@c.us');
export const toStoredJid = jid => jid.replace(/@c\.us$/, '@s.whatsapp.net');
export function stanzaId(value) {
  if (!value) return undefined;
  if (typeof value === 'object') return stanzaId(value.id || value._serialized);
  if (typeof value !== 'string') return undefined;
  return /^(true|false)_[^_]+_/.test(value) ? value.split('_')[2] : value;
}
export function normalizeWaMessage(raw) {
  if (!raw || typeof raw.chatId !== 'string') return null;
  const id = stanzaId(raw.id), jid = toStoredJid(raw.chatId);
  if (!id || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(jid) || raw.history) return null;
  let params = {};
  if (raw.type === 'native_flow_response') {
    try { params = JSON.parse(raw.nativeFlowParams || raw.body || '{}'); } catch { /* Some clients expose the selection as a plain field. */ }
  }
  const selection = raw.selectedButtonId || raw.selectedId || params.id;
  const text = raw.label || params.display_text || (params.id ? '[选项回复]' : raw.body) || raw.caption || (selection ? '[选项回复]' : '[非文本消息]');
  return { id, jid, name: String(raw.name || jid).slice(0, 200), text: String(text).slice(0, 16000), outgoing: Boolean(raw.fromMe), time: Number(raw.timestamp || 0) * 1000,
    selection: typeof selection === 'string' ? selection : undefined, quotedId: stanzaId(raw.quotedId) };
}
