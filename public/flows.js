(() => {
  const el = id => document.getElementById(id);
  let config = { enabled: false, mode: 'numbered', triggerMode: 'keywords', nodes: [] };
  let busy = false;
  let ready = false;
  let editorTemplate = null;
  let base = null;
  let loadVersion = 0;
  const mediaBase = () => editorTemplate || (!base && window.isSuperAdmin()) ? '/api/admin/template-assets' : base;
  const status = text => { el('flow-notice').textContent = text; };
  const field = (label, input) => { const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(label), input); return wrapper; };
  function input(value, change, multiline = false) {
    const e = document.createElement(multiline ? 'textarea' : 'input'); e.value = value; e.addEventListener('input', () => change(e.value)); return e;
  }
  function button(label, action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = label; b.onclick = action; return b; }
  function newNode() { return { id: crypto.randomUUID(), name: '新回复节点', triggers: [], text: '', image: '', options: [] }; }
  function draw() {
    templateControls();
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

      const image = document.createElement('img'); image.className = 'flow-image'; image.hidden = !node.image; if (node.image) image.src = `${mediaBase()}/media/${node.image}`;
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp';
      file.onchange = async () => {
        const upload = file.files[0]; if (!upload) return;
        if (busy) return status('正在处理，请等待完成后再上传');
        if (upload.size > 5 * 1024 * 1024) return status('图片最大 5MB');
        const uploadBase = mediaBase(), version = loadVersion;
        busy = true; templateControls(); status('正在上传图片…');
        try {
          const result = await window.workspaceApi(`${uploadBase}/media`, { method: 'POST', headers: { 'Content-Type': upload.type }, body: upload });
          if (version !== loadVersion) return;
          node.image = result.id; image.src = `${mediaBase()}/media/${node.image}`; image.hidden = false; status(editorTemplate ? '图片已上传，请保存公共示例' : '图片已上传，保存流程后生效');
        } catch (error) { if (version === loadVersion) status(error.message); }
        finally { if (version === loadVersion) { busy = false; templateControls(); } }
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
    select.replaceChildren(...data.templates.map(item => { const o = document.createElement('option'); o.value = item.id; o.textContent = `${item.name} · v${item.revision}`; return o; }));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    templateControls();
  }
  function templateControls() {
    const admin = window.isSuperAdmin();
    for (const id of ['template-new', 'template-update', 'template-delete', 'template-use', 'template-export-code', 'template-import-code']) el(id).hidden = !admin;
    const unavailable = (!base && !admin) || !ready || busy, missing = !el('flow-template').value;
    for (const id of ['flow-save', 'flow-add', 'flow-mode', 'flow-template', 'template-new', 'template-exit']) el(id).disabled = unavailable;
    el('flow-nodes').inert = unavailable;
    el('template-name').disabled = unavailable;
    el('flow-enabled').disabled = unavailable || Boolean(editorTemplate) || !base;
    el('template-update').disabled = unavailable || !editorTemplate?.id;
    el('template-delete').disabled = unavailable || missing;
    el('flow-example').disabled = unavailable || missing;
    el('template-use').disabled = unavailable || missing || !base;
    el('template-exit').hidden = !editorTemplate || !base;
    el('template-editor').hidden = !editorTemplate;
    el('flow-save').textContent = editorTemplate ? (editorTemplate.id ? '保存公共示例' : '保存为新示例') : '保存号码流程';
    el('flow-example').textContent = admin ? '载入并编辑示例' : '载入示例';
    if (editorTemplate) el('template-editor-title').textContent = `公共示例：${editorTemplate.name} · v${editorTemplate.revision}`;
  }
  el('flow-template').onchange = templateControls;
  el('template-export-code').onclick = () => window.openTemplateExport(el('flow-template').value);
  el('template-import-code').onclick = () => window.openTemplateImport();
  window.addEventListener('templates-transferred', () => { if (base || window.isSuperAdmin()) void loadTemplates().catch(error => status(error.message)); });
  async function loadExample(editShared) {
    if ((!base && !window.isSuperAdmin()) || !ready || busy || (config.nodes.length && !confirm('载入示例将替换当前编辑内容，是否继续？'))) return;
    const version = ++loadVersion, selected = el('flow-template').value, loadBase = base;
    busy = true; templateControls();
    try {
      const result = editShared ? await window.workspaceApi(`/api/admin/templates/${encodeURIComponent(selected)}`).then(item => ({ template: item, config: { ...item.config, enabled: false } })) : await window.workspaceApi(`${loadBase}/templates/${encodeURIComponent(selected)}/load?details=1`, { method: 'POST' });
      if (version !== loadVersion) return;
      editorTemplate = editShared ? result.template : null;
      config = result.config;
      if (editorTemplate) el('template-name').value = editorTemplate.name;
      draw();
      status(editShared ? `已载入公共示例「${result.template.name}」v${result.template.revision}，修改后点击「保存公共示例」` : `已载入「${result.template.name}」v${result.template.revision}，请启用并保存号码流程`);
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { if (version === loadVersion) { busy = false; templateControls(); } }
  }
  el('flow-example').onclick = () => { void loadExample(window.isSuperAdmin()); };
  el('template-use').onclick = () => { void loadExample(false); };
  el('template-exit').onclick = () => { if (confirm('返回当前号码的已保存流程？未保存的示例修改将丢失。')) void load(); };
  async function saveTemplate(update) {
    if ((!base && !window.isSuperAdmin()) || !ready || busy) return status('正在处理，请等待完成后再保存');
    if (update && !editorTemplate?.id) return status('请先载入要编辑的公共示例');
    const name = update ? el('template-name').value : prompt('新示例名称', '新示例');
    if (!name?.trim()) return status('请填写示例名称');
    const version = loadVersion, saveBase = editorTemplate || !base ? '/api/admin' : base, target = editorTemplate;
    const snapshot = structuredClone(config);
    busy = true; templateControls();
    try {
      const result = await window.workspaceApi(`${saveBase}/templates`, { method: 'POST', body: JSON.stringify({ name, config: snapshot, ...(update ? { id: target.id, revision: target.revision } : {}) }) });
      if (version !== loadVersion) return;
      editorTemplate = result; el('template-name').value = result.name;
      const select = el('flow-template');
      let option = [...select.options].find(item => item.value === result.id);
      if (!option) { option = document.createElement('option'); option.value = result.id; select.append(option); }
      option.textContent = `${result.name} · v${result.revision}`; select.value = result.id;
      status(`公共示例「${result.name}」已保存为 v${result.revision}，所有用户下次载入将获得此版本；当前号码流程未更改`);
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { if (version === loadVersion) { busy = false; templateControls(); } }
  }
  el('template-new').onclick = () => saveTemplate(false);
  el('template-update').onclick = () => saveTemplate(true);
  el('template-delete').onclick = async () => {
    if ((!base && !window.isSuperAdmin()) || busy || !ready || !confirm('删除所选示例？已载入的号码流程不受影响。')) return;
    const version = loadVersion, selected = el('flow-template').value;
    busy = true; templateControls();
    try {
      await window.workspaceApi(`/api/admin/templates/${encodeURIComponent(selected)}`, { method: 'DELETE' });
      if (version !== loadVersion) return;
      if (editorTemplate?.id === selected) { busy = false; await load(); return status('示例已删除，已刷新编辑区'); }
      await loadTemplates(version); if (version === loadVersion) status('示例已删除');
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { if (version === loadVersion) { busy = false; templateControls(); } }
  };
  el('flow-save').onclick = async () => {
    if (busy || (!base && !window.isSuperAdmin()) || !ready) return;
    if (editorTemplate) return saveTemplate(Boolean(editorTemplate.id));
    const saveBase = base, version = loadVersion;
    busy = true; templateControls();
    try {
      const response = await fetch(`${saveBase}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (version === loadVersion) status('流程已保存，立即生效');
    } catch (error) { if (version === loadVersion) status(error.message); }
    finally { if (version === loadVersion) { busy = false; templateControls(); } }
  };
  async function load() {
    const version = ++loadVersion;
    ready = false; busy = false; editorTemplate = null;
    base = window.flowBase();
    config = { enabled: false, mode: 'numbered', triggerMode: 'keywords', nodes: [] };
    el('flow-nodes').replaceChildren();
    el('flow-notice').textContent = '';
    for (const id of ['flow-save', 'flow-add', 'flow-example', 'flow-enabled', 'flow-mode']) el(id).disabled = !base;
    templateControls();
    if (!base && !window.isSuperAdmin()) { el('flow-template').replaceChildren(); return; }
    try {
      await loadTemplates(version);
      if (version !== loadVersion) return;
      if (!base) {
        const selected = el('flow-template').value;
        if (selected) { const item = await window.workspaceApi(`/api/admin/templates/${encodeURIComponent(selected)}`); if (version !== loadVersion) return; editorTemplate = item; config = { ...item.config, enabled: false }; el('template-name').value = item.name; }
        else { editorTemplate = { id: null, name: '新示例', revision: 0 }; el('template-name').value = '新示例'; }
        ready = true; draw(); status('管理员公共示例编辑：无需添加或连接WhatsApp号码，可直接编辑、上传图片和保存。'); return;
      }
      const data = await window.workspaceApi(`${base}/flows`);
      if (version !== loadVersion) return;
      ready = true; config = data; draw();
    } catch (error) { if (version === loadVersion) { status(error.message); templateControls(); } }
  }
  window.addEventListener('flows-opened', () => { if (!ready || base !== window.flowBase()) void load(); });
  window.addEventListener('account-changed', () => { void load(); });
  void load();
})();
