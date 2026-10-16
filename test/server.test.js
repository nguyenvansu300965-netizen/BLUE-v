import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('server serves UI, streams initial state and validates message requests', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blue-api-'));
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; const match = output.match(/port (\d+)/); if (match) resolve(match[1]); });
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Server exited: ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(base)).text(), /WhatsApp 工作台/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.messages, []);
    async function post(body, origin) { return fetch(`${base}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }); }
    assert.equal((await post({ phone: 'bad', text: 'hello' })).status, 400);
    assert.equal((await post({ phone: '8613800138000', text: '' })).status, 400);
    assert.equal((await post({ phone: '8613800138000', text: 'hello' })).status, 409);
    assert.equal((await post({ phone: '8613800138000', text: 'hello' }, 'https://other.example')).status, 403);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1kAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${base}/api/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image });
    assert.equal(upload.status, 200);
    const asset = (await upload.json()).id;
    assert.equal((await fetch(`${base}/api/media/${asset}`)).status, 200);
    assert.equal((await fetch(`${base}/api/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(20) })).status, 400);
    const flow = { enabled: true, mode: 'numbered', nodes: [{ id: 'hi', name: 'Welcome', text: 'Hello', triggers: ['hi'], image: asset, options: [] }] };
    assert.equal((await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(flow) })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/flows`)).json(), flow);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"status":"idle"/);
    controller.abort();
  } finally { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; await rm(dataDir, { recursive: true }); }
});
