import { readFile } from 'node:fs/promises';

export async function resourceSample(read = file => readFile(file, 'utf8')) {
  const value = async file => { try { return String(await read(file)).trim(); } catch { return ''; } };
  const [current, limit, events, pids, pidLimit] = await Promise.all([
    value('/sys/fs/cgroup/memory.current'), value('/sys/fs/cgroup/memory.max'), value('/sys/fs/cgroup/memory.events'), value('/sys/fs/cgroup/pids.current'), value('/sys/fs/cgroup/pids.max')
  ]);
  const integer = text => /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  const toMb = text => integer(text) === null ? null : Math.round(Number(text) / 1048576);
  return { memoryMb: toMb(current), memoryLimitMb: toMb(limit), oomKills: integer(/^oom_kill\s+(\d+)$/m.exec(events)?.[1] || ''), pids: integer(pids), pidsLimit: integer(pidLimit) };
}
export function connectionDiagnostic(error, stage, before = {}, after = {}) {
  const text = String(error?.message || ''), rawCode = String(error?.code || '');
  let code;
  if (rawCode === 'ENOMEM' || /out of memory|cannot allocate memory|oom-kill/i.test(text) || (after.oomKills !== null && before.oomKills !== null && after.oomKills > before.oomKills)) code = 'BROWSER_OOM';
  else if (/SingletonLock|ProcessSingleton|already running|profile.*in use/i.test(text)) code = 'BROWSER_PROFILE_LOCKED';
  else if (rawCode === 'ENOSPC' || /no space left on device/i.test(text)) code = 'DATA_DISK_FULL';
  else if (['EACCES', 'EPERM'].includes(rawCode) || /permission denied/i.test(text)) code = 'DATA_PERMISSION';
  else if (rawCode === 'EAGAIN' || /pthread_create|resource temporarily unavailable|cannot fork/i.test(text) || (after.pidsLimit > 0 && after.pids >= after.pidsLimit)) code = 'BROWSER_PROCESS_LIMIT';
  else if (/ERR_CERT_/.test(text) || rawCode === 'CERTIFICATE_UNTRUSTED') code = 'CERTIFICATE_UNTRUSTED';
  else if (/ERR_TUNNEL_CONNECTION_FAILED/.test(text) || rawCode === 'PROXY_REJECTED') code = 'PROXY_REJECTED';
  else if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(text)) code = 'WHATSAPP_DNS';
  else if (stage === 'browser' && (error?.name === 'TimeoutError' || /timed out|timeout/i.test(text))) code = 'BROWSER_START_TIMEOUT';
  else if (['PAGE_TIMEOUT', 'CHROMIUM_MISSING', 'WEB_HTTP_403'].includes(rawCode)) code = rawCode;
  else if (/Target closed|browser.*disconnected|socket hang up|BROWSER_CLOSED|SIGKILL|SIGTRAP/i.test(text)) code = 'BROWSER_CRASHED';
  else code = stage === 'browser' ? 'BROWSER_LAUNCH_FAILED' : stage === 'inject' ? 'WAJS_INJECTION_FAILED' : 'WHATSAPP_CONNECT_FAILED';
  const hints = {
    BROWSER_OOM: 'Chromium 启动或运行时内存不足。请增加 Railway 内存，或停止不使用的号码后重试。',
    BROWSER_PROFILE_LOCKED: '此号码的浏览器档案被占用。请确认 Railway 只运行一个副本，再重新部署释放残留浏览器；无需删除登录档案。',
    DATA_DISK_FULL: '数据卷空间不足，请扩容 Railway 数据卷后重试。',
    DATA_PERMISSION: '浏览器或数据目录无访问权限，请检查 CHROMIUM_PATH 与数据卷权限。',
    BROWSER_PROCESS_LIMIT: '服务器无法创建更多浏览器进程或线程，请检查 Railway 的内存和进程限制。',
    BROWSER_START_TIMEOUT: 'Chromium 启动超时，请检查 Railway 内存、CPU 是否接近上限。',
    BROWSER_LAUNCH_FAILED: 'Chromium 启动失败，请根据同一错误码查看 Railway Deploy Logs。',
    BROWSER_CRASHED: 'Chromium 已意外关闭，请检查 Railway 是否发生内存不足或浏览器进程退出。',
    WHATSAPP_DNS: '服务器无法解析 WhatsApp 域名，请检查 Railway 出站网络或代理。',
    PAGE_TIMEOUT: '打开 WhatsApp 网页超时，请检查 Railway 出站网络。',
    CHROMIUM_MISSING: '未安装 Chromium，请检查 CHROMIUM_PATH。',
    CERTIFICATE_UNTRUSTED: '浏览器不信任连接证书，请检查网络代理的 CA 信任配置。',
    PROXY_REJECTED: '网络代理拒绝连接，请检查代理与 WhatsApp 域名放行设置。',
    WEB_HTTP_403: 'WhatsApp 网页访问被拒绝，请检查出站网络设置。',
    WAJS_INJECTION_FAILED: 'WhatsApp 网页已打开，但 WA-JS 初始化失败，请查看 Railway Deploy Logs。',
    WHATSAPP_CONNECT_FAILED: 'WhatsApp 连接失败，请根据错误码及启动阶段查看 Railway Deploy Logs。'
  };
  const memory = after.memoryMb !== null && after.memoryMb !== undefined ? ` 当前服务器内存 ${after.memoryMb}${after.memoryLimitMb ? ` / ${after.memoryLimitMb}` : ''} MB。` : '';
  return { code, stage: ['browser', 'page', 'inject'].includes(stage) ? stage : 'unknown', resources: after, message: `${hints[code]}${memory} [${code}]` };
}

// Log a bounded startup explanation, never connection secrets or URLs.
export function safeStartupReason(error) {
  return String(error?.message || '').split('\n')
    .filter(line => !/token|cookie|password|authorization|bearer|data:image|qr.?code/i.test(line))
    .map(line => line.replace(/https?:\/\/\S+/g, '[URL]'))
    .slice(0, 8).join('\n').slice(0, 1200);
}
