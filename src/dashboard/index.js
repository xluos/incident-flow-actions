const errors = {
  invalid_or_duplicate_action_id: '按钮标识重复或格式不正确。请使用小写字母开头的字母、数字、- 或 _。',
  invalid_action_instruction: '请填写每个按钮点击后要发送的指令（最多 8000 字）。',
  invalid_action_label: '请填写按钮文字（最多 40 字）。',
  invalid_confirmation_title: '请填写二次确认的标题（最多 80 字）。',
  invalid_confirmation_text: '请填写二次确认的内容（最多 500 字）。',
  invalid_target_sessionId: '会话 ID 格式不正确，请使用实际的会话 ID。',
  actions_must_have_1_to_5_buttons: '每个方案需要 1–5 个按钮。',
  bot_profile_required: '请为启用的机器人选择按钮方案。',
};

export default function PluginDashboard({ api }) {
  if (!api.react || !api.getSettings) return '请先更新 Botmux：当前版本缺少插件配置页面接口。';
  const { createElement: h, useState, useEffect } = api.react;
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState('');
  const [bots, setBots] = useState([]);
  const [profile, setProfile] = useState('');
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = config && JSON.stringify(config) !== saved;
  useEffect(() => {
    let active = true;
    Promise.all([api.getSettings(), api.listBots()]).then(([result, list]) => {
      if (!active) return;
      setConfig(result.workflowConfig); setSaved(JSON.stringify(result.workflowConfig));
      setProfile(Object.keys(result.workflowConfig.profiles)[0]); setBots(list);
    }).catch(error => active && setMessage(error.message));
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    const warn = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function edit(fn) { setConfig(current => { const next = structuredClone(current); fn(next); return next; }); setMessage(''); }
  function actionEdit(index, fn) { edit(next => fn(next.profiles[profile].actions[index])); }
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: disabled || busy }, label);
  const field = (label, value, onChange, options = {}) => h('label', { className: 'ifa-field' }, h('span', null, label),
    h(options.multiline ? 'textarea' : 'input', { value: value ?? '', onChange: e => onChange(e.target.value), disabled: busy, ...options, multiline: undefined }));
  const select = (label, value, onChange, entries) => h('label', { className: 'ifa-field' }, h('span', null, label),
    h('select', { value, disabled: busy, onChange: e => onChange(e.target.value) }, entries.map(([v, name]) => h('option', { key: v, value: v }, name))));
  const botChoices = [['', '原机器人 · 原会话'], ...bots.map(bot => [bot.id, `${bot.name || bot.id} (${bot.id})`])];
  async function save() {
    setBusy(true); setMessage('');
    try {
      const result = await api.saveSettings({ workflowConfig: config });
      setConfig(result.workflowConfig); setSaved(JSON.stringify(result.workflowConfig));
      setMessage('已保存。新发送的卡片使用此配置，已有卡片保留原来的按钮行为。');
    } catch (error) { setMessage(`保存失败：${errors[error.message] || error.message}`); }
    finally { setBusy(false); }
  }
  if (!config) return h('p', { role: 'status' }, message || '正在读取按钮配置…');
  const profiles = Object.keys(config.profiles);
  const actions = config.profiles[profile]?.actions || [];
  const knownBots = [...bots];
  for (const id of Object.keys(config.bots)) if (!knownBots.some(bot => bot.id === id)) knownBots.push({ id, name: '未在当前机器找到的机器人' });
  return h('div', { className: 'ifa-editor' },
    h('style', null, `.ifa-editor{max-width:1100px;display:grid;gap:20px}.ifa-editor section{border:1px solid var(--border,#46505e);border-radius:12px;padding:20px;display:grid;gap:14px}.ifa-editor h2,.ifa-editor h3,.ifa-editor p{margin:0}.ifa-editor p{line-height:1.7;opacity:.8}.ifa-editor input,.ifa-editor select,.ifa-editor textarea{font:inherit;color:inherit;background:var(--bg,#171d28);border:1px solid #667085;border-radius:6px;padding:9px;width:100%;box-sizing:border-box}.ifa-editor textarea{min-height:90px;resize:vertical}.ifa-editor button{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #667085;cursor:pointer;background:var(--bg,#171d28);color:inherit}.ifa-editor button:disabled{opacity:.45;cursor:default}.ifa-field{display:grid;gap:6px;font-size:14px;min-width:0}.ifa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.ifa-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ifa-action{border:1px solid #66708555;border-radius:8px;padding:16px;display:grid;gap:14px}.ifa-primary{background:#2563eb!important;color:white!important}.ifa-preview{padding:18px;background:#80808012;border-radius:8px}.ifa-status{padding:12px;border-left:3px solid #60a5fa;white-space:pre-wrap}.ifa-editor input[type=checkbox]{width:auto}`),
    h('div', { className: 'ifa-toolbar' }, h('h2', null, '卡片按钮配置'), h('span', null, dirty ? '有未保存的修改' : '已与服务器同步'),
      h('button', { type: 'button', className: 'ifa-primary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存配置'),
      button('撤销修改', () => { if (window.confirm('丢弃尚未保存的修改？')) { const value = JSON.parse(saved); setConfig(value); setProfile(Object.keys(value.profiles)[0]); setMessage(''); } }, !dirty)),
    message && h('div', { role: 'status', className: 'ifa-status' }, message),
    h('p', null, '设置卡片上展示哪些按钮、点击后交给谁、执行什么指令。保存后新卡片即时使用，无需重启机器人。'),
    h('section', null, h('h2', null, '1. 按钮方案'),
      h('div', { className: 'ifa-grid' }, select('编辑方案', profile, setProfile, profiles.map(id => [id, id])),
        field('新方案名称（小写字母开头，可含数字、-、_）', newName, setNewName, { maxLength: 48 })),
      h('div', { className: 'ifa-toolbar' }, button('复制为新方案', () => {
        if (!/^[a-z][a-z0-9_-]{0,47}$/.test(newName) || Object.hasOwn(config.profiles, newName)) { setMessage('方案名称格式不正确或已经存在。'); return; }
        edit(next => { next.profiles[newName] = structuredClone(next.profiles[profile]); }); setProfile(newName); setNewName('');
      }), button('删除此方案', () => {
        if (config.defaultProfile === profile || Object.values(config.bots).some(bot => bot.profile === profile)) { setMessage('此方案仍被机器人或默认方案引用，请先调整绑定。'); return; }
        if (window.confirm(`删除方案 ${profile}？`)) { edit(next => { delete next.profiles[profile]; }); setProfile(profiles.find(id => id !== profile)); }
      }, profiles.length < 2)),
      ...actions.map((action, index) => h('article', { className: 'ifa-action', key: `${profile}:${index}` },
        h('div', { className: 'ifa-toolbar' }, h('h3', null, `按钮 ${index + 1}`),
          button('上移', () => edit(next => { const list = next.profiles[profile].actions; [list[index - 1], list[index]] = [list[index], list[index - 1]]; }), index === 0),
          button('下移', () => edit(next => { const list = next.profiles[profile].actions; [list[index + 1], list[index]] = [list[index], list[index + 1]]; }), index === actions.length - 1),
          button('删除按钮', () => edit(next => next.profiles[profile].actions.splice(index, 1)), actions.length === 1)),
        h('div', { className: 'ifa-grid' },
          field('按钮文字', action.label, value => actionEdit(index, item => { item.label = value; }), { maxLength: 40 }),
          field('按钮标识（方案内唯一）', action.id, value => actionEdit(index, item => { item.id = value; }), { maxLength: 48 }),
          select('按钮样式', action.style, value => actionEdit(index, item => { item.style = value; }), [['default', '普通'], ['primary', '强调'], ['danger', '危险操作']])),
        field('点击后发送的指令', action.instruction, value => actionEdit(index, item => { item.instruction = value; }), { multiline: true, maxLength: 8000 }),
        select('接手机器人', action.target?.botId || '', value => actionEdit(index, item => { if (value) item.target = { botId: value }; else delete item.target; }),
          action.target?.botId && !bots.some(bot => bot.id === action.target.botId) ? [...botChoices, [action.target.botId, action.target.botId]] : botChoices),
        action.target && field('指定会话 ID（可选）', action.target.sessionId, value => actionEdit(index, item => { if (value) item.target.sessionId = value; else delete item.target.sessionId; })),
        action.target && h('p', null, '目标机器人必须在同群、同话题下已有会话；不指定会话 ID 时仅在唯一匹配时续接。'),
        h('label', null, h('input', { type: 'checkbox', checked: !!action.confirmation, disabled: busy, onChange: e => {
          const checked = e.target.checked; actionEdit(index, item => { if (checked) item.confirmation = { title: '确认操作', text: '确认执行此操作？' }; else delete item.confirmation; });
        } }), ' 点击前要求二次确认'),
        action.confirmation && h('div', { className: 'ifa-grid' },
          field('确认标题', action.confirmation.title, value => actionEdit(index, item => { item.confirmation.title = value; }), { maxLength: 80 }),
          field('确认内容', action.confirmation.text, value => actionEdit(index, item => { item.confirmation.text = value; }), { maxLength: 500 }))
      )),
      button('添加按钮', () => edit(next => {
        let n = 1; while (actions.some(action => action.id === `action_${n}`)) n++;
        next.profiles[profile].actions.push({ id: `action_${n}`, label: '新按钮', style: 'default', instruction: '' });
      }), actions.length >= 5),
      h('div', { className: 'ifa-preview' }, h('p', null, '按钮预览 · 仅示意，不会发送指令'),
        h('div', { className: 'ifa-toolbar' }, ...actions.map((action, index) => h('button', { key: index, type: 'button', style: { background: action.style === 'primary' ? '#2563eb' : action.style === 'danger' ? '#b42318' : undefined }, onClick: () => setMessage(`预览：${action.label}\n${action.instruction || '尚未填写指令'}\n接手：${action.target?.botId || '原机器人原会话'}`) }, action.label))))),
    h('section', null, h('h2', null, '2. 机器人绑定'),
      h('p', null, '这里决定每个机器人使用哪个按钮方案。机器人还需要在插件列表里单独启用此插件。'),
      select('未单独绑定的机器人', config.defaultProfile || '', value => edit(next => { next.defaultProfile = value || null; }), [['', '不允许发送此类卡片'], ...profiles.map(id => [id, `使用 ${id}`])]),
      ...knownBots.map(bot => select(`${bot.name || bot.id} · ${bot.id}`, config.bots[bot.id]?.enabled === false ? '__disabled' : config.bots[bot.id]?.profile || '', value => edit(next => {
        if (!value) delete next.bots[bot.id];
        else next.bots[bot.id] = value === '__disabled' ? { enabled: false } : { enabled: true, profile: value };
      }), [['', '跟随默认设置'], ['__disabled', '禁止发送'], ...profiles.map(id => [id, `使用 ${id}`])]))));
}
