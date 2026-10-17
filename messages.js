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
export function isImageEncoding(value) {
  return typeof value === 'string' && /^(?:data:image\/(?:jpeg|png|webp);base64,|\/9j\/|iVBORw0KGgo|UklGR)/.test(value) && value.length > 64;
}
export function displayMessage(item) {
  return isImageEncoding(item.text) ? { ...item, text: '[图片]' } : item;
}
function imagePreview(value) {
  if (!isImageEncoding(value) || value.length > 250000 || !/^[A-Za-z0-9+/=,:;.-]+$/.test(value)) return undefined;
  if (value.startsWith('data:image/')) return value;
  const type = value.startsWith('/9j/') ? 'jpeg' : value.startsWith('iVBOR') ? 'png' : 'webp';
  return `data:image/${type};base64,${value}`;
}
export function normalizeWaMessage(raw) {
  if (!raw || typeof raw.chatId !== 'string' || ['ciphertext', 'protocol', 'notification', 'e2e_notification', 'gp2'].includes(raw.type)) return null;
  const id = stanzaId(raw.id), jid = toStoredJid(raw.chatId);
  if (!id || !/^[0-9-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(jid)) return null;
  let params = {};
  if (raw.type === 'native_flow_response') {
    try { const parsed = JSON.parse(raw.nativeFlowParams || raw.body || '{}'); if (parsed && typeof parsed === 'object') params = parsed; } catch { /* Some clients expose the selection as a plain field. */ }
  }
  const selection = raw.selectedButtonId || raw.selectedId || params.id;
  const encoded = isImageEncoding(raw.body);
  const mediaKind = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(raw.type) ? raw.type : raw.mediaType === 'IMAGE' || encoded ? 'image' : null;
  const media = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(raw.type) || raw.hasMediaAttachment || encoded;
  const caption = typeof raw.caption === 'string' && !isImageEncoding(raw.caption) ? raw.caption : '';
  const body = typeof raw.body === 'string' && !encoded ? raw.body : '';
  const text = raw.label || params.display_text || (params.id ? '[选项回复]' : media ? caption || body : body || caption) || (selection ? '[选项回复]' : ({ image: '[图片]', video: '[视频]', audio: '[音频]', ptt: '[语音]', document: '[文件]', sticker: '[贴图]', location: '[位置]', vcard: '[联系人]' }[mediaKind || raw.type] || '[非文本消息]'));
  const thumbnail = imagePreview(raw.thumbnail) || (encoded ? imagePreview(raw.body) : undefined);
  const buttons = Array.isArray(raw.buttons) ? raw.buttons.filter(b => typeof b?.label === 'string').slice(0, 3).map(b => ({ label: b.label.slice(0, 100) })) : [];

  const mediaInfo = mediaKind ? { type: mediaKind, sourceId: typeof raw.sourceId === 'string' && /^(true|false)_[^_]+_.+/.test(raw.sourceId) ? raw.sourceId : `${Boolean(raw.fromMe)}_${raw.chatId}_${id}`, mime: typeof raw.mime === 'string' ? raw.mime.slice(0, 120) : '', name: typeof raw.filename === 'string' ? raw.filename.slice(0, 200) : '', size: Number.isFinite(raw.size) && raw.size > 0 ? raw.size : 0 } : undefined;
  return { id, jid, ...(mediaInfo ? { media: mediaInfo } : {}), name: String(raw.name || jid).slice(0, 200), thumbnail, buttons, text: String(text).slice(0, 16000), outgoing: Boolean(raw.fromMe), history: Boolean(raw.history), time: Number(raw.timestamp || 0) * 1000,
    selection: typeof selection === 'string' ? selection : undefined, quotedId: stanzaId(raw.quotedId) };
}
