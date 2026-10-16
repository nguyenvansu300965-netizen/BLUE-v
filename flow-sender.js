import { menuText } from './automation.js';

export function imageDataUrl(image) {
  const type = image[0] === 255 && image[1] === 216 ? 'image/jpeg' : image.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
  return `data:${type};base64,${image.toString('base64')}`;
}
export async function sendFlow(client, jid, node, mode, image, onSent = () => {}) {
  const buttons = mode === 'buttons' ? node.options.map((o, i) => ({ id: `flow:${node.id}:${i}`, text: o.label })) : [];
  // The currently pinned WA-JS release accepts at most two buttons on media.
  // For three choices, send the image first and a separate three-button menu.
  if (image) {
    const split = buttons.length > 2;
    const caption = split ? node.text : menuText(node, mode), imageButtons = split ? [] : buttons;
    const id = await client.sendImage(jid, imageDataUrl(image), caption, imageButtons);
    onSent({ id, text: caption || '[图片]', image: true, buttons: imageButtons.map(b => ({ label: b.text })) });
    if (!split) return id;
  }
  const text = menuText(node, mode), id = await client.sendText(jid, text, buttons);
  onSent({ id, text, image: false, buttons: buttons.map(b => ({ label: b.text })) });
  return id;
}
