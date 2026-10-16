import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuList, pickCpuGroup, browserResources, scheduleBrowserStart } from '../browser-resources.js';

test('browser CPU groups stay inside allowed cores and rotate across accounts', () => {
  const cpus = parseCpuList('2-5,8-9');
  assert.deepEqual(cpus, [2,3,4,5,8,9]);
  assert.equal(pickCpuGroup(cpus, 2, 0), '2,3');
  assert.equal(pickCpuGroup(cpus, 2, 1), '4,5');
  assert.equal(pickCpuGroup(cpus, 2, 2), '8,9');
  assert.equal(pickCpuGroup(cpus, 2, 3), '2,3');
  assert.equal(pickCpuGroup([0,1,2], 2, 1), '2');
  for (const invalid of ['', '2-1', 'x', '0-999999', '90071992547409920']) assert.throws(() => parseCpuList(invalid));
});
test('CPU binding configuration is validated and can be disabled explicitly', async () => {
  const config = await browserResources('/usr/bin/chromium', { CHROMIUM_CPU_LIMIT: '0' });
  assert.equal(config.executablePath, '/usr/bin/chromium');
  assert.ok(config.args.includes('--num-raster-threads=1'));
  for (const value of ['-1', 'bad', '2.5', '65']) await assert.rejects(browserResources('/usr/bin/chromium', { CHROMIUM_CPU_LIMIT: value }), { code: 'BROWSER_RESOURCE_CONFIG' });
});
test('browser startup is serialized and one failed launch does not block later accounts', async () => {
  let release, active = 0, peak = 0; const order = [];
  const first = scheduleBrowserStart(async () => { active++; peak = Math.max(peak, active); order.push('first'); await new Promise(resolve => { release = resolve; }); active--; throw new Error('fixture failure'); });
  const rejected = assert.rejects(first, /fixture failure/);
  const second = scheduleBrowserStart(async () => { active++; peak = Math.max(peak, active); order.push('second'); active--; return 'next browser'; });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['first']); release();
  await rejected; assert.equal(await second, 'next browser'); assert.equal(peak, 1);
});
