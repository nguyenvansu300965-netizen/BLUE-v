import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { browserExecutable } from '../wa-js-client.js';
import { browserResources, parseCpuList, scheduleBrowserStart } from '../browser-resources.js';

const dir = await mkdtemp('/tmp/blue-browser-resources-'), browsers = [];
async function taskCount(browser) {
  const root = browser.process().pid;
  const processes = await Promise.all((await readdir('/proc')).filter(value => /^\d+$/.test(value)).map(async pid => {
    try { const stat = await readFile(`/proc/${pid}/status`, 'utf8'); return { pid: Number(pid), parent: Number(/^PPid:\s*(\d+)$/m.exec(stat)?.[1]), threads: Number(/^Threads:\s*(\d+)$/m.exec(stat)?.[1]) }; } catch { return null; }
  }));
  const family = new Set([root]);
  for (let count = 0; count !== family.size;) { count = family.size; for (const item of processes) if (item && family.has(item.parent)) family.add(item.pid); }
  return processes.filter(item => item && family.has(item.pid)).reduce((total, item) => total + item.threads, 0);
}
try {
  const executablePath = await browserExecutable();
  const baseline = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let before;
  try { await (await baseline.newPage()).goto('about:blank'); before = await taskCount(baseline); } finally { await baseline.close(); }
  const states = await Promise.all(Array.from({ length: 3 }, (_, index) => scheduleBrowserStart(async () => {
    const config = await browserResources(executablePath, { ...process.env, CHROMIUM_CPU_LIMIT: '2' });
    const browser = await puppeteer.launch({ ...config, userDataDir: `${dir}/account-${index}`, headless: true, args: [...config.args, '--no-sandbox', '--disable-dev-shm-usage'] });
    browsers.push(browser);
    const page = await browser.newPage(); await page.goto('about:blank');
    const status = await readFile(`/proc/${browser.process().pid}/status`, 'utf8');
    const cpus = parseCpuList(/^Cpus_allowed_list:\s*(.+)$/m.exec(status)[1].trim());
    assert.ok(cpus.length > 0 && cpus.length <= 2);
    await page.evaluate(index => { window.accountOwner = index; const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240; document.body.append(canvas); canvas.getContext('2d').fillRect(0, 0, 240, 240); }, index);
    assert.equal(await page.evaluate(() => window.accountOwner), index);
    assert.match(await page.evaluate(() => document.querySelector('canvas').toDataURL()), /^data:image\/png;base64,/);
    return { cpus, threads: await taskCount(browser) };
  })));
  assert.equal(browsers.length, 3);
  console.log(`PASS: three isolated Chromium browsers use at most two CPUs each and render canvas. Thread counts: unrestricted fixture ${before}; bounded fixtures ${states.map(state => state.threads).join(', ')}. WhatsApp network delivery is not tested.`);
} finally { await Promise.all(browsers.map(browser => browser.close())); await rm(dir, { recursive: true, force: true }); }
