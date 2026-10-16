import { readdir, readFile, readlink, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const starting = new Set();
const lockError = message => Object.assign(new Error(`SingletonLock: ${message}`), { code: 'BROWSER_PROFILE_LOCKED' });
export async function profileProcesses(profileDir) {
  const profile = path.resolve(profileDir);
  const entries = await readdir('/proc');
  const processes = await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(async pid => {
    let args;
    try { args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
    return args.some((arg, index) => arg.startsWith('--user-data-dir=') ? path.resolve(arg.slice('--user-data-dir='.length)) === profile : arg === '--user-data-dir' && args[index + 1] && path.resolve(args[index + 1]) === profile) ? Number(pid) : null;
  }));
  return processes.filter(pid => pid !== null);
}
export async function recoverProfileLock(profileDir, { allowForeignHost = false, hostname = os.hostname(), processes = profileProcesses } = {}) {
  const lock = path.join(profileDir, 'SingletonLock');
  let stat, target;
  try { stat = await lstat(lock); target = await readlink(lock); }
  catch (error) { if (error.code === 'ENOENT') return false; throw lockError('锁格式无法识别，保留原档案'); }
  if (!stat.isSymbolicLink()) throw lockError('锁格式无法识别，保留原档案');
  const match = /^(.*)-([1-9]\d*)$/.exec(target);
  if (!match) throw lockError('锁格式无法识别，保留原档案');
  if (match[1] !== hostname && !allowForeignHost) {
    throw Object.assign(lockError('锁来自另一容器；确认单副本后设置 CHROMIUM_SINGLE_REPLICA=true 才可恢复'), { code: 'BROWSER_PROFILE_OTHER_HOST' });
  }
  // Fail closed when process inspection is unavailable; never kill a browser or delete its profile.
  if ((await processes(profileDir)).length) throw lockError('仍有浏览器使用此号码档案，未清理锁');
  for (const name of ['SingletonSocket', 'SingletonCookie']) {
    try { if (!(await lstat(path.join(profileDir, name))).isSymbolicLink()) throw lockError('锁格式无法识别，保留原档案'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const current = await lstat(lock);
  if (current.ino !== stat.ino || await readlink(lock) !== target) throw lockError('锁已发生变化，未清理');
  for (const name of ['SingletonSocket', 'SingletonCookie', 'SingletonLock']) {
    try { await unlink(path.join(profileDir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return true;
}
export async function launchWithProfileRecovery(launch, profileDir, { onRecovery = () => {}, canceled = () => false, ...options } = {}) {
  const key = path.resolve(profileDir);
  if (starting.has(key)) throw lockError('此号码正在启动浏览器，请稍候');
  starting.add(key);
  try {
    try { return await launch(); }
    catch (error) {
      if (canceled() || !/SingletonLock|ProcessSingleton|already running|profile.*in use/i.test(String(error.message))) throw error;
      if (!await recoverProfileLock(profileDir, options)) throw error;
      if (canceled()) throw error;
      onRecovery();
      return await launch(); // One retry only, with the original authentication files untouched.
    }
  } finally { starting.delete(key); }
}
