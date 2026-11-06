// 仅供隔离测试的合成 Element 风格复选框页面，模拟延迟、重排、“全部”规则、静默拒绝和禁用。
// 这些是待验证的假设机制，不是 AutoDL 当前页面的实现或行为承诺；生产代码不导入本文件。
const ALL = '全部';
function fixtureMain(cfg) {
  const ALL = '全部', root = document.getElementById('root');
  const groups = cfg.groups.map(group => ({ ...group, options: group.options.map(option => ({ ...option })) }));
  const initial = new Map(groups.map(group => [group.id, new Map(group.options.map(option => [option.name, !!option.checked]))]));
  window.__actions = [];
  const policies = {
    plain: selected => selected,
    exclusiveAll: (selected, name, checked) => {
      if (name === ALL && checked) return new Set([ALL]);
      if (name !== ALL && checked) selected.delete(ALL);
      if (!selected.size) selected.add(ALL);
      return selected;
    },
    minOne: (selected, name, checked, names, previous) => selected.size ? selected : previous,
    checkAll: (selected, name, checked, names) => {
      if (name === ALL) return new Set(checked ? names : []);
      selected.delete(ALL);
      if (names.filter(n => n !== ALL).every(n => selected.has(n))) selected.add(ALL);
      return selected;
    },
  };
  const text = option => option.stock ? option.name + '(' + option.stock + ')' : option.name;
  function render(group) {
    let box = document.getElementById('group-' + group.id);
    if (!box) { box = document.createElement('div'); box.id = 'group-' + group.id; box.className = 'el-checkbox-group'; root.append(box); }
    if (group.policy === 'checkAll') {
      const models = group.options.filter(option => option.name !== ALL), selected = models.filter(option => option.checked).length;
      for (const option of group.options) if (option.name === ALL) { option.checked = selected === models.length; option.indeterminate = selected > 0 && selected < models.length; }
    }
    box.replaceChildren(...group.options.map(option => {
      const label = document.createElement('label'), wrap = document.createElement('span');
      label.className = 'el-checkbox' + (option.checked ? ' is-checked' : '') + (option.disabled ? ' is-disabled' : '');
      wrap.className = 'el-checkbox__input' + (option.checked ? ' is-checked' : '') + (option.indeterminate ? ' is-indeterminate' : '') + (option.disabled ? ' is-disabled' : '');
      const inner = document.createElement('span'), input = document.createElement('input'), caption = document.createElement('span');
      inner.className = 'el-checkbox__inner'; input.type = 'checkbox'; input.className = 'el-checkbox__original';
      input.checked = !!option.checked; input.disabled = !!option.disabled;
      caption.className = 'el-checkbox__label'; caption.textContent = text(option);
      wrap.append(inner, input); label.append(wrap, caption);
      if (group.defer) label.addEventListener('click', event => {
        event.preventDefault();
        if (!option.disabled) setTimeout(() => apply(group, option.name, !option.checked), group.defer);
      });
      else input.addEventListener('change', () => apply(group, option.name, input.checked));
      return label;
    }));
  }
  function restore(group, values) { for (const option of group.options) option.checked = values.get(option.name); render(group); }
  function apply(group, name, checked) {
    window.__actions.push(group.id + ':' + name + (checked ? '+' : '-'));
    const names = group.options.map(option => option.name), before = new Map(group.options.map(option => [option.name, !!option.checked]));
    const previous = new Set(group.options.filter(option => option.checked).map(option => option.name)), selected = new Set(previous);
    if (checked) selected.add(name); else selected.delete(name);
    const next = policies[group.policy || 'plain'](selected, name, checked, names, previous);
    // 原生勾选已经改变，但组件模型与样式保持旧值，也不重新渲染。
    if (group.rejectSilently) return;
    const commit = () => {
      for (const option of group.options) option.checked = next.has(option.name);
      if (group.reorder) group.options.push(group.options.shift());
      render(group);
    };
    if (group.asyncCommit) setTimeout(commit, group.asyncCommit); else commit();
    if (group.revertAfter) setTimeout(() => restore(group, before), group.revertAfter);
    if (group.resetAfter && !group.resetDone) { group.resetDone = true; setTimeout(() => restore(group, initial.get(group.id)), group.resetAfter); }
  }
  window.__fixtureState = () => ({ actions: [...window.__actions], groups: Object.fromEntries(groups.map(group => [group.id,
    group.options.map(option => {
      const label = [...document.querySelectorAll('#group-' + group.id + ' label.el-checkbox')].find(node => node.innerText.trim() === text(option));
      return { name: option.name, model: !!option.checked, native: label?.querySelector('input')?.checked ?? null };
    })])) });
  groups.forEach(render);
}
export function checkboxPage(groups) {
  return '<!doctype html><meta charset="utf-8"><title>合成复选框夹具</title><style>body{font:16px sans-serif;padding:16px}'
    + '.el-checkbox{display:inline-flex;align-items:center;gap:6px;margin:6px 14px 6px 0;cursor:pointer}'
    + '.el-checkbox__input{position:relative;display:inline-block}.el-checkbox__inner{display:inline-block;width:14px;height:14px;border:1px solid #889}'
    + '.el-checkbox__original{opacity:0;position:absolute;margin:0;width:0;height:0;z-index:-1}.el-checkbox-group{margin:8px 0}</style>'
    + '<body><div id="root"></div><script>(' + fixtureMain.toString() + ')(' + JSON.stringify({ groups }) + ');</script></body>';
}
const gpuOptions = (checked = [ALL], extra = {}) => [
  { name: ALL }, { name: 'RTX 4090', stock: '1/8' }, { name: 'RTX 4090D', stock: '3/8' }, { name: 'RTX 3090', stock: '5/8' },
].map(option => ({ ...option, checked: checked.includes(option.name), ...(extra[option.name] || {}) }));
const expandGroup = (option = {}) => ({ id: 'expand', options: [{ name: '需要扩容', checked: false, ...option }] });
const modelGroup = (props = {}, checked, extra) => ({ id: 'gpu', ...props, options: gpuOptions(checked, extra) });
const onlyTarget = state => state.groups.gpu.every(option => option.model === (option.name === 'RTX 4090'))
  && state.groups.expand.every(option => option.model === false);
const selectTarget = adapter => adapter.selectModel('RTX 4090');
const toggle = (name, checked) => (adapter, page) => adapter.checkbox(page.locator('label.el-checkbox').filter({ hasText: new RegExp('^\\s*' + name + '\\s*$') }), checked, name);
const single = (group, value) => state => state.groups[group].every(option => option.model === value && option.native === value);
// expect 描述修复后的预期；旧实现的实际表现由同一组场景另行记录。
export const CHECKBOX_SCENARIOS = [
  { id: 'static-baseline', title: '静态页面：全部+其他型号已选', groups: [modelGroup({}, [ALL, 'RTX 4090D']), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'deferred-commit', title: '点击后约250ms才生效', groups: [modelGroup({ defer: 250 }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'async-class', title: '原生勾选先变、组件样式250ms后才更新', groups: [modelGroup({ asyncCommit: 250 }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'reorder', title: '每次变化后列表重排', groups: [modelGroup({ reorder: true }, [ALL, 'RTX 4090D']), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'exclusive-all', title: '“全部”与具体型号互斥且不能全不选', groups: [modelGroup({ policy: 'exclusiveAll' }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'min-one', title: '至少保留一个选项（撤销清空）', groups: [modelGroup({ policy: 'minOne' }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'check-all', title: '“全部”为全选开关，初始全选', groups: [modelGroup({ policy: 'checkAll' }, [ALL, 'RTX 4090', 'RTX 4090D', 'RTX 3090']), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'late-reset', title: '首次操作250ms后筛选被异步重置一次', groups: [modelGroup({ resetAfter: 250 }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'pass' } },
  { id: 'fight', title: '每次变化60ms后都被页面撤销', groups: [modelGroup({ revertAfter: 60 }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'fail', code: ['MODEL_FILTER', 'CHECKBOX_STATE'] } },
  { id: 'disabled-target', title: '目标型号选项禁用', groups: [modelGroup({}, [ALL], { 'RTX 4090': { disabled: true, stock: '0/8' } }), expandGroup()], run: selectTarget, correct: onlyTarget, expect: { outcome: 'fail', code: 'OPTION_DISABLED', maxActions: 0 } },
  { id: 'duplicate-all', title: '页面另有一组“全部”筛选', groups: [modelGroup(), { id: 'other', options: [{ name: ALL, checked: true }, { name: '其他筛选', checked: false }] }, expandGroup()],
    run: selectTarget, correct: state => onlyTarget(state) && state.groups.other[0].model === true, expect: { outcome: 'fail', code: 'MODEL_FILTER', maxActions: 0 } },
  { id: 'expand-deferred', title: '取消“需要扩容”约250ms后生效', groups: [{ ...expandGroup({ checked: true }), defer: 250 }], run: toggle('需要扩容', false), correct: single('expand', false), expect: { outcome: 'pass' } },
  { id: 'expand-silent-reject', title: '“需要扩容”原生取消但组件保持勾选', groups: [{ ...expandGroup({ checked: true }), rejectSilently: true }], run: toggle('需要扩容', false), correct: single('expand', false), expect: { outcome: 'fail', code: 'CHECKBOX_STATE' } },
  { id: 'expand-disabled-correct', title: '“需要扩容”禁用但已是未勾选', groups: [expandGroup({ disabled: true })], run: toggle('需要扩容', false), correct: single('expand', false), expect: { outcome: 'pass', maxActions: 0 } },
  { id: 'expand-disabled-change', title: '需要勾选的“需要扩容”被禁用', groups: [expandGroup({ disabled: true })], run: toggle('需要扩容', true), correct: single('expand', true), expect: { outcome: 'fail', code: 'OPTION_DISABLED', maxActions: 0 } },
  { id: 'data-disk-deferred', title: '取消“数据盘”约250ms后生效', groups: [{ id: 'disk', defer: 250, options: [{ name: '数据盘', checked: true }] }], run: toggle('数据盘', false), correct: single('disk', false), expect: { outcome: 'pass' } },
];
export async function runCheckboxScenario(Adapter, scenario, open, { settleMs = 400, checkboxTimeoutMs = 1500 } = {}) {
  const page = await open(checkboxPage(scenario.groups), scenario.id);
  const adapter = new Adapter('unused-isolated-checkbox-profile');
  adapter.page = page; adapter.checkboxTimeoutMs = checkboxTimeoutMs;
  // 真实 settle 至少等待 networkidle 与400ms；本地静态夹具用固定400ms近似。
  adapter.settle = () => new Promise(resolve => setTimeout(resolve, settleMs));
  let error = null; const started = Date.now();
  try { await scenario.run(adapter, page); } catch (caught) { error = caught; }
  const elapsedMs = Date.now() - started;
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => window.__fixtureState());
  await page.close();
  const correct = scenario.correct(state);
  return { id: scenario.id, title: scenario.title, outcome: error ? 'fail' : correct ? 'pass' : 'wrong-pass', correct,
    code: error?.code || null, message: error ? String(error.message).slice(0, 300) : '', actions: state.actions, elapsedMs };
}
export function checkScenarioExpectation(scenario, result) {
  const problems = [];
  if (result.outcome !== scenario.expect.outcome) problems.push('outcome ' + result.outcome + ' ≠ ' + scenario.expect.outcome);
  const codes = [scenario.expect.code].flat().filter(Boolean);
  if (codes.length && !codes.includes(result.code)) problems.push('code ' + result.code + ' ∉ ' + codes.join('/'));
  if (scenario.expect.maxActions !== undefined && result.actions.length > scenario.expect.maxActions) problems.push('actions ' + result.actions.length + ' > ' + scenario.expect.maxActions);
  if (result.outcome === 'fail' && !/[“"].+[”"]/.test(result.message)) problems.push('error does not name the option');
  return problems;
}

