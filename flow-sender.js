import { generateWAMessageFromContent, prepareWAMessageMedia, proto } from '@whiskeysockets/baileys';
import { menuText } from './automation.js';

export async function sendFlow(socket, jid, node, mode, image) {
  const text = menuText(node);
  if (mode === 'buttons' && node.options.length) {
    const media = image ? await prepareWAMessageMedia({ image }, { upload: socket.waUploadToServer }) : {};
    const message = generateWAMessageFromContent(jid, {
      viewOnceMessage: { message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: { text },
          header: { hasMediaAttachment: Boolean(image), ...media },
          nativeFlowMessage: { buttons: node.options.map((o, i) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: o.label, id: `flow:${node.id}:${i}` }) })) }
        })
      } }
    }, { userJid: socket.user.id });
    await socket.relayMessage(jid, message.message, { messageId: message.key.id });
    return message.key.id;
  }
  const message = await socket.sendMessage(jid, image ? { image, caption: text } : { text });
  return message.key.id;
}
