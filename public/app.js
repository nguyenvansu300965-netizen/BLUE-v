const $ = id => document.getElementById(id);
const planNames = { basic: '基础套餐', pro: '高级套餐', vip: 'VIP 套餐' };
const statusNames = { idle: '未连接', connecting: '连接中', qr: '等待扫码', connected: '已连接', disconnected: '重连中', logged_out: '已退出', blocked: '权限受限', error: '连接失败' };
let me = null, accounts = [], selectedAccount = '', selectedThread = '', draftPhone = '', messages = [], stream = null, registration = false, sending = false, connected = false;
let attachmentDraft = null, passwordTarget = null;
let accountsRequest = 0, creatingAccount = false;
let noticeTimer, authEpoch = 0, connectionStatus = 'idle';
function notice(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 6000); }
function closeStream() { stream?.close(); stream = null; }
function showAuth() {
  const hadIdentity = Boolean(me);
  authEpoch++; clearAttachment(); closePasswordDialog();
  closeStream(); accountsRequest++; creatingAccount = false; me = null; accounts = []; selectedAccount = ''; selectedThread = ''; draftPhone = ''; messages = []; connected = false; connectionStatus = 'idle';
  $('self-number').hidden = true; $('self-number').textContent = '';
  $('account-select').replaceChildren(); $('account-select').disabled = false; $('status').textContent = '未连接'; $('status').classList.remove('online'); $('account').textContent = ''; $('connection-hint').textContent = '点击连接生成二维码'; $('send').disabled = true;
  $('workspace').hidden = true; $('auth-screen').hidden = false;
  $('device-dialog').close(); $('qr').hidden = true; $('qr').removeAttribute('src'); $('text').value = ''; $('messages').replaceChildren();
  clearTimeout(noticeTimer);
  for (const id of ['notice', 'current-user', 'subscription-badge', 'subscription-bar', 'quota', 'device-label', 'receiver-status', 'sync-status', 'admin-notice', 'admin-users', 'admin-audit']) $(id).replaceChildren();
  $('user-avatar').textContent = 'U'; $('nav-admin').hidden = true;
  if (hadIdentity) { $('username').value = ''; $('password').value = ''; }
  $('chat-search').value = '';
  $('connect').textContent = '连接 WhatsApp'; $('connect').disabled = true; $('open-device').disabled = true; $('remove-account').disabled = true; $('sync-messages').disabled = true;
  $('flow-status').textContent = '未启用'; document.querySelector('.qr-placeholder').hidden = false; $('page-chat').classList.remove('chat-open');
  renderChats(); renderMessages();
  window.dispatchEvent(new Event('account-changed'));
}
async function api(url, options = {}) {
  const epoch = authEpoch;
  const expectedUser = me?.id;
  const response = await fetch(url, { ...options, headers: { ...(expectedUser && !['/api/auth/login', '/api/auth/register', '/api/auth/me'].includes(url) ? { 'X-Workspace-User': expectedUser } : {}), ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (epoch !== authEpoch) { const error = new Error('已忽略切换账号前的请求结果'); error.name = 'StaleResponseError'; throw error; }
  if (!response.ok) { if ((response.status === 401 || result.code === 'SESSION_CHANGED') && epoch === authEpoch && !url.includes('/auth/login')) { showAuth(); if (result.code === 'SESSION_CHANGED') $('auth-notice').textContent = result.error; } throw new Error(result.error || '请求失败'); }
  return result;
}
window.isSuperAdmin = () => me?.role === 'admin';
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
async function refreshAccounts(preferredId) {
  if (!me || (creatingAccount && !preferredId)) return false;
  const epoch = authEpoch, owner = me.id, request = ++accountsRequest;
  const data = await api('/api/accounts');
  if (epoch !== authEpoch || !me || request !== accountsRequest) return false;
  if (data.user.id !== owner || data.accounts.some(account => account.user_id !== owner)) { showAuth(); $('auth-notice').textContent = '登录账号已变更，请重新登录'; return false; }
  accounts = data.accounts; updateMembership(data.user);
  const select = $('account-select'); select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = accounts.length ? '请选择号码' : '尚未添加号码'; select.append(placeholder);
  for (const account of accounts) {
    const option = document.createElement('option'); option.value = account.id;
    option.textContent = `${account.label}${account.number ? ` · +${account.number}` : ''}${account.allowed ? '' : ' · 配额/订阅受限'}`; option.disabled = !account.allowed; select.append(option);
  }
  const candidate = preferredId || selectedAccount;
  const next = accounts.some(a => a.id === candidate && a.allowed) ? candidate : accounts.find(a => a.allowed)?.id || '';
  if (next !== selectedAccount) { selectedAccount = next; switchAccount(); }
  select.value = selectedAccount;
  $('open-device').disabled = !selectedAccount;
  // Excess accounts can still be removed from the list using the delete action.
  $('remove-account').disabled = !accounts.length;
  return true;
}
async function enter(user) {
  showAuth(); authEpoch++;
  me = user; updateMembership(user); $('auth-screen').hidden = true; $('workspace').hidden = false; $('password').value = ''; showPage('chat');
  await refreshAccounts();
}
function switchAccount() {
  $('self-number').hidden = true; $('self-number').textContent = '';
  clearAttachment(); closeStream(); connectionStatus = 'idle'; $('connect').textContent = '连接 WhatsApp'; connected = false; selectedThread = ''; draftPhone = ''; messages = [];
  $('text').value = ''; $('qr').hidden = true; $('qr').removeAttribute('src'); document.querySelector('.qr-placeholder').hidden = false;
  $('account').textContent = ''; $('connection-hint').textContent = '点击连接生成二维码'; $('device-label').textContent = selectedAccount ? `平台账号：${me?.username || ''} · 号码备注：${accounts.find(a => a.id === selectedAccount)?.label || ''}` : ''; $('connect').disabled = !selectedAccount; $('flow-status').textContent = '未启用';
  $('send').disabled = true; $('sync-status').textContent = ''; $('receiver-status').textContent = ''; $('sync-messages').disabled = true; $('status').textContent = '未连接'; $('status').classList.remove('online'); $('device-dialog').close(); renderChats(); renderMessages();
  window.dispatchEvent(new Event('account-changed'));
  if (!selectedAccount) return;
  const id = selectedAccount, epoch = authEpoch, owner = me.id;
  const source = new EventSource(`/api/accounts/${id}/events?workspaceUser=${encodeURIComponent(owner)}`); stream = source;
  const current = () => stream === source && id === selectedAccount && epoch === authEpoch && owner === me?.id;
  source.onmessage = event => { if (current()) renderState(JSON.parse(event.data)); };
  source.addEventListener('revoked', () => { if (!current()) return; closeStream(); notice('登录或订阅权限已变更'); void refreshAccounts().catch(error => notice(error.message)); });
  source.onerror = () => { if (current()) { connected = false; $('send').disabled = true; $('sync-status').textContent = ''; $('receiver-status').textContent = ''; $('sync-messages').disabled = true; $('status').textContent = '工作台重连中'; } };
}
function renderState(state) {
  if (!me || state.account?.id !== selectedAccount || state.account?.user_id !== me.id) return;
  if (state.status === 'connected' && !/^[0-9]+@(s\.whatsapp\.net|c\.us|lid)$/.test(state.user?.id || '')) state = { ...state, status: 'connecting', user: null, progress: '正在核实 WhatsApp 登录身份，尚未取得当前号码…' };
  connectionStatus = state.status;
  connected = state.status === 'connected'; messages = state.messages;
  $('receiver-status').textContent = !connected ? '' : state.receiver?.error || (state.receiver?.ready ? (state.receiver.lastMessageAt ? `最近收信 ${new Date(state.receiver.lastMessageAt).toLocaleTimeString()}` : '实时接收已就绪') : '消息接收初始化中…');
  $('receiver-status').title = state.receiver ? `收到事件 ${state.receiver.received}，未解析 ${state.receiver.rejected}` : '';
  $('sync-status').textContent = state.sync?.status === 'syncing' ? '正在导入最近会话…' : state.sync?.error || (state.sync?.updatedAt ? `最近同步新增 ${state.sync.imported} 条` : '');
  $('sync-messages').disabled = !connected || state.sync?.status === 'syncing';
  $('sync-messages').textContent = state.sync?.status === 'syncing' ? '同步中…' : '同步消息';
  $('sync-messages').title = state.sync?.error || (state.sync?.updatedAt ? `最近同步 ${new Date(state.sync.updatedAt).toLocaleString()}` : '读取当前号码在 WhatsApp Web 中可用的最近消息');
  $('status').textContent = statusNames[state.status] || state.status; $('status').classList.toggle('online', connected);
  $('send').disabled = !connected || !selectedThread || sending;
  $('qr').hidden = !state.qr; if (state.qr) $('qr').src = state.qr;
  document.querySelector('.qr-placeholder').hidden = Boolean(state.qr) || connected;
  $('connection-hint').textContent = connected ? '✓ 已关联，可以收发消息' : state.error || (state.qr ? '请使用手机 WhatsApp 扫码' : state.progress || (state.status === 'connecting' ? '正在获取二维码…' : '点击下方按钮连接 WhatsApp'));
  const phone = /^[1-9]\d{6,14}$/.test(state.user?.phoneNumber || '') ? state.user.phoneNumber : /^([1-9]\d{6,14})@(s\.whatsapp\.net|c\.us)$/.exec(state.user?.id || '')?.[1] || '';
  $('self-number').hidden = !state.user;
  $('self-number').textContent = phone ? `我的号码：+${phone}` : state.user ? '手机号暂未解析' : '';
  $('account').textContent = phone ? `已关联 WhatsApp 手机号：+${phone}` : state.user ? '已确认 WhatsApp 账号，手机号暂未解析，系统会自动重试。' : '';
  const ownAccount = accounts.find(account => account.id === selectedAccount);
  if (ownAccount) {
    ownAccount.number = phone;
    const option = [...$('account-select').options].find(item => item.value === selectedAccount);
    if (option) option.textContent = `${ownAccount.label}${phone ? ` · +${phone}` : ''}${ownAccount.allowed ? '' : ' · 配额/订阅受限'}`;
  }
  $('device-label').textContent = `平台账号：${me.username} · 号码备注：${state.account.label}`;
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
    button.onclick = () => { if (selectedThread !== thread.jid) clearAttachment(); selectedThread = thread.jid; $('page-chat').classList.add('chat-open'); renderChats(); renderMessages(); };
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
    const imageUrl = /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(message.image || '') ? `/api/accounts/${selectedAccount}/media/${message.image}` : /^data:image\/(jpeg|png|webp);base64,/.test(message.thumbnail || '') ? message.thumbnail : null;
    if (imageUrl) {
      const image = document.createElement('img'); image.className = 'message-image'; image.src = imageUrl; image.alt = '消息图片'; image.loading = 'lazy';
      image.onerror = () => { image.hidden = true; };
      bubble.append(image);
    }
    if (/^[a-f0-9]{32}$/.test(message.attachment?.id || '')) {
      const item = message.attachment, url = `/api/accounts/${selectedAccount}/attachments/${item.id}`;
      if (['image', 'video', 'audio'].includes(item.type)) {
        const media = document.createElement(item.type === 'image' ? 'img' : item.type);
        media.className = item.type === 'image' ? 'message-image' : 'message-media'; media.src = url;
        if (item.type === 'image') { media.alt = item.name; media.loading = 'lazy'; } else { media.controls = true; media.preload = 'metadata'; }
        bubble.append(media);
      }
      const link = document.createElement('a'); link.href = `${url}?download=1`; link.textContent = `下载 ${item.name}`; link.className = 'message-download'; bubble.append(link);
    }
    bubble.append(text);
    if (message.buttons?.length) {
      const choices = document.createElement('div'); choices.className = 'message-choices'; choices.setAttribute('aria-label', '消息中的选项');
      for (const option of message.buttons) { const label = document.createElement('span'); label.textContent = option.label; choices.append(label); }
      bubble.append(choices);
    }
    bubble.append(time); area.append(bubble);
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
  event.preventDefault(); const epoch = authEpoch; $('auth-submit').disabled = true; $('auth-notice').textContent = '';
  try {
    const result = await api(`/api/auth/${registration ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    if (registration) { $('auth-toggle').click(); $('auth-notice').textContent = '注册成功，请登录并联系管理员开通订阅。'; }
    else await enter(result.user);
  } catch (error) { if (epoch === authEpoch) $('auth-notice').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
};
$('signout').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); showAuth(); } catch (error) { notice(error.message); } };
$('account-select').onchange = () => { selectedAccount = $('account-select').value; switchAccount(); };
$('add-account').onclick = async () => {
  if (creatingAccount || !me) return;
  const label = prompt('请输入此 WhatsApp 号码的备注名称'); if (!label) return;
  const epoch = authEpoch, owner = me.id;
  creatingAccount = true; accountsRequest++; $('add-account').disabled = true; $('account-select').disabled = true;
  try {
    const result = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
    if (epoch !== authEpoch || owner !== me?.id) return;
    if (result.account.user_id !== owner) throw new Error('号码归属不匹配，请重新登录');
    const applied = await refreshAccounts(result.account.id);
    if (applied && epoch === authEpoch && selectedAccount === result.account.id) $('device-dialog').showModal();
  } catch (error) { if (epoch === authEpoch) notice(error.message); }
  finally { if (epoch === authEpoch) { creatingAccount = false; $('account-select').disabled = false; if (me) updateMembership(me); } }
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
$('sync-messages').onclick = async () => { try { const result = await api(accountPath('/sync'), { method: 'POST' }); notice(result.sync.error || '已开始同步，完成后会话列表会自动更新。'); } catch (error) { notice(error.message); } };
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
  clearAttachment(); draftPhone = phone; selectedThread = `${phone}@s.whatsapp.net`; $('page-chat').classList.add('chat-open'); renderChats(); renderMessages(); $('text').focus();
};
$('chat-search').oninput = renderChats;
$('chat-name').parentElement.parentElement.onclick = () => $('page-chat').classList.remove('chat-open');
$('text').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('send-form').requestSubmit(); } };
function clearAttachment() {
  attachmentDraft = null; $('chat-file').value = ''; $('attachment-draft').hidden = true; $('attachment-draft').textContent = ''; $('clear-attachment').hidden = true;
}
$('attach-file').onclick = () => {
  if (!connected || !selectedThread || sending) return notice('请先连接号码并选择聊天');
  $('chat-file').click();
};
$('clear-attachment').onclick = () => { if (!sending) clearAttachment(); };
$('chat-file').onchange = () => {
  const file = $('chat-file').files[0]; if (!file) return;
  if (!file.size || file.size > 20 * 1024 * 1024) { $('chat-file').value = ''; return notice('请选择非空文件，最大 20MB'); }
  attachmentDraft = { file, uploaded: null }; $('attachment-draft').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)}MB`;
  $('attachment-draft').hidden = false; $('clear-attachment').hidden = false;
};
$('send-form').onsubmit = async event => {
  event.preventDefault(); if (sending || !connected || !selectedAccount || !selectedThread) return;
  const id = selectedAccount, jid = selectedThread, text = $('text').value, draft = attachmentDraft, epoch = authEpoch;
  if (!text.trim() && !draft) return notice('请输入消息或选择附件');
  const existing = messages.some(m => m.jid === jid), phone = draftPhone;
  sending = true; $('send').disabled = true; $('attach-file').disabled = true; $('clear-attachment').disabled = true;
  try {
    if (draft && !draft.uploaded) {
      const query = new URLSearchParams({ name: draft.file.name, mime: draft.file.type || 'application/octet-stream' });
      const result = await api(`/api/accounts/${id}/attachments?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: draft.file });
      draft.uploaded = result.attachment;
    }
    if (epoch !== authEpoch) return;
    await api(`/api/accounts/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(draft ? { attachment: draft.uploaded.id } : {}), ...(existing ? { jid } : { phone }) }) });
    if (epoch === authEpoch && id === selectedAccount && jid === selectedThread) { if ($('text').value === text) $('text').value = ''; if (draft === attachmentDraft) clearAttachment(); }
  } catch (error) { if (epoch === authEpoch) notice(error.message); }
  finally { sending = false; $('send').disabled = !connected || !selectedThread; $('attach-file').disabled = false; $('clear-attachment').disabled = false; }
};
function closePasswordDialog() {
  passwordTarget = null; $('admin-password').value = ''; $('password-result').value = ''; $('password-result-label').hidden = true; $('password-notice').textContent = ''; $('password-dialog').close();
}
$('password-close').onclick = closePasswordDialog;
$('password-dialog').addEventListener('cancel', event => { event.preventDefault(); closePasswordDialog(); });
async function changeUserPassword(reset) {
  if (!passwordTarget) return;
  if (reset && !confirm('生成随机密码并使该用户退出登录？')) return;
  const target = passwordTarget, epoch = authEpoch;
  $('password-save').disabled = true; $('password-reset').disabled = true; $('password-result').value = ''; $('password-result-label').hidden = true;
  try {
    const result = await api(`/api/admin/users/${target}/password`, { method: 'POST', body: JSON.stringify(reset ? { reset: true } : { password: $('admin-password').value }) });
    if (epoch !== authEpoch || target !== passwordTarget) return;
    $('admin-password').value = ''; $('password-notice').textContent = '密码已更新，用户需要重新登录';
    if (reset) { $('password-result').value = result.password; $('password-result-label').hidden = false; }
    await loadAdmin();
  } catch (error) { if (epoch === authEpoch && target === passwordTarget) $('password-notice').textContent = error.message; }
  finally { $('password-save').disabled = false; $('password-reset').disabled = false; }
}
$('password-form').onsubmit = event => { event.preventDefault(); void changeUserPassword(false); };
$('password-reset').onclick = () => { void changeUserPassword(true); };
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
      if (user.id !== me.id) {
        const passwordButton = document.createElement('button'); passwordButton.type = 'button'; passwordButton.className = 'outline'; passwordButton.textContent = '修改 / 重置密码';
        passwordButton.onclick = () => { closePasswordDialog(); passwordTarget = user.id; $('password-title').textContent = `修改密码 · ${user.username}`; $('password-dialog').showModal(); $('admin-password').focus(); };
        form.append(passwordButton);
      }
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
      if (entry.action === 'password_change' || entry.action === 'password_reset') { div.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.target_name || entry.target} · ${entry.action === 'password_reset' ? '随机重置密码' : '修改密码'}`; return div; }
      const detail = JSON.parse(entry.detail); div.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.target_name || entry.target} · ${planNames[detail.plan]} · ${detail.enabled ? '开通 / 更新' : '停用'}${detail.expiresAt ? ` · 到期 ${new Date(detail.expiresAt).toLocaleString()}` : ''}`; return div;
    }));
  } catch (error) { $('admin-notice').textContent = error.message; }
}
$('admin-refresh').onclick = loadAdmin;
setInterval(() => { if (me) void refreshAccounts().catch(error => notice(error.message)); }, 15000);
const bootEpoch = authEpoch;
void api('/api/auth/me').then(result => { if (bootEpoch === authEpoch) return enter(result.user); }).catch(() => { if (bootEpoch === authEpoch) showAuth(); });
