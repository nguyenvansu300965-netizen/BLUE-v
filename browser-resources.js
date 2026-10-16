import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cpuSlot = 0, startup = Promise.resolve();
export function parseCpuList(value) {
  if (!/^(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$/.test(value)) throw new Error('Invalid CPU affinity list');
  const result = [];
  for (const part of value.split(',')) {
    const [start, end = start] = part.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 4096) throw new Error('Invalid CPU affinity range');
    for (let cpu = start; cpu <= end; cpu++) result.push(cpu);
  }
  return [...new Set(result)];
}
export function pickCpuGroup(cpus, limit, slot) {
  const groups = Math.ceil(cpus.length / limit);
  const offset = (slot % groups) * limit;
  return cpus.slice(offset, offset + limit).join(',');
}
export async function browserResources(executablePath, env = process.env) {
  const limit = Number(env.CHROMIUM_CPU_LIMIT ?? 2);
  if (!Number.isInteger(limit) || limit < 0 || limit > 64) throw Object.assign(new Error('CHROMIUM_CPU_LIMIT must be 0–64'), { code: 'BROWSER_RESOURCE_CONFIG' });
  const args = ['--renderer-process-limit=2', '--num-raster-threads=1', '--disable-gpu', '--disable-software-rasterizer'];
  if (process.platform !== 'linux' || limit === 0) return { executablePath, args };
  try {
    await access('/usr/bin/taskset', constants.X_OK);
    const status = await readFile('/proc/self/status', 'utf8');
    const cpus = parseCpuList(/^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1]?.trim() || '');
    const selected = pickCpuGroup(cpus, limit, cpuSlot++);
    const wrapper = fileURLToPath(new URL('./scripts/chromium-launcher.sh', import.meta.url));
    await access(wrapper, constants.X_OK);
    return { executablePath: wrapper, args, env: { ...env, BLUE_CHROMIUM_BIN: executablePath, BLUE_CHROMIUM_CPUS: selected } };
  } catch {
    throw Object.assign(new Error('CPU affinity setup failed; install util-linux/taskset or set CHROMIUM_CPU_LIMIT=0'), { code: 'BROWSER_RESOURCE_CONFIG' });
  }
}
export function scheduleBrowserStart(run) {
  const result = startup.then(run);
  startup = result.catch(() => {});
  return result;
}
