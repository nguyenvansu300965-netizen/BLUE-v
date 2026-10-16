(() => {
  const el = id => document.getElementById(id);
  let config = { enabled: false, mode: 'numbered', triggerMode: 'keywords', nodes: [] };
  let busy = false;
  let base = null;
  let loadVersion = 0;
  const status = text => { el('flow-notice').textContent = text; };
  const field = (label, input) => { const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(label), input); return wrapper; };
  function input(value, change, multiline = false) {
    const e = document.createElement(multiline ? 'textarea' : 'input'); e.value = value; e.addEventListener('input', () => change(e.value)); return e;
  }
  function button(label, action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = label; b.onclick = action; return b; }
  function newNode() { return { id: crypto.randomUUID(), name: '新回复节点', triggers: [], text: '', image: '', options: [] }; }
  function draw() {
    el('flow-enabled').checked = config.enabled; el('flow-mode').value = config.mode;
    el('flow-nodes').replaceChildren(...config.nodes.map((node, index) => {
      const card = document.createElement('div'); card.className = 'flow-node';
      const head = document.createElement('div'); head.className = 'section-title';
      const title = document.createElement('strong'); title.textContent = index === 0 ? '入口节点 · 流程起点' : `回复节点 ${index} · 由按钮进入`;
      head.append(title, button('删除节点', () => {
        if (config.nodes.some(n => n.options.some(o => o.next === node.id))) return status('请先移除其他节点指向此节点的选项');
        config.nodes.splice(index, 1); draw();
      }));
      card.append(head, field('节点名称', input(node.name, v => { node.name = v; })));
      if (index === 0) {
        const triggerMode = document.createElement('select'); triggerMode.id = 'flow-trigger-mode';
        for (const [value, text] of [['keywords', '关键词触发'], ['any', '任意内容触发']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; triggerMode.append(option); }
        triggerMode.value = config.triggerMode || 'keywords'; triggerMode.onchange = () => { config.triggerMode = triggerMode.value; draw(); };
        card.append(field('入口触发方式', triggerMode));
        if (config.triggerMode !== 'any') card.append(field('入口触发词（逗号分隔）', input(node.triggers.join(', '), v => { node.triggers = v.split(/[,，]/).map(t => t.trim()).filter(Boolean); })));
        const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = '客户没有进行中的流程时，按此方式进入；原生按钮模式只接受点击，兼容模式可回复序号或选项文字。'; card.append(hint);
      } else {
        node.triggers = [];
        const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = '通过前面节点的按钮进入此回复，不设置触发词。'; card.append(hint);
      }
      card.append(field('回复文案', input(node.text, v => { node.text = v; }, true)));
      const variables = document.createElement('p'); variables.className = 'muted';
      variables.textContent = '可用变量：{full_name} 对方 WhatsApp 名称，{phone_number} 含国家区号的手机号。例如：Dear user {full_name}, hello! {phone_number}。支持文字和图片文案。名称不可用时显示号码；号码无法识别时显示“未知号码”。'; card.append(variables);

      const image = document.createElement('img'); image.className = 'flow-image'; image.hidden = !node.image; if (node.image) image.src = `${base}/media/${node.image}`;
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp';
      file.onchange = async () => {
        const upload = file.files[0]; if (!upload) return;
        if (upload.size > 5 * 1024 * 1024) return status('图片最大 5MB');
        const uploadBase = base, version = loadVersion;
        busy = true; el('flow-save').disabled = true; status('正在上传图片…');
        try {
          const response = await fetch(`${uploadBase}/media`, { method: 'POST', headers: { 'Content-Type': upload.type }, body: upload });
          const result = await response.json(); if (!response.ok) throw new Error(result.error);
          if (version !== loadVersion) return;
          node.image = result.id; image.src = `${base}/media/${node.image}`; image.hidden = false; status('图片已上传，保存流程后生效');
        } catch (error) { if (version === loadVersion) status(error.message); }
        finally { busy = false; if (version === loadVersion) el('flow-save').disabled = !base; }
      };
      card.append(field('回复图片（可选，最大 5MB）', file), image, button('移除图片', () => { node.image = ''; image.hidden = true; }));
      const options = document.createElement('div'); options.className = 'flow-options';
      node.options.forEach((option, i) => {
        const row = document.createElement('div'); row.className = 'flow-option';
        const name = input(option.label, v => { option.label = v; }); name.placeholder = '按钮 / 选项名称'; name.maxLength = 20;
        const select = document.createElement('select');
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择回复节点'; select.append(placeholder);
        for (const n of config.nodes) { const o = document.createElement('option'); o.value = n.id; o.textContent = n.name; select.append(o); }
        select.value = option.next; select.onchange = () => { option.next = select.value; };
        row.append(name, select, button('移除', () => { node.options.splice(i, 1); draw(); })); options.append(row);
      });
      card.append(options);
      if (node.options.length < 3) card.append(button('＋ 添加选项（最多 3 个）', () => { node.options.push({ label: '', next: '' }); draw(); }));
      return card;
    }));
  }
  el('flow-enabled').onchange = e => { config.enabled = e.target.checked; };
  el('flow-mode').onchange = e => { config.mode = e.target.value; };
  el('flow-add').onclick = () => { if (config.nodes.length >= 50) return status('最多 50 个节点'); config.nodes.push(newNode()); draw(); };
  async function loadTemplates(version = loadVersion) {
    const data = await window.workspaceApi('/api/templates');
    if (version !== loadVersion) return;
    const select = el('flow-template'), previous = select.value;
    select.replaceChildren(...data.templates.map(item => { const o = document.createElement('option'); o.value = item.id; o.textContent = item.name; return o; }));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    templateControls();
  }
  function templateControls() {
    const admin = Boolean(base && window.isSuperAdmin());
    for (const id of ['template-new', 'template-update', 'template-delete']) el(id).hidden = !admin;
    const missing = !el('flow-template').value;
    el('template-update').disabled = missing; el('template-delete').disabled = missing;
    el('flow-example').disabled = !base || missing;
  }
  el('flow-template').onchange = templateControls;
  el('flow-example').onclick = async () => {
    if (!base || (config.nodes.length && !confirm('载入示例将替换当前编辑内容，是否继续？'))) return;
    const version = loadVersion, selected = el('flow-template').value;
    try {
      const result = await window.workspaceApi(`${base}/templates/${encodeURIComponent(selected)}/load`, { method: 'POST' });
      if (version !== loadVersion) return;
      config = result; draw(); status('示例已载入，请修改内容后启用并保存；管理员可另存或更新示例');
    } catch (error) { if (version === loadVersion) status(error.message); }
  };
  async function saveTemplate(update) {
    if (!base || busy) return;
    const select = el('flow-template');
    const name = prompt('示例名称', update ? select.selectedOptions[0]?.textContent : '新示例');
    if (!name?.trim()) return;
    const version = loadVersion;
    busy = true;
    try {
      const result = await window.workspaceApi(`${base}/templates`, { method: 'POST', body: JSON.stringify({ name, config, ...(update ? { id: select.value } : {}) }) });
      if (version !== loadVersion) return;
      await loadTemplates(version); if (version !== loadVersion) return;
      select.value = result.id; templateControls(); status('示例已保存，所有用户均可选择载入；当前号码流程需另行保存');
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { busy = false; }
  }
  el('template-new').onclick = () => saveTemplate(false);
  el('template-update').onclick = () => saveTemplate(true);
  el('template-delete').onclick = async () => {
    if (!confirm('删除所选示例？已载入的号码流程不受影响。')) return;
    const version = loadVersion;
    try {
      await window.workspaceApi(`/api/admin/templates/${encodeURIComponent(el('flow-template').value)}`, { method: 'DELETE' });
      if (version !== loadVersion) return;
      await loadTemplates(version); status('示例已删除');
    } catch (error) { if (version === loadVersion) status(error.message); }
  };
  el('flow-save').onclick = async () => {
    if (busy || !base) return;
    const saveBase = base, version = loadVersion;
    el('flow-save').disabled = true;
    try {
      const response = await fetch(`${saveBase}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (version === loadVersion) status('流程已保存，立即生效');
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { if (version === loadVersion) el('flow-save').disabled = !base; }
  };
  async function load() {
    const version = ++loadVersion;
    base = window.flowBase();
    config = { enabled: false, mode: 'numbered', triggerMode: 'keywords', nodes: [] };
    el('flow-nodes').replaceChildren();
    el('flow-notice').textContent = '';
    for (const id of ['flow-save', 'flow-add', 'flow-example', 'flow-enabled', 'flow-mode']) el(id).disabled = !base;
    templateControls();
    if (!base) { el('flow-template').replaceChildren(); return; }
    try {
      await loadTemplates(version);
      if (version !== loadVersion) return;
      const data = await window.workspaceApi(`${base}/flows`);
      if (version !== loadVersion) return;
      config = data; draw();
    } catch (error) { if (version === loadVersion) { status(error.message); el('flow-save').disabled = true; } }
  }
  window.addEventListener('account-changed', () => { void load(); });
  void load();
})();
