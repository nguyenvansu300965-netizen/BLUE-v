(() => {
  const el = id => document.getElementById(id);
  let config = { enabled: false, mode: 'numbered', nodes: [] };
  let busy = false;
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
      const title = document.createElement('strong'); title.textContent = `节点 ${index + 1}`;
      head.append(title, button('删除节点', () => {
        if (config.nodes.some(n => n.options.some(o => o.next === node.id))) return status('请先移除其他节点指向此节点的选项');
        config.nodes.splice(index, 1); draw();
      }));
      card.append(head, field('节点名称', input(node.name, v => { node.name = v; })), field('触发词（以逗号分隔；分支节点可留空）', input(node.triggers.join(', '), v => { node.triggers = v.split(/[,，]/).map(t => t.trim()).filter(Boolean); })), field('回复文案', input(node.text, v => { node.text = v; }, true)));
      const image = document.createElement('img'); image.className = 'flow-image'; image.hidden = !node.image; if (node.image) image.src = `/api/media/${node.image}`;
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp';
      file.onchange = async () => {
        const upload = file.files[0]; if (!upload) return;
        if (upload.size > 5 * 1024 * 1024) return status('图片最大 5MB');
        busy = true; el('flow-save').disabled = true; status('正在上传图片…');
        try {
          const response = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': upload.type }, body: upload });
          const result = await response.json(); if (!response.ok) throw new Error(result.error);
          node.image = result.id; image.src = `/api/media/${node.image}`; image.hidden = false; status('图片已上传，保存流程后生效');
        } catch (error) { status(error.message); }
        finally { busy = false; el('flow-save').disabled = false; }
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
  el('flow-example').onclick = () => {
    if (config.nodes.length && !confirm('示例将替换当前编辑内容，是否继续？')) return;
    config = { enabled: false, mode: 'numbered', nodes: [
      { id: 'welcome', name: '欢迎菜单', triggers: ['你好', '菜单', 'hi'], text: '欢迎咨询！请选择你感兴趣的内容：', image: '', options: [{ label: '产品介绍', next: 'products' }, { label: '联系顾问', next: 'contact' }] },
      { id: 'products', name: '产品介绍', triggers: [], text: '这里填写产品介绍，可上传产品图片。', image: '', options: [{ label: '联系顾问', next: 'contact' }, { label: '返回菜单', next: 'welcome' }] },
      { id: 'contact', name: '联系顾问', triggers: [], text: '请留下您的需求，我们将尽快回复。', image: '', options: [{ label: '返回菜单', next: 'welcome' }] }
    ] }; draw(); status('示例已载入，请修改内容后启用并保存');
  };
  el('flow-save').onclick = async () => {
    if (busy) return;
    el('flow-save').disabled = true;
    try {
      const response = await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      status('流程已保存，立即生效');
    } catch (error) { status(error.message); }
    finally { el('flow-save').disabled = false; }
  };
  fetch('/api/flows').then(r => { if (!r.ok) throw new Error('无法加载流程'); return r.json(); }).then(data => { config = data; draw(); }).catch(error => { status(error.message); el('flow-save').disabled = true; });
})();
