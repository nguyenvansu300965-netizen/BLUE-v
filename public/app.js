const $ = id => document.getElementById(id);
const planNames = { basic: '基础套餐', pro: '高级套餐', vip: 'VIP 套餐' };
const statusNames = { idle: '未连接', connecting: '连接中', qr: '等待扫码', connected: '已连接', disconnected: '重连中', logged_out: '已退出', blocked: '权限受限', error: '连接失败' };
let me = null, accounts = [], selectedAccount = '', selectedThread = '', draftPhone = '', messages = [], stream = null, registration = false, sending = false, connected = false;
let attachmentDraft = null, passwordTarget = null, forwardDraft = null;
let voiceRecorder = null, voiceStream = null, voiceTimer = null, recordingToken = 0;
let contacts = [], seenSnapshot = false, lastReceiverAt = 0, readMarks = new Map(), contactDraft = null;
let soundEnabled = false, notificationAudio = null, lastSoundAt = 0;
let accountsRequest = 0, creatingAccount = false;
let noticeTimer, authEpoch = 0, connectionStatus = 'idle';
function notice(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 6000); }
function closeStream() { stream?.close(); stream = null; }
function showAuth() {
  const hadIdentity = Boolean(me);
  resetChatExtras(); soundEnabled = false; $('notification-sound').textContent = '开启声音'; $('notification-sound').setAttribute('aria-pressed', 'false');
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
  if (name === 'flows') window.dispatchEvent(new Event('flows-opened'));
  if (name === 'chat') { markCurrentRead(); renderChats(); }
  if (name === 'admin') { void loadAdmin(); void loadTransferTemplates(); }
}
function updateMembership(user) {
  me = user;
  $('current-user').textContent = user.username;
  $('user-avatar').textContent = user.username[0].toUpperCase();
  $('nav-admin').hidden = user.role !== 'admin';
  $('subscription-badge').textContent = user.role === 'admin' ? '超级管理员' : planNames[user.plan];
  $('subscription-bar').classList.toggle('pending', !user.active);
  $('subscription-bar').textContent = user.role === 'admin' ? '超级管理员 · 在管理后台为用户开通套餐和订阅' : user.active ? `${planNames[user.plan]} · 最多 ${user.limit} 个号码 · 有效期至 ${new Date(user.expiresAt).toLocaleString()}` : '账号待开通、已停用或订阅已到期，请联系超级管理员开通使用权限。';
  for (const id of ['add-account', 'open-device', 'remove-account']) $(id).hidden = user.role !== 'admin';
  $('sync-messages').hidden = false;
  if (user.role !== 'admin') $('device-dialog').close();
  $('add-account').disabled = user.role !== 'admin';
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
  const currentAccount = accounts.find(a => a.id === selectedAccount);
  $('remove-account').disabled = !accounts.length || Boolean(currentAccount?.managed);
  $('open-device').hidden = me?.role !== 'admin' || Boolean(currentAccount?.managed);
  $('remove-account').hidden = me?.role !== 'admin' || Boolean(currentAccount?.managed);
  return true;
}
async function enter(user) {
  showAuth(); authEpoch++;
  me = user; updateMembership(user); $('auth-screen').hidden = true; $('workspace').hidden = false; $('password').value = ''; showPage('chat');
  await refreshAccounts();
  if (!selectedAccount) window.dispatchEvent(new Event('account-changed'));
}
function switchAccount() {
  const managed = Boolean(accounts.find(a => a.id === selectedAccount)?.managed);
  $('open-device').hidden = me?.role !== 'admin' || managed; $('remove-account').hidden = me?.role !== 'admin' || managed;
  resetChatExtras();
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
  $('open-device').hidden = me?.role !== 'admin' || Boolean(state.account.managed); $('remove-account').hidden = me?.role !== 'admin' || Boolean(state.account.managed);
  connectionStatus = state.status;
  const oldIds = new Set(messages.map(m => m.id));
  const newMessages = (state.messages || []).filter(m => !oldIds.has(m.id) && !m.outgoing && !m.revoked && m.time > Date.now() - 120000);
  const liveArrival = seenSnapshot && (state.receiver?.lastMessageAt || 0) > lastReceiverAt && state.sync?.status !== 'syncing';
  lastReceiverAt = state.receiver?.lastMessageAt || 0; seenSnapshot = true;
  contacts = (state.contacts || []).map(c => ({ ...c, readAt: Math.max(c.readAt || 0, readMarks.get(c.jid) || 0) }));
  connected = state.status === 'connected'; messages = state.messages;
  if (liveArrival && newMessages.some(m => !(m.jid === selectedThread && viewingChat()))) playNotification();
  markCurrentRead();
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
  return [...map.values()].map(thread => {
    const contact = contacts.find(c => c.jid === thread.jid);
    const wsName = contact?.name || thread.name;
    const phone = contact?.phone || /^([1-9]\d{6,14})@s\.whatsapp\.net$/.exec(thread.jid)?.[1] || '';
    const readAt = Math.max(contact?.readAt || 0, readMarks.get(thread.jid) || 0);
    return { ...thread, wsName, name: contact?.remark || wsName, phone, remark: contact?.remark || '', unread: messages.filter(m => m.jid === thread.jid && !m.outgoing && !m.revoked && m.time > readAt).length };
  }).sort((a, b) => b.last.time - a.last.time);
}
function renderChats() {
  const previousScroll = $('chat-list').scrollTop;
  const filter = $('chat-search').value.toLowerCase();
  const list = threads().filter(t => `${t.name} ${t.wsName} ${t.phone} ${t.jid} ${t.last.text}`.toLowerCase().includes(filter));
  $('chat-list').replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-list'; empty.textContent = !selectedAccount ? (me?.role === 'admin' ? '请在号码管理页添加并分配 WhatsApp 号码。' : '暂无可用号码，请联系管理员分配号码或检查订阅。') : '还没有会话。连接号码后接收消息，或点击 ＋ 开始新会话。'; $('chat-list').append(empty);
  }
  for (const thread of list) {
    const button = document.createElement('button'); button.className = `chat-item${thread.jid === selectedThread ? ' active' : ''}${thread.unread ? ' has-unread' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = thread.name[0];
    const copy = document.createElement('span'); copy.className = 'chat-copy';
    const top = document.createElement('span'); top.className = 'chat-top';
    const name = document.createElement('strong'); name.textContent = thread.name;
    const time = document.createElement('time'); time.textContent = new Date(thread.last.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const preview = document.createElement('span'); preview.className = 'chat-preview'; preview.textContent = `${thread.last.outgoing ? '你：' : ''}${thread.last.text}`;
    const details = document.createElement('span'); details.className = 'chat-contact-details';
    details.textContent = `${thread.remark ? `${thread.wsName} · ` : ''}${thread.phone ? `+${thread.phone}` : thread.jid.endsWith('@g.us') ? '群聊' : '手机号待解析'}`;
    if (thread.unread) { const badge = document.createElement('span'); badge.className = 'unread-badge'; badge.textContent = thread.unread > 99 ? '99+' : String(thread.unread); badge.setAttribute('aria-label', `${thread.unread} 条未读消息`); top.append(badge); }
    top.prepend(name, time); copy.append(top, details, preview); button.append(avatar, copy);
    button.onclick = () => { if (selectedThread !== thread.jid) clearAttachment(); selectedThread = thread.jid; $('page-chat').classList.add('chat-open'); markCurrentRead(); renderChats(); renderMessages(); };
    $('chat-list').append(button);
  }
  $('chat-list').scrollTop = previousScroll;
}
function renderMessages() {
  const thread = threads().find(t => t.jid === selectedThread);
  $('edit-contact').disabled = !thread; $('close-chat').disabled = !selectedThread;
  $('chat-name').textContent = thread?.name || 'BLUE-v 网页工作台';
  $('chat-subtitle').textContent = thread ? `${thread.phone ? `+${thread.phone}` : thread.jid.endsWith('@g.us') ? '群聊' : '手机号待解析'}${thread.remark ? ` · ${thread.wsName}` : ''} · ${connected ? '当前号码已连接' : '当前号码未连接'} · 手机上点此返回会话列表` : '选择一个号码和会话，开始聊天';
  $('chat-avatar').textContent = thread?.name[0] || 'B';
  $('send').disabled = !connected || !selectedThread || sending;
  const area = $('messages');
  if (!selectedThread) {
    area.innerHTML = '<div class="chat-welcome"><div class="welcome-icon">☏</div><h2>让沟通更进一步</h2><p>添加 WhatsApp 号码，扫码关联设备<br>在这里接收客户消息、配置自动回复。</p><small>仅限本人或获授权的 WhatsApp 账号</small></div>';
    if (me?.role !== 'admin') area.querySelector('p').innerHTML = selectedAccount ? '选择左侧会话开始聊天，或点击 ＋ 新建聊天。<br>号码连接及管理请联系管理员。' : '请联系管理员分配并连接 WhatsApp 号码。<br>开通后可在这里聊天、配置自动回复。';
    return;
  }
  const previousScroll = area.scrollTop;
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  area.replaceChildren();
  let day = '';
  for (const message of messages.filter(m => m.jid === selectedThread)) {
    const date = new Date(message.time).toLocaleDateString();
    if (date !== day) { const label = document.createElement('div'); label.className = 'day-label'; label.textContent = date; area.append(label); day = date; }
    const bubble = document.createElement('div'); bubble.className = `bubble${message.outgoing ? ' outgoing' : ''}`;
    const text = document.createElement('div'); text.className = 'bubble-text'; text.textContent = message.text;
    const time = document.createElement('span'); time.className = 'bubble-time'; time.textContent = `${message.automatic ? '自动回复 · ' : ''}${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (message.outgoing && !message.revoked) time.append(receiptIndicator(message));
    const imageUrl = /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(message.image || '') ? `/api/accounts/${selectedAccount}/media/${message.image}` : /^data:image\/(jpeg|png|webp);base64,/.test(message.thumbnail || '') ? message.thumbnail : null;
    if (imageUrl && !message.attachment) {
      const image = document.createElement('img'); image.className = 'message-image'; image.src = imageUrl; image.alt = '消息缩略图'; image.loading = 'lazy';
      image.onerror = () => { image.hidden = true; };
      bubble.append(image);
    }
    if (/^[a-f0-9]{32}$/.test(message.attachment?.id || '')) {
      const item = message.attachment, url = `/api/accounts/${selectedAccount}/attachments/${item.id}`;
      if (['image', 'video', 'audio'].includes(item.type)) {
        const media = document.createElement(item.type === 'image' ? 'img' : item.type);
        media.className = item.type === 'image' ? 'message-image' : 'message-media'; media.src = url;
        if (item.type === 'image') { media.alt = item.name; media.loading = 'lazy'; } else { media.controls = true; media.preload = 'metadata'; }
        if (item.type === 'image') { const full = document.createElement('a'); full.href = url; full.target = '_blank'; full.rel = 'noopener'; full.title = '点击查看原图'; full.append(media); bubble.append(full); } else bubble.append(media);
      }
      const link = document.createElement('a'); link.href = `${url}?download=1`; link.textContent = `下载 ${item.name}`; link.className = 'message-download'; bubble.append(link);
    }
    if (message.media && !message.attachment) {
      const load = document.createElement('button'); load.type = 'button'; load.className = 'outline load-message-media';
      load.textContent = message.media.type === 'image' ? '加载原图' : message.media.type === 'ptt' || message.media.type === 'audio' ? '加载语音/音频' : message.media.type === 'video' ? '加载视频' : '加载文件';
      if (message.media.size > 20 * 1024 * 1024) { load.textContent = '媒体超过 20MB，请在手机查看'; load.disabled = true; }
      load.onclick = async () => {
        const owner = me?.id, epoch = authEpoch, account = selectedAccount;
        load.disabled = true; load.textContent = '正在下载…';
        try {
          const result = await api(`/api/accounts/${account}/messages/${encodeURIComponent(message.id)}/media`, { method: 'POST' });
          if (epoch !== authEpoch || owner !== me?.id || account !== selectedAccount) return;
          messages = messages.map(item => item.id === message.id ? result.message : item); renderMessages();
        } catch (error) { if (epoch === authEpoch && owner === me?.id && account === selectedAccount) { load.disabled = false; load.textContent = '下载失败，点击重试'; notice(error.message); } }
      };
      bubble.append(load);
    }
    if (!message.attachment || !['[图片]', '[语音]', '[音频]', '[视频]', '[文件]', '[贴图]'].includes(message.text)) bubble.append(text);
    if (message.buttons?.length) {
      const choices = document.createElement('div'); choices.className = 'message-choices'; choices.setAttribute('aria-label', '消息中的选项');
      for (const option of message.buttons) { const label = document.createElement('span'); label.textContent = option.label; choices.append(label); }
      bubble.append(choices);
    }
    if (!message.revoked) {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      const forward = document.createElement('button'); forward.type = 'button'; forward.className = 'quiet'; forward.textContent = '转发'; forward.disabled = !connected;
      forward.onclick = () => openForward(message); actions.append(forward);
      if (message.outgoing) {
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'quiet'; revoke.textContent = '撤回'; revoke.disabled = !connected;
        revoke.onclick = async () => {
          if (!confirm('撤回这条消息？对方将无法再在聊天中查看。')) return;
          const epoch = authEpoch, account = selectedAccount; revoke.disabled = true;
          try {
            await api(`/api/accounts/${account}/messages/${encodeURIComponent(message.id)}/revoke`, { method: 'POST' });
            if (epoch !== authEpoch || account !== selectedAccount) return;
            messages = messages.map(m => m.id === message.id ? { id: m.id, jid: m.jid, name: m.name, outgoing: m.outgoing, time: m.time, text: '此消息已撤回', revoked: true } : m); renderChats(); renderMessages();
          } catch (error) { if (epoch === authEpoch && account === selectedAccount) { revoke.disabled = false; notice(error.message); } }
        }; actions.append(revoke);
      }
      bubble.append(actions);
    }
    bubble.append(time); area.append(bubble);
  }
  area.scrollTop = nearBottom ? area.scrollHeight : previousScroll;
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
$('add-account').onclick = () => { if (me?.role === 'admin') { showPage('admin'); $('admin-add-number').click(); } };
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
  cancelRecording();
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
  event.preventDefault(); if (voiceRecorder || voiceStream) return notice('请先停止录音'); if (sending || !connected || !selectedAccount || !selectedThread) return;
  const id = selectedAccount, jid = selectedThread, text = $('text').value, draft = attachmentDraft, epoch = authEpoch;
  if (!text.trim() && !draft) return notice('请输入消息或选择附件');
  const existing = messages.some(m => m.jid === jid), phone = draftPhone;
  sending = true; $('send').disabled = true; $('attach-file').disabled = true; $('clear-attachment').disabled = true;
  try {
    if (draft && !draft.uploaded) {
      const query = new URLSearchParams({ name: draft.file.name, mime: draft.file.type.split(';')[0] || 'application/octet-stream' });
      const result = await api(`/api/accounts/${id}/attachments?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: draft.file });
      draft.uploaded = result.attachment;
    }
    if (epoch !== authEpoch) return;
    await api(`/api/accounts/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(draft ? { attachment: draft.uploaded.id, voice: Boolean(draft.voice) } : {}), ...(existing ? { jid } : { phone }) }) });
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
$('nav-flows').onclick = () => { if (!selectedAccount && me?.role !== 'admin') return notice('请先选择可用号码，再配置自动回复'); showPage('flows'); };
$('nav-admin').onclick = () => showPage('admin');
function localDate(iso) { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function loadAdmin() {
  const epoch = authEpoch;
  try {
    const result = await api('/api/admin/users');
    if (epoch !== authEpoch || me?.role !== 'admin') return; void loadNumberPool(result.users); $('admin-users').replaceChildren();
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
      const limit = document.createElement('input'); limit.type = 'number'; limit.min = '0'; limit.max = '1000'; limit.step = '1'; limit.required = true; limit.value = user.limit;
      const limitLabel = document.createElement('label'); limitLabel.textContent = '可用号码数量（含已有自有号码）'; limitLabel.append(limit);
      const date = document.createElement('input'); date.type = 'datetime-local'; date.value = localDate(user.expiresAt || Date.now() + 30 * 86400000); date.required = true;
      const dateLabel = document.createElement('label'); dateLabel.textContent = '订阅到期时间（本地时间）'; dateLabel.append(date);
      const button = document.createElement('button'); button.type = 'submit'; button.textContent = '保存授权';
      form.append(enabledLabel, plan, limitLabel, dateLabel, button);
      form.onsubmit = async event => {
        event.preventDefault(); button.disabled = true;
        try {
          await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: enabled.checked, plan: plan.value, limit: Number(limit.value), expiresAt: date.value ? new Date(date.value).toISOString() : null }) });
          $('admin-notice').textContent = `已更新 ${user.username} 的使用权限和订阅`; await loadAdmin();
        } catch (error) { $('admin-notice').textContent = error.message; }
        finally { button.disabled = false; }
      };
      $('admin-users').append(form);
    }
    $('admin-audit').replaceChildren(...result.audit.map(entry => {
      const div = document.createElement('div'); div.className = 'audit-entry';
      if (entry.action === 'password_change' || entry.action === 'password_reset') { div.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.target_name || entry.target} · ${entry.action === 'password_reset' ? '随机重置密码' : '修改密码'}`; return div; }
      const detail = JSON.parse(entry.detail); if (entry.action === 'number_activation') { div.textContent = `${new Date(entry.created_at).toLocaleString()} · 新号码激活 · ${detail.accountId}`; return div; } if (entry.action === 'number_assignment') { div.textContent = `${new Date(entry.created_at).toLocaleString()} · 号码分配 · ${detail.accountId} · ${detail.userId ? entry.target_name : '已收回'}`; return div; } div.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.target_name || entry.target} · ${planNames[detail.plan]}${detail.limit !== null && detail.limit !== undefined ? ` · ${detail.limit}个号码` : ''} · ${detail.enabled ? '开通 / 更新' : '停用'}${detail.expiresAt ? ` · 到期 ${new Date(detail.expiresAt).toLocaleString()}` : ''}`; return div;
    }));
  } catch (error) { $('admin-notice').textContent = error.message; }
}
$('admin-refresh').onclick = loadAdmin;
setInterval(() => { if (me) void refreshAccounts().catch(error => notice(error.message)); }, 15000);
const bootEpoch = authEpoch;
void api('/api/auth/me').then(result => { if (bootEpoch === authEpoch) return enter(result.user); }).catch(() => { if (bootEpoch === authEpoch) showAuth(); });

function closeForward() { forwardDraft = null; $('forward-dialog').close(); $('forward-phone').value = ''; }
function openForward(message) {
  forwardDraft = { id: message.id, account: selectedAccount, epoch: authEpoch };
  $('forward-target').replaceChildren(new Option('输入新号码', ''));
  for (const thread of threads()) $('forward-target').add(new Option(thread.name, thread.jid));
  $('forward-phone').value = ''; $('forward-error').textContent = ''; $('forward-confirm').disabled = false; $('forward-dialog').showModal();
}
$('forward-cancel').onclick = closeForward;
$('forward-dialog').addEventListener('cancel', closeForward);
$('forward-confirm').onclick = async () => {
  const draft = forwardDraft; if (!draft) return;
  $('forward-confirm').disabled = true;
  try {
    const phone = $('forward-phone').value.trim(), jid = $('forward-target').value;
    await api(`/api/accounts/${draft.account}/messages/${encodeURIComponent(draft.id)}/forward`, { method: 'POST', body: JSON.stringify(phone ? { phone } : { jid }) });
    if (draft.epoch !== authEpoch || draft.account !== selectedAccount) return;
    closeForward(); notice('消息已转发');
  } catch (error) { if (draft === forwardDraft) { $('forward-error').textContent = error.message; $('forward-confirm').disabled = false; } }
};
function cancelRecording() {
  recordingToken++; clearTimeout(voiceTimer); voiceTimer = null;
  if (voiceRecorder) { voiceRecorder.onstop = null; if (voiceRecorder.state !== 'inactive') voiceRecorder.stop(); }
  voiceStream?.getTracks().forEach(track => track.stop()); voiceStream = null; voiceRecorder = null;
  $('record-voice').textContent = '🎙'; $('record-voice').setAttribute('aria-label', '录制语音');
}
window.addEventListener('account-changed', () => { cancelRecording(); closeForward(); $('microphone-dialog').close(); $('voice-file').value = ''; });
$('send-video').onclick = () => { if (!connected || !selectedThread || sending) return notice('请先连接号码并选择聊天'); $('video-file').click(); };
$('video-file').onchange = () => {
  const file = $('video-file').files[0]; $('video-file').value = '';
  if (!file) return;
  if (!['video/mp4', 'video/webm'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) return notice('请选择 MP4 或 WebM 视频，最大 20MB');
  clearAttachment(); attachmentDraft = { file, uploaded: null };
  $('attachment-draft').textContent = `视频：${file.name}`; $('attachment-draft').hidden = false; $('clear-attachment').hidden = false;
};
$('record-voice').onclick = async () => {
  if (voiceRecorder?.state === 'recording') { voiceRecorder.stop(); return; }
  if (!connected || !selectedThread || sending) return notice('请先连接号码并选择聊天');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showMicrophoneError({ name: 'UnsupportedError' });
  clearAttachment(); const token = recordingToken, epoch = authEpoch, account = selectedAccount, thread = selectedThread;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== recordingToken || epoch !== authEpoch || account !== selectedAccount || thread !== selectedThread) { stream.getTracks().forEach(t => t.stop()); return; }
    voiceStream = stream;
    const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('浏览器不支持可发送的录音格式，请上传音频文件');
    const chunks = []; let size = 0; const recorder = voiceRecorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); size += event.data.size; if (size > 20 * 1024 * 1024) { cancelRecording(); notice('录音超过 20MB，请重新录制'); } } };
    recorder.onerror = () => { cancelRecording(); notice('录音失败，请重试'); };
    recorder.onstop = () => {
      if (token !== recordingToken) return;
      const valid = epoch === authEpoch && account === selectedAccount && thread === selectedThread;
      cancelRecording(); if (!valid || !size) return;
      const type = mime.split(';')[0], ext = type === 'audio/ogg' ? 'ogg' : type === 'audio/mp4' ? 'm4a' : 'webm';
      const file = new File(chunks, `语音-${Date.now()}.${ext}`, { type });
      attachmentDraft = { file, voice: true, uploaded: null };
      $('attachment-draft').textContent = `语音已录制 · ${(file.size / 1024).toFixed(0)}KB，点击发送`;
      $('attachment-draft').hidden = false; $('clear-attachment').hidden = false;
    };
    recorder.start(1000); $('record-voice').textContent = '■'; $('record-voice').setAttribute('aria-label', '停止录音');
    notice('正在录音，点击 ■ 停止；停止后点击发送'); voiceTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 5 * 60 * 1000);
  } catch (error) { if (token === recordingToken) { cancelRecording(); showMicrophoneError(error); } }
};
window.addEventListener('pagehide', cancelRecording);

function showMicrophoneError(error) {
  const hints = {
    NotFoundError: '未找到可用的麦克风。请连接耳麦或启用系统中的麦克风输入设备后重试。',
    DevicesNotFoundError: '未找到可用的麦克风。请连接耳麦或启用系统中的麦克风输入设备后重试。',
    NotAllowedError: '麦克风访问被拒绝。请在浏览器网站设置及系统隐私设置中允许麦克风。',
    PermissionDeniedError: '麦克风访问被拒绝。请在浏览器网站设置及系统隐私设置中允许麦克风。',
    NotReadableError: '麦克风无法读取，可能被其他程序占用或设备发生故障。请检查后重试。',
    TrackStartError: '麦克风无法读取，可能被其他程序占用或设备发生故障。请检查后重试。',
    OverconstrainedError: '当前麦克风不满足浏览器要求，请更换系统默认输入设备后重试。',
    SecurityError: '浏览器安全设置阻止了录音，请使用 HTTPS 并检查麦克风权限。',
    UnsupportedError: '此浏览器或页面不支持录音，请使用 HTTPS 下的 Chrome、Edge 或 Safari，也可上传语音文件。'
  };
  $('microphone-error').textContent = hints[error.name] || '无法开始录音，请检查麦克风和浏览器权限，或上传已有语音文件。';
  $('microphone-dialog').showModal();
}
$('microphone-close').onclick = () => $('microphone-dialog').close();
$('microphone-retry').onclick = () => { $('microphone-dialog').close(); $('record-voice').click(); };
$('voice-upload').onclick = () => $('voice-file').click();
$('voice-file').onchange = () => {
  const file = $('voice-file').files[0]; $('voice-file').value = '';
  if (!file || !connected || !selectedThread || sending) return;
  const extensions = { ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
  const type = file.type.split(';')[0] || extensions[file.name.split('.').pop().toLowerCase()];
  if (!['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav'].includes(type) || !file.size || file.size > 20 * 1024 * 1024) { $('microphone-error').textContent = '请选择 OGG、WebM、M4A、MP3 或 WAV 音频文件，最大 20MB。'; return; }
  clearAttachment(); attachmentDraft = { file: new File([file], file.name, { type }), voice: true, uploaded: null };
  $('attachment-draft').textContent = `语音：${file.name}，点击发送`; $('attachment-draft').hidden = false; $('clear-attachment').hidden = false; $('microphone-dialog').close();
};

function resetChatExtras() {
  contacts = []; seenSnapshot = false; lastReceiverAt = 0; readMarks = new Map(); contactDraft = null;
  $('contact-dialog').close(); $('contact-remark').value = ''; $('contact-error').textContent = '';
}
function viewingChat() { return !document.hidden && document.hasFocus() && !$('page-chat').hidden && (innerWidth > 650 || $('page-chat').classList.contains('chat-open')); }
function markCurrentRead() {
  if (!me || !selectedAccount || !selectedThread || !viewingChat()) return;
  const unread = messages.filter(m => m.jid === selectedThread && !m.outgoing && !m.revoked);
  if (!unread.length) return;
  const latest = Math.min(Date.now(), Math.ceil(Math.max(...unread.map(m => m.time))));
  const previous = Math.max(readMarks.get(selectedThread) || 0, contacts.find(c => c.jid === selectedThread)?.readAt || 0);
  if (latest <= previous) return;
  const jid = selectedThread, id = selectedAccount, epoch = authEpoch; readMarks.set(jid, latest);
  void api(`/api/accounts/${id}/contacts`, { method: 'PATCH', body: JSON.stringify({ jid, readAt: latest }) }).catch(() => { if (epoch === authEpoch && id === selectedAccount && readMarks.get(jid) === latest) readMarks.delete(jid); });
}
$('close-chat').onclick = event => {
  event.stopPropagation(); clearAttachment(); selectedThread = ''; draftPhone = ''; $('text').value = '';
  $('page-chat').classList.remove('chat-open'); renderChats(); renderMessages();
};
$('edit-contact').onclick = event => {
  event.stopPropagation(); if (!selectedThread) return;
  contactDraft = { jid: selectedThread, account: selectedAccount, epoch: authEpoch };
  $('contact-remark').value = contacts.find(c => c.jid === selectedThread)?.remark || ''; $('contact-error').textContent = ''; $('contact-save').disabled = false; $('contact-dialog').showModal();
};
$('contact-cancel').onclick = () => { contactDraft = null; $('contact-dialog').close(); };
$('contact-dialog').addEventListener('cancel', () => { contactDraft = null; });
$('contact-save').onclick = async () => {
  const draft = contactDraft; if (!draft) return; $('contact-save').disabled = true;
  try {
    const { contact } = await api(`/api/accounts/${draft.account}/contacts`, { method: 'PATCH', body: JSON.stringify({ jid: draft.jid, remark: $('contact-remark').value }) });
    if (draft !== contactDraft || draft.epoch !== authEpoch || draft.account !== selectedAccount) return;
    contacts = contacts.filter(c => c.jid !== contact.jid).concat(contact); $('contact-dialog').close(); contactDraft = null; renderChats(); renderMessages();
  } catch (error) { if (draft === contactDraft) { $('contact-error').textContent = error.message; $('contact-save').disabled = false; } }
};
async function playNotification() {
  if (!soundEnabled || !notificationAudio || Date.now() - lastSoundAt < 1500) return;
  try {
    await notificationAudio.resume(); const oscillator = notificationAudio.createOscillator(), gain = notificationAudio.createGain();
    oscillator.connect(gain); gain.connect(notificationAudio.destination); oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.08, notificationAudio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, notificationAudio.currentTime + 0.2);
    oscillator.start(); oscillator.stop(notificationAudio.currentTime + 0.2); lastSoundAt = Date.now();
  } catch { /* Browsers may suspend audio while in the background; unread markers remain visible. */ }
}
$('notification-sound').onclick = async () => {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return notice('此浏览器不支持声音提醒，仍会显示未读提示');
    notificationAudio ||= new Audio(); await notificationAudio.resume(); soundEnabled = !soundEnabled;
    $('notification-sound').textContent = soundEnabled ? '关闭声音' : '开启声音'; $('notification-sound').setAttribute('aria-pressed', String(soundEnabled));
    if (soundEnabled) { lastSoundAt = 0; void playNotification(); }
  } catch { notice('浏览器阻止了声音，请检查网站声音权限'); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markCurrentRead(); renderChats(); } });
window.addEventListener('focus', () => { markCurrentRead(); renderChats(); });

function receiptIndicator(message) {
  const ack = message.ack;
  const failures = { '-7': '设备版本不兼容', '-6': '消息未激活', '-5': '媒体无法上传', '-4': '媒体过大', '-3': '媒体已不可用', '-2': '消息已过期', '-1': '发送失败' };
  const error = Number.isInteger(ack) && ack < 0 && ack >= -7;
  const label = error ? failures[ack] : ack === 0 ? '等待发送' : ack === 1 ? '已发送，尚未确认送达' : ack === 2 ? '已送达' : ack === 3 ? '已读' : ack === 4 ? '语音已播放' : '回执待同步，可点击同步消息更新';
  const icon = document.createElement('span'); icon.className = `message-receipt${ack === 3 || ack === 4 ? ' read' : ''}${error ? ' failed' : ''}`;
  icon.textContent = error ? '! 发送失败' : ack >= 2 && ack <= 4 ? '✓✓' : ack === 1 ? '✓' : '◷';
  icon.title = `${label}。未送达无法判断是否被拉黑；对方关闭已读回执时可能不显示已读。`;
  icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label);
  return icon;
}
$('receipt-help').onclick = event => { event.stopPropagation(); $('receipt-dialog').showModal(); };
$('receipt-close').onclick = () => $('receipt-dialog').close();

let poolUsers = [], poolDialogId = '', poolPoll = null;
async function loadNumberPool(users = poolUsers) {
  poolUsers = users; const epoch = authEpoch;
  try {
    const result = await api('/api/admin/numbers'); if (epoch !== authEpoch || me?.role !== 'admin') return;
    $('admin-numbers').replaceChildren();
    if (!result.accounts.length) $('admin-numbers').textContent = '暂无托管号码。已有用户自有号码保持原样，不进入此列表。';
    for (const item of result.accounts) {
      const row = document.createElement('div'); row.className = 'admin-user'; row.dataset.numberId = item.id;
      const info = document.createElement('div'); info.className = 'user-name';
      const label = document.createElement('strong'); label.textContent = `${item.label}${item.number ? ` · +${item.number}` : ''}`;
      const detail = document.createElement('small'); detail.textContent = `${statusNames[item.status] || item.status} · ${item.username || '待分配'}${item.managed === 0 ? ' · 原有自有号码' : ''}${!item.allowed ? ' · 订阅或配额受限' : ''}`; info.append(label, detail); row.append(info);
      const select = document.createElement('select'); select.add(new Option('待分配 / 收回', ''));
      for (const user of poolUsers.filter(u => u.role !== 'admin')) { const option = new Option(`${user.username} · ${user.accountCount}/${user.limit}${user.active ? '' : ' · 订阅无效'}`, user.id); option.disabled = !user.active && user.id !== item.userId; select.add(option); }
      select.value = item.userId || ''; select.disabled = item.managed === 0; row.append(select);
      const save = document.createElement('button'); save.textContent = '保存分配'; save.type = 'button'; save.disabled = item.managed === 0;
      save.onclick = async () => {
        if (item.userId !== (select.value || null) && !confirm('变更号码使用人？原用户立即失去访问权限，新用户可查看该号码已有聊天记录和流程。')) return;
        save.disabled = true;
        try { await api(`/api/admin/numbers/${item.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ userId: select.value || null }) }); await loadAdmin(); await refreshAccounts(); }
        catch (error) { notice(error.message); save.disabled = false; }
      }; row.append(save);
      if (item.managed !== 2) {
        const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'outline'; connect.textContent = '扫码 / 连接状态'; connect.onclick = () => openPoolDevice(item); row.append(connect);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet danger'; remove.textContent = '删除号码'; remove.dataset.action = 'delete-number';
      remove.onclick = async () => {
        if (!confirm(`确认删除「${item.label}」${item.username ? `（当前用户：${item.username}）` : ''}？该用户将立即失去访问权限，号码的本地聊天、附件、流程及登录档案都会删除。已使用的激活码不返还。`)) return;
        remove.disabled = true;
        try { await api(`/api/admin/numbers/${item.id}`, { method: 'DELETE' }); await loadAdmin(); await refreshAccounts(); notice('号码已删除，使用权限已撤销'); }
        catch (error) { notice(error.message); remove.disabled = false; }
      }; row.append(remove);
      $('admin-numbers').append(row);
    }
  } catch (error) { if (epoch === authEpoch) $('admin-number-notice').textContent = error.message; }
}
function closeNumberActivation() { $('number-activation-dialog').close(); $('number-activation-code').value = ''; $('number-activation-label').value = ''; $('number-activation-error').textContent = ''; }
$('admin-add-number').onclick = () => {
  if (me?.role !== 'admin') return;
  closeNumberActivation(); $('number-activation-submit').disabled = false; $('number-activation-dialog').showModal(); $('number-activation-label').focus();
};
$('number-activation-cancel').onclick = closeNumberActivation;
$('number-activation-dialog').addEventListener('cancel', closeNumberActivation);
$('number-activation-form').onsubmit = async event => {
  event.preventDefault(); if (me?.role !== 'admin') return;
  const epoch = authEpoch, owner = me.id;
  $('number-activation-submit').disabled = true; $('number-activation-error').textContent = '';
  try {
    const { account } = await api('/api/admin/numbers', { method: 'POST', body: JSON.stringify({ label: $('number-activation-label').value, activationCode: $('number-activation-code').value }) });
    if (epoch !== authEpoch || me?.id !== owner) return;
    closeNumberActivation(); await loadNumberPool(); if (epoch === authEpoch && me?.id === owner) openPoolDevice(account);
  } catch (error) { if (epoch === authEpoch && me?.id === owner) $('number-activation-error').textContent = error.message; }
  finally { if (epoch === authEpoch && me?.id === owner) $('number-activation-submit').disabled = false; }
};
window.addEventListener('account-changed', () => { if (!me || me.role !== 'admin') closeNumberActivation(); });
function closePoolDevice() { poolDialogId = ''; clearTimeout(poolPoll); $('pool-device-dialog').close(); $('pool-qr').removeAttribute('src'); $('pool-qr').hidden = true; }
function openPoolDevice(item) { closePoolDevice(); poolDialogId = item.id; $('pool-device-status').textContent = '正在读取连接状态…'; $('pool-connect').disabled = true; $('pool-device-title').textContent = item.label; $('pool-device-dialog').showModal(); void refreshPoolDevice(); }
async function refreshPoolDevice() {
  const id = poolDialogId, epoch = authEpoch; if (!id || me?.role !== 'admin') return;
  try {
    const state = await api(`/api/admin/numbers/${id}/state`); if (id !== poolDialogId || epoch !== authEpoch) return;
    $('pool-qr').hidden = !state.qr; if (state.qr) $('pool-qr').src = state.qr;
    $('pool-device-status').textContent = `${statusNames[state.status] || state.status}${state.number ? ` · +${state.number}` : ''}${state.error ? ` · ${state.error}` : ''}`;
    $('pool-connect').disabled = state.status === 'connected' || state.status === 'connecting' || state.status === 'qr' || state.managed === 2;
  } catch (error) { if (id === poolDialogId && epoch === authEpoch) $('pool-device-status').textContent = error.message; }
  if (id === poolDialogId && epoch === authEpoch) poolPoll = setTimeout(refreshPoolDevice, 1500);
}
$('pool-sync').onclick = async () => { if (!poolDialogId) return; try { await api(`/api/admin/numbers/${poolDialogId}/sync`, { method: 'POST' }); notice('已开始同步'); } catch (error) { notice(error.message); } };
$('pool-reset').onclick = async () => { if (!poolDialogId || !confirm('重置此号码的登录会话？需要重新扫码。')) return; try { await api(`/api/admin/numbers/${poolDialogId}/logout`, { method: 'POST' }); } catch (error) { notice(error.message); } };
$('pool-device-close').onclick = closePoolDevice;
$('pool-device-dialog').addEventListener('cancel', closePoolDevice);
$('pool-connect').onclick = async () => { const id = poolDialogId; if (!id) return; try { await api(`/api/admin/numbers/${id}/connect`, { method: 'POST' }); } catch (error) { $('pool-device-status').textContent = error.message; } };
window.addEventListener('account-changed', () => { if (!me || me.role !== 'admin') { closePoolDevice(); poolUsers = []; $('admin-numbers').replaceChildren(); $('admin-number-notice').textContent = ''; } });
setInterval(() => { if (me?.role === 'admin' && !$('page-admin').hidden && !$('admin-numbers').contains(document.activeElement)) void loadNumberPool(); }, 15000);

let templateTransfer = null;
async function loadTransferTemplates() {
  const epoch = authEpoch; if (me?.role !== 'admin') return;
  try {
    const { templates } = await api('/api/templates'); if (epoch !== authEpoch || me?.role !== 'admin') return;
    const previous = $('admin-transfer-template').value;
    $('admin-transfer-template').replaceChildren(...templates.map(item => new Option(`${item.name} · v${item.revision}`, item.id)));
    if (templates.some(t => t.id === previous)) $('admin-transfer-template').value = previous;
    $('admin-template-export').disabled = !templates.length;
  } catch (error) { if (epoch === authEpoch) notice(error.message); }
}
function closeTemplateTransfer() { templateTransfer = null; $('template-transfer-dialog').close(); $('template-transfer-code').value = ''; $('template-transfer-file').value = ''; }
function setupTemplateTransfer(mode) {
  closeTemplateTransfer(); if (me?.role !== 'admin') return;
  templateTransfer = { mode, epoch: authEpoch, owner: me.id, name: 'WhatsApp示例' };
  $('template-transfer-title').textContent = mode === 'export' ? '导出示例复制码' : '导入示例复制码';
  $('template-transfer-help').textContent = mode === 'export' ? '仅包含已保存的公共示例。复制到另一台服务器导入，或下载文件。图片较多时建议使用文件。' : '粘贴另一台服务器导出的BLUEFLOW1复制码，或上传示例文件。导入会新建示例，不覆盖已有内容，不自动启用号码流程。';
  $('template-transfer-code').readOnly = mode === 'export'; $('template-transfer-error').textContent = '';
  for (const id of ['template-transfer-copy', 'template-transfer-download']) { $(id).hidden = mode !== 'export'; $(id).disabled = true; }
  for (const id of ['template-transfer-upload', 'template-transfer-import']) { $(id).hidden = mode !== 'import'; $(id).disabled = false; }
  $('template-transfer-dialog').showModal(); return templateTransfer;
}
window.openTemplateExport = async id => {
  if (!id) return notice('请先选择一个已保存的示例');
  const context = setupTemplateTransfer('export'); if (!context) return;
  $('template-transfer-help').textContent = '正在打包示例和图片…';
  try {
    const result = await api(`/api/admin/templates/${encodeURIComponent(id)}/export`);
    if (context !== templateTransfer || context.epoch !== authEpoch || context.owner !== me?.id) return;
    context.name = result.name; $('template-transfer-code').value = result.code;
    $('template-transfer-help').textContent = `${result.name}：已包含文案、按钮分支和图片。图片较多时建议下载文件。`;
    $('template-transfer-copy').disabled = false; $('template-transfer-download').disabled = false;
  } catch (error) { if (context === templateTransfer) $('template-transfer-error').textContent = error.message; }
};
window.openTemplateImport = () => setupTemplateTransfer('import');
$('admin-template-export').onclick = () => window.openTemplateExport($('admin-transfer-template').value);
$('admin-template-import').onclick = window.openTemplateImport;
$('template-transfer-close').onclick = closeTemplateTransfer;
$('template-transfer-dialog').addEventListener('cancel', closeTemplateTransfer);
$('template-transfer-copy').onclick = async () => {
  const context = templateTransfer, code = $('template-transfer-code').value; if (!code) return;
  try { await navigator.clipboard.writeText(code); if (context === templateTransfer) $('template-transfer-error').textContent = '复制成功，可到另一台服务器导入。'; }
  catch { if (context === templateTransfer) { $('template-transfer-code').select(); $('template-transfer-error').textContent = '浏览器未允许自动复制，请手动复制选中文本，或下载示例文件。'; } }
};
$('template-transfer-download').onclick = () => {
  if (!templateTransfer || !$('template-transfer-code').value) return;
  const url = URL.createObjectURL(new Blob([$('template-transfer-code').value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${templateTransfer.name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').slice(0, 80)}.blueflow`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
};
$('template-transfer-upload').onclick = () => $('template-transfer-file').click();
$('template-transfer-file').onchange = async () => {
  const file = $('template-transfer-file').files[0], context = templateTransfer; $('template-transfer-file').value = ''; if (!file || !context) return;
  if (file.size > 22 * 1024 * 1024) { $('template-transfer-error').textContent = '示例文件最大22MB'; return; }
  try { const code = await file.text(); if (context === templateTransfer) $('template-transfer-code').value = code; }
  catch { if (context === templateTransfer) $('template-transfer-error').textContent = '无法读取文件，请重试'; }
};
$('template-transfer-import').onclick = async () => {
  const context = templateTransfer; if (!context || context.mode !== 'import') return;
  $('template-transfer-import').disabled = true; $('template-transfer-error').textContent = '';
  try {
    const result = await api('/api/admin/templates/import', { method: 'POST', body: JSON.stringify({ code: $('template-transfer-code').value }) });
    if (context !== templateTransfer || context.epoch !== authEpoch || context.owner !== me?.id) return;
    closeTemplateTransfer(); await loadTransferTemplates(); window.dispatchEvent(new Event('templates-transferred')); notice(`已导入示例：${result.template.name}`);
  } catch (error) { if (context === templateTransfer) { $('template-transfer-error').textContent = error.message; $('template-transfer-import').disabled = false; } }
};
window.addEventListener('account-changed', () => { if (!me || me.role !== 'admin') { closeTemplateTransfer(); $('admin-transfer-template').replaceChildren(); } });
