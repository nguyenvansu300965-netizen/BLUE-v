const $ = id => document.getElementById(id);
const planNames = { basic: '基础套餐', pro: '高级套餐', vip: 'VIP 套餐' };
const statusNames = { idle: '未连接', connecting: '连接中', qr: '等待扫码', connected: '已连接', disconnected: '重连中', logged_out: '已退出', blocked: '权限受限', error: '连接失败' };
let me = null, accounts = [], selectedAccount = '', selectedThread = '', draftPhone = '', messages = [], stream = null, registration = false, sending = false, connected = false;
let noticeTimer, authEpoch = 0, connectionStatus = 'idle';
function notice(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 6000); }
function closeStream() { stream?.close(); stream = null; }
function showAuth() {
  authEpoch++;
  closeStream(); me = null; accounts = []; selectedAccount = ''; messages = [];
  $('workspace').hidden = true; $('auth-screen').hidden = false;
  $('device-dialog').close(); $('qr').hidden = true; $('qr').removeAttribute('src'); $('text').value = ''; $('messages').replaceChildren();
  window.dispatchEvent(new Event('account-changed'));
}
async function api(url, options = {}) {
  const epoch = authEpoch;
  const response = await fetch(url, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && epoch === authEpoch && !url.includes('/auth/login')) showAuth(); throw new Error(result.error || '请求失败'); }
  return result;
}
window.flowBase = () => selectedAccount ? `/api/accounts/${selectedAccount}` : null;
window.workspaceApi = api;
function accountPath(suffix = '') { if (!selectedAccount) throw new Error('请先添加或选择号码'); return `/api/accounts/${selectedAccount}${suffix}`; }
function showPage(name) {
  for (const page of ['chat', 'flows', 'admin']) { $(`page-${page}`).hidden = page !== name; $(`nav-${page}`).classList.toggle('active', page === name); }
  if (name === 'admin') void loadAdmin();
}
function updateMembership(user) {
  me = user;
  $('current-user').textContent = user.username;
  $('user-avatar').textContent = user.username[0].toUpperCase();
  $('nav-admin').hidden = user.role !== 'admin';
  $('subscription-badge').textContent = user.role === 'admin' ? '超级管理员' : planNames[user.plan];
  $('subscription-bar').classList.toggle('pending', !user.active);
  $('subscription-bar').textContent = user.role === 'admin' ? '超级管理员 · 在管理后台为用户开通套餐和订阅' : user.active ? `${planNames[user.plan]} · 最多 ${user.limit} 个号码 · 有效期至 ${new Date(user.expiresAt).toLocaleString()}` : '账号待开通、已停用或订阅已到期，请联系超级管理员开通使用权限。';
  $('add-account').disabled = !user.active || accounts.length >= user.limit;
  $('quota').textContent = `${accounts.length} / ${user.limit} 个号码`;
}
async function refreshAccounts() {
  if (!me) return;
  const epoch = authEpoch;
  const data = await api('/api/accounts');
  if (epoch !== authEpoch || !me) return;
  accounts = data.accounts; updateMembership(data.user);
  const select = $('account-select'); select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = accounts.length ? '请选择号码' : '尚未添加号码'; select.append(placeholder);
  for (const account of accounts) {
    const option = document.createElement('option'); option.value = account.id;
    option.textContent = `${account.label}${account.allowed ? '' : ' · 配额/订阅受限'}`; option.disabled = !account.allowed; select.append(option);
  }
  if (!accounts.some(a => a.id === selectedAccount && a.allowed)) {
    selectedAccount = accounts.find(a => a.allowed)?.id || '';
    switchAccount();
  }
  select.value = selectedAccount;
  $('open-device').disabled = !selectedAccount;
  // Excess accounts can still be removed from the list using the delete action.
  $('remove-account').disabled = !accounts.length;
}
async function enter(user) {
  authEpoch++;
  me = user; $('auth-screen').hidden = true; $('workspace').hidden = false; $('password').value = ''; showPage('chat');
  await refreshAccounts();
}
function switchAccount() {
  closeStream(); connectionStatus = 'idle'; $('connect').textContent = '连接 WhatsApp'; connected = false; selectedThread = ''; draftPhone = ''; messages = [];
  $('text').value = ''; $('qr').hidden = true; $('qr').removeAttribute('src'); document.querySelector('.qr-placeholder').hidden = false;
  $('account').textContent = ''; $('connection-hint').textContent = '点击连接生成二维码'; $('device-label').textContent = accounts.find(a => a.id === selectedAccount)?.label || ''; $('connect').disabled = !selectedAccount; $('flow-status').textContent = '未启用';
  $('send').disabled = true; $('status').textContent = '未连接'; $('status').classList.remove('online'); $('device-dialog').close(); renderChats(); renderMessages();
  window.dispatchEvent(new Event('account-changed'));
  if (!selectedAccount) return;
  const id = selectedAccount;
  stream = new EventSource(`/api/accounts/${id}/events`);
  stream.onmessage = event => { if (id === selectedAccount) renderState(JSON.parse(event.data)); };
  stream.addEventListener('revoked', () => { if (id !== selectedAccount) return; closeStream(); notice('登录或订阅权限已变更'); void refreshAccounts().catch(error => notice(error.message)); });
  stream.onerror = () => { if (id === selectedAccount) { connected = false; $('send').disabled = true; $('status').textContent = '工作台重连中'; } };
}
function renderState(state) {
  connectionStatus = state.status;
  connected = state.status === 'connected'; messages = state.messages;
  $('status').textContent = statusNames[state.status] || state.status; $('status').classList.toggle('online', connected);
  $('send').disabled = !connected || !selectedThread || sending;
  $('qr').hidden = !state.qr; if (state.qr) $('qr').src = state.qr;
  document.querySelector('.qr-placeholder').hidden = Boolean(state.qr) || connected;
  $('connection-hint').textContent = connected ? '✓ 已关联，可以收发消息' : state.error || (state.qr ? '请使用手机 WhatsApp 扫码' : state.progress || (state.status === 'connecting' ? '正在获取二维码…' : '点击下方按钮连接 WhatsApp'));
  $('account').textContent = state.user ? `当前号码：${state.user.name || ''} ${state.user.id || ''}` : '';
  $('device-label').textContent = state.account.label;
  $('connect').disabled = connected || state.status === 'qr' || state.authenticated;
  $('connect').textContent = state.authenticated && !connected ? '正在完成登录…' : state.status === 'connecting' ? '重新连接' : '连接 WhatsApp';
  const last = state.automation.last;
  $('flow-status').textContent = `${state.automation.enabled ? '已启用' : '未启用'}${last ? ` · ${last.node}：${last.ok ? '已提交，显示需验证' : '发送失败'}` : ''}`;
  renderChats(); renderMessages();
}
function threads() {
  const map = new Map();
  for (const message of messages) {
    const previous = map.get(message.jid);
    const displayName = !message.outgoing && message.name && message.name !== message.jid ? message.name : previous?.name || message.jid.split('@')[0];
    map.set(message.jid, { jid: message.jid, name: displayName, last: message });
  }
  if (draftPhone && selectedThread) map.set(selectedThread, map.get(selectedThread) || { jid: selectedThread, name: draftPhone, last: { text: '新会话', time: Date.now() } });
  return [...map.values()].sort((a, b) => b.last.time - a.last.time);
}
function renderChats() {
  const filter = $('chat-search').value.toLowerCase();
  const list = threads().filter(t => `${t.name} ${t.jid} ${t.last.text}`.toLowerCase().includes(filter));
  $('chat-list').replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-list'; empty.textContent = !selectedAccount ? '选择或添加 WhatsApp 号码，开启你的第一段对话。' : '还没有会话。连接号码后接收消息，或点击 ＋ 开始新会话。'; $('chat-list').append(empty);
  }
  for (const thread of list) {
    const button = document.createElement('button'); button.className = `chat-item${thread.jid === selectedThread ? ' active' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = thread.name[0];
    const copy = document.createElement('span'); copy.className = 'chat-copy';
    const top = document.createElement('span'); top.className = 'chat-top';
    const name = document.createElement('strong'); name.textContent = thread.name;
    const time = document.createElement('time'); time.textContent = new Date(thread.last.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const preview = document.createElement('span'); preview.className = 'chat-preview'; preview.textContent = `${thread.last.outgoing ? '你：' : ''}${thread.last.text}`;
    top.append(name, time); copy.append(top, preview); button.append(avatar, copy);
    button.onclick = () => { selectedThread = thread.jid; $('page-chat').classList.add('chat-open'); renderChats(); renderMessages(); };
    $('chat-list').append(button);
  }
}
function renderMessages() {
  const thread = threads().find(t => t.jid === selectedThread);
  $('chat-name').textContent = thread?.name || 'BLUE-v 网页工作台';
  $('chat-subtitle').textContent = thread ? `${thread.jid.split('@')[0]} · ${connected ? '当前号码已连接' : '当前号码未连接'} · 手机上点此返回会话列表` : '选择一个号码和会话，开始聊天';
  $('chat-avatar').textContent = thread?.name[0] || 'B';
  $('send').disabled = !connected || !selectedThread || sending;
  const area = $('messages');
  if (!selectedThread) {
    area.innerHTML = '<div class="chat-welcome"><div class="welcome-icon">☏</div><h2>让沟通更进一步</h2><p>添加 WhatsApp 号码，扫码关联设备<br>在这里接收客户消息、配置自动回复。</p><small>仅限本人或获授权的 WhatsApp 账号</small></div>'; return;
  }
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  area.replaceChildren();
  let day = '';
  for (const message of messages.filter(m => m.jid === selectedThread)) {
    const date = new Date(message.time).toLocaleDateString();
    if (date !== day) { const label = document.createElement('div'); label.className = 'day-label'; label.textContent = date; area.append(label); day = date; }
    const bubble = document.createElement('div'); bubble.className = `bubble${message.outgoing ? ' outgoing' : ''}`;
    const text = document.createElement('div'); text.className = 'bubble-text'; text.textContent = message.text;
    const time = document.createElement('span'); time.className = 'bubble-time'; time.textContent = `${message.automatic ? '自动回复 · ' : ''}${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${message.outgoing ? ' ✓' : ''}`;
    bubble.append(text, time); area.append(bubble);
  }
  if (nearBottom) area.scrollTop = area.scrollHeight;
}
$('auth-toggle').onclick = () => {
  registration = !registration;
  $('auth-title').textContent = registration ? '创建你的账号' : '欢迎回来';
  $('auth-description').textContent = registration ? '注册后联系管理员开通套餐与订阅' : '登录你的客户沟通工作台';
  $('auth-submit').textContent = registration ? '注册账号 →' : '登录工作台 →';
  $('auth-switch-label').textContent = registration ? '已有账号？' : '还没有账号？';
  $('auth-toggle').textContent = registration ? '去登录' : '自由注册';
  $('password').autocomplete = registration ? 'new-password' : 'current-password'; $('auth-notice').textContent = '';
};
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-notice').textContent = '';
  try {
    const result = await api(`/api/auth/${registration ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    if (registration) { $('auth-toggle').click(); $('auth-notice').textContent = '注册成功，请登录并联系管理员开通订阅。'; }
    else await enter(result.user);
  } catch (error) { $('auth-notice').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
};
$('signout').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); showAuth(); } catch (error) { notice(error.message); } };
$('account-select').onchange = () => { selectedAccount = $('account-select').value; switchAccount(); };
$('add-account').onclick = async () => {
  const label = prompt('请输入此 WhatsApp 号码的备注名称'); if (!label) return;
  try { const result = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) }); selectedAccount = result.account.id; await refreshAccounts(); switchAccount(); $('device-dialog').showModal(); }
  catch (error) { notice(error.message); }
};
$('remove-account').onclick = async () => {
  let choice = selectedAccount || accounts[0]?.id;
  if (accounts.length > 1) {
    const raw = prompt(`选择要删除的号码，输入序号：\n${accounts.map((a, i) => `${i + 1}. ${a.label}${a.allowed ? '' : '（受限）'}`).join('\n')}`, String(Math.max(0, accounts.findIndex(a => a.id === choice)) + 1));
    if (raw === null) return;
    choice = accounts[Number(raw) - 1]?.id;
  }
  const account = accounts.find(a => a.id === choice); if (!account) return;
  if (!confirm(`删除「${account.label}」以及其本地会话、消息、图片和流程？`)) return;
  try { await api(`/api/accounts/${account.id}`, { method: 'DELETE' }); if (selectedAccount === account.id) selectedAccount = ''; await refreshAccounts(); notice('号码已删除；如需撤销手机端关联，请在 WhatsApp 已关联设备中移除。'); } catch (error) { notice(error.message); }
};
$('open-device').onclick = () => { if (selectedAccount) $('device-dialog').showModal(); };
$('close-device').onclick = () => $('device-dialog').close();
$('connect').onclick = async () => { try { await api(accountPath('/connect'), { method: 'POST', body: JSON.stringify({ restart: connectionStatus === 'connecting' }) }); } catch (error) { notice(error.message); } };
$('logout').onclick = async () => {
  if (!confirm('退出并清除此号码的 WhatsApp 登录会话？不会删除平台账号。')) return;
  try { await api(accountPath('/logout'), { method: 'POST' }); switchAccount(); } catch (error) { notice(error.message); }
};
$('new-chat').onclick = () => {
  if (!selectedAccount) return notice('请先添加并选择一个号码');
  const raw = prompt('输入收件人手机号，包含国家区号'); if (!raw) return;
  const phone = raw.replace(/[\s()+-]/g, ''); if (!/^[1-9]\d{6,14}$/.test(phone)) return notice('请输入含国家区号的有效手机号');
  draftPhone = phone; selectedThread = `${phone}@s.whatsapp.net`; $('page-chat').classList.add('chat-open'); renderChats(); renderMessages(); $('text').focus();
};
$('chat-search').oninput = renderChats;
$('chat-name').parentElement.parentElement.onclick = () => $('page-chat').classList.remove('chat-open');
$('text').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('send-form').requestSubmit(); } };
$('send-form').onsubmit = async event => {
  event.preventDefault(); if (sending || !selectedAccount || !selectedThread) return;
  const id = selectedAccount, jid = selectedThread, text = $('text').value;
  const existing = messages.some(m => m.jid === jid);
  sending = true; $('send').disabled = true;
  try {
    await api(`/api/accounts/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(existing ? { jid } : { phone: draftPhone }) }) });
    if (id === selectedAccount && jid === selectedThread) $('text').value = '';
  } catch (error) { notice(error.message); }
  finally { sending = false; $('send').disabled = !connected || !selectedThread; }
};
$('nav-chat').onclick = () => showPage('chat');
$('nav-flows').onclick = () => { if (!selectedAccount) return notice('请先选择可用号码，再配置自动回复'); showPage('flows'); };
$('nav-admin').onclick = () => showPage('admin');
function localDate(iso) { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function loadAdmin() {
  const epoch = authEpoch;
  try {
    const result = await api('/api/admin/users');
    if (epoch !== authEpoch || me?.role !== 'admin') return; $('admin-users').replaceChildren();
    for (const user of result.users) {
      const form = document.createElement('form'); form.className = 'admin-user';
      const name = document.createElement('div'); name.className = 'user-name';
      const strong = document.createElement('strong'); strong.textContent = user.username;
      const info = document.createElement('small'); info.textContent = `${user.role === 'admin' ? '超级管理员' : user.active ? '订阅有效' : '待开通 / 已停用 / 已到期'} · ${user.accountCount} 个号码`;
      name.append(strong, info); form.append(name);
      if (user.role === 'admin') { $('admin-users').append(form); continue; }
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = user.enabled;
      const enabledLabel = document.createElement('label'); enabledLabel.className = 'checkbox'; enabledLabel.append(enabled, document.createTextNode('开通权限'));
      const plan = document.createElement('select');
      for (const [key, value] of Object.entries(result.plans)) { const option = document.createElement('option'); option.value = key; option.textContent = `${value.name} · ${value.limit} 个号码`; plan.append(option); }
      plan.value = user.plan;
      const date = document.createElement('input'); date.type = 'datetime-local'; date.value = localDate(user.expiresAt || Date.now() + 30 * 86400000); date.required = true;
      const dateLabel = document.createElement('label'); dateLabel.textContent = '订阅到期时间（本地时间）'; dateLabel.append(date);
      const button = document.createElement('button'); button.type = 'submit'; button.textContent = '保存授权';
      form.append(enabledLabel, plan, dateLabel, button);
      form.onsubmit = async event => {
        event.preventDefault(); button.disabled = true;
        try {
          await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: enabled.checked, plan: plan.value, expiresAt: date.value ? new Date(date.value).toISOString() : null }) });
          $('admin-notice').textContent = `已更新 ${user.username} 的使用权限和订阅`; await loadAdmin();
        } catch (error) { $('admin-notice').textContent = error.message; }
        finally { button.disabled = false; }
      };
      $('admin-users').append(form);
    }
    $('admin-audit').replaceChildren(...result.audit.map(entry => {
      const div = document.createElement('div'); div.className = 'audit-entry';
      const detail = JSON.parse(entry.detail); div.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.target_name || entry.target} · ${planNames[detail.plan]} · ${detail.enabled ? '开通 / 更新' : '停用'}${detail.expiresAt ? ` · 到期 ${new Date(detail.expiresAt).toLocaleString()}` : ''}`; return div;
    }));
  } catch (error) { $('admin-notice').textContent = error.message; }
}
$('admin-refresh').onclick = loadAdmin;
setInterval(() => { if (me) void refreshAccounts().catch(error => notice(error.message)); }, 15000);
void api('/api/auth/me').then(result => enter(result.user)).catch(() => showAuth());
