const $ = id => document.getElementById(id);
const labels = { idle: '未连接', connecting: '正在连接', qr: '等待扫码', connected: '已连接', disconnected: '重新连接中', logged_out: '已退出', error: '连接失败' };
let sending = false, connected = false;
function render(state) {
  if (state.automation) {
    const last = state.automation.last;
    $('flow-status').textContent = `${state.automation.enabled ? '已启用' : '未启用'}${last ? ` · ${last.node}：${last.ok ? '已发送' : '发送失败，请检查连接'}` : ''}`;
  }
  connected = state.status === 'connected';
  $('status').textContent = labels[state.status] || state.status;
  $('status').classList.toggle('online', connected);
  $('qr').hidden = !state.qr;
  if (state.qr) $('qr').src = state.qr;
  document.querySelector('.qr-placeholder').hidden = Boolean(state.qr) || connected;
  $('connection-hint').textContent = connected ? '✓ 设备已连接，可以开始收发消息' : state.qr ? '使用手机 WhatsApp 扫码登录' : state.status === 'connecting' ? '正在向 WhatsApp 请求二维码…' : '点击下方按钮，生成登录二维码';
  $('account').textContent = state.user ? `当前账号：${state.user.name || state.user.id}` : '';
  $('connect').disabled = connected || ['connecting', 'qr'].includes(state.status);
  $('send').disabled = !connected || sending;
  $('notice').textContent = state.error || '';
  $('count').textContent = `${state.messages.length} 条`;
  const list = $('messages');
  if (!state.messages.length) { list.innerHTML = '<div class="empty">你的下一段对话，从这里开始。<small>连接账号后，新收到的消息会实时显示。</small></div>'; return; }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.replaceChildren(...state.messages.map(msg => {
    const item = document.createElement('article'); item.className = `message${msg.outgoing ? ' outgoing' : ''}`;
    const head = document.createElement('div'); head.className = 'message-head';
    const name = document.createElement('span'); name.textContent = `${msg.outgoing ? '发送至' : '来自'} ${msg.name || msg.jid}`;
    const time = document.createElement('span'); time.textContent = new Date(msg.time).toLocaleTimeString();
    head.append(name, time);
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = msg.text;
    item.append(head, text);
    if (!msg.outgoing && /@s\.whatsapp\.net$/.test(msg.jid)) item.addEventListener('click', () => { $('phone').value = msg.jid.split('@')[0]; $('text').focus(); });
    return item;
  }));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
async function api(endpoint, body = {}) {
  const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function notice(error) { $('notice').textContent = error.message; }
$('connect').onclick = () => api('connect').catch(notice);
$('logout').onclick = () => { if (confirm('确定退出并清除当前登录会话吗？')) api('logout').catch(notice); };
$('send-form').onsubmit = async event => {
  event.preventDefault(); sending = true; $('send').disabled = true;
  try { await api('messages', { phone: $('phone').value, text: $('text').value }); $('text').value = ''; $('notice').textContent = '消息已发送'; }
  catch (error) { notice(error); }
  finally { sending = false; $('send').disabled = !connected; }
};
const events = new EventSource('/api/events');
events.onmessage = event => render(JSON.parse(event.data));
events.onerror = () => { connected = false; $('send').disabled = true; $('notice').textContent = '工作台连接中断，正在重新连接…'; };
