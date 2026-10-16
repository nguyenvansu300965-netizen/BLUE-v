export const defaultTemplates = [
    { id: 'builtin-1', name: '示例1 · 欢迎菜单', config: { enabled: false, mode: 'numbered', triggerMode: 'keywords', nodes: [
      { id: 'welcome', name: '欢迎菜单', triggers: ['你好', '菜单', 'hi'], text: '欢迎咨询！请选择你感兴趣的内容：', image: '', options: [{ label: '产品介绍', next: 'products' }, { label: '联系顾问', next: 'contact' }] },
      { id: 'products', name: '产品介绍', triggers: [], text: '这里填写产品介绍，可上传产品图片。', image: '', options: [{ label: '联系顾问', next: 'contact' }, { label: '返回菜单', next: 'welcome' }] },
      { id: 'contact', name: '联系顾问', triggers: [], text: '请留下您的需求，我们将尽快回复。', image: '', options: [{ label: '返回菜单', next: 'welcome' }] }
    ] } },
    { id: 'builtin-2', name: '示例2 · 咨询分流', config: { enabled: false, mode: 'buttons', triggerMode: 'any', nodes: [
      { id: 'entry', name: '咨询入口', triggers: [], text: '您好，请选择咨询类型：', image: '', options: [{ label: '售前咨询', next: 'sales' }, { label: '售后服务', next: 'support' }] },
      { id: 'sales', name: '售前咨询', triggers: [], text: '请留下您感兴趣的产品，我们会为您介绍。', image: '', options: [{ label: '返回菜单', next: 'entry' }] },
      { id: 'support', name: '售后服务', triggers: [], text: '请提供订单号及问题描述。', image: '', options: [{ label: '返回菜单', next: 'entry' }] }
    ] } }
  ];
