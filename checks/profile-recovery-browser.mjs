import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserExecutable } from '../wa-js-client.js';
import { launchWithProfileRecovery } from '../profile-recovery.js';

const dir = await mkdtemp('/tmp/blue-profile-recovery-browser-');
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Profile persistence fixture</title>'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { executablePath: await browserExecutable(), userDataDir: dir, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
let browser;
try {
  browser = await puppeteer.launch(options);
  let page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(() => { localStorage.setItem('login-fixture', 'owner-one-session'); });
  await browser.close(); browser = null;
  for (const [name, target] of [['SingletonLock', 'previous-container-99999999'], ['SingletonCookie', 'old-cookie-token'], ['SingletonSocket', '/tmp/missing-old-browser/socket']]) await symlink(target, `${dir}/${name}`);
  let attempts = 0, recovered = false;
  browser = await launchWithProfileRecovery(() => { attempts++; return puppeteer.launch(options); }, dir, { allowForeignHost: true, onRecovery: () => { recovered = true; } });
  assert.equal(attempts, 2); assert.equal(recovered, true);
  page = await browser.newPage(); await page.goto(origin);
  assert.equal(await page.evaluate(() => localStorage.getItem('login-fixture')), 'owner-one-session');
  await assert.rejects(launchWithProfileRecovery(() => puppeteer.launch(options), dir, { allowForeignHost: true }), /仍有浏览器/);
  assert.equal(await page.evaluate(() => localStorage.getItem('login-fixture')), 'owner-one-session');
  console.log('PASS: a real stale foreign-host Chromium lock is recovered without losing profile storage; a live browser remains protected.');
} finally {
  await browser?.close(); server.close(); await rm(dir, { recursive: true, force: true });
}
