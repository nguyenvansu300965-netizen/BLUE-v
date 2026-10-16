export function recipientJid(value) {
  const phone = String(value ?? '').replace(/[\s()+-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) throw new Error('请输入含国家区号的手机号（7–15 位数字）');
  return `${phone}@s.whatsapp.net`;
}

export function messageText(message) {
  const content = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message;
  return content?.conversation ?? content?.extendedTextMessage?.text ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? (content ? '[非文本消息]' : '');
}

export function messageSelection(message) {
  const content = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message;
  const response = content?.interactiveResponseMessage;
  let params;
  try { params = JSON.parse(response?.nativeFlowResponseMessage?.paramsJson || '{}'); } catch { params = {}; }
  return {
    selection: params.id || content?.buttonsResponseMessage?.selectedButtonId || content?.listResponseMessage?.singleSelectReply?.selectedRowId,
    quotedId: response?.contextInfo?.stanzaId || content?.buttonsResponseMessage?.contextInfo?.stanzaId,
    label: response?.body?.text || content?.buttonsResponseMessage?.selectedDisplayText || content?.listResponseMessage?.title
  };
}
