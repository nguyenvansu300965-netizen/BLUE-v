import { menuText } from './automation.js';

export function imageDataUrl(image) {
  const type = image[0] === 255 && image[1] === 216 ? 'image/jpeg' : image.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
  return `data:${type};base64,${image.toString('base64')}`;
}
export async function sendFlow(client, jid, node, mode, image) {
  const buttons = mode === 'buttons' ? node.options.map((o, i) => ({ id: `flow:${node.id}:${i}`, text: o.label })) : [];
  // The currently pinned WA-JS release accepts at most two buttons on media.
  // For three choices, send the image first and a separate three-button menu.
  if (image) {
    const split = buttons.length > 2;
    const id = await client.sendImage(jid, imageDataUrl(image), split ? node.text : menuText(node), split ? [] : buttons);
    if (!split) return id;
  }
  return client.sendText(jid, menuText(node), buttons);
}
