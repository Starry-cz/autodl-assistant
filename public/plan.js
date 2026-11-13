'use strict';
// 环境与选卡规划：规则在本机读出约束，可选的模型只补充规则读不出的内容；结果由用户确认后填入新建任务。
const planForm = $('#plan-form');
let planBusy = false, lastPlan = null;
const PLAN_STATUS = { ok: ['可用', ''], warn: ['有风险', 'warning'], check: ['需核对', 'neutral'], excluded: ['不满足', 'error'] };
const planSource = s => s === 'model' ? '<span class="badge warning">模型补充</span>' : s === 'estimate' ? '<span class="badge neutral">估算</span>' : '<span class="badge">规则</span>';
function renderPlanControls() {
  const ai = appState.ai, ready = !!ai?.ready, use = planForm.elements.useModel;
  use.disabled = !ready || planBusy; if (!ready) use.checked = false;
  $('#plan-consent').classList.toggle('hidden', !use.checked);
  const provider = (appState.aiProviders || []).find(p => p.id === ai?.provider);
  $('#plan-consent-text').textContent = '我同意将本次文本发送给 ' + (provider?.name || '所选模型服务商') + ' 分析，可能产生服务商费用。';
  use.parentElement.title = ready ? '' : '请先在“模型设置”中配置并启用 API Key';
  $('#plan-submit').disabled = planBusy;
}
function planConstraints(rows) {
  if (!rows.length) return '<p class="hint">未识别到版本或显存要求，请补充项目依赖或硬件要求。</p>';
  return '<table class="plan-table"><thead><tr><th>条件</th><th>读到的值</th><th>来源</th><th>原文依据</th></tr></thead><tbody>' + rows.map(r =>
    '<tr><td>' + esc(r.label) + '</td><td><strong>' + esc(r.value) + '</strong>' + (r.ambiguous ? ' <span class="badge warning">待确认</span>' : '') + (r.note ? '<small>' + esc(r.note) + '</small>' : '') +
    '</td><td>' + planSource(r.source) + '</td><td>' + (r.evidence || []).map(e => '<code>' + esc(e) + '</code>').join('') + '</td></tr>').join('') + '</tbody></table>';
}
function planStock(g) {
  return g.regions.map(r => esc(r.region) + ' ' + (Number.isInteger(r.available) ? esc(r.available) + '/' + esc(r.total ?? '?') : '?') + (r.disabled ? '（不可选）' : '')).join('<br>');
}
function planGpuRows(list, pick) {
  return list.map(g => {
    const [label, style] = PLAN_STATUS[g.status];
    return '<tr><td><strong>' + esc(g.model) + '</strong><small>' + esc([g.arch && g.arch + ' sm_' + g.sm, g.vramGB ? g.vramGB + 'GB' : '显存未知'].filter(Boolean).join(' · ')) + '</small></td>' +
      '<td><span class="badge ' + style + '">' + label + '</span></td><td>' + planStock(g) + '</td><td>' + (g.reasons.length ? g.reasons.map(esc).join('<br>') : '满足已读出的条件') + '</td>' +
      (pick ? '<td>' + (g.status === 'excluded' ? '' : '<button type="button" class="button small" data-plan-pick="' + esc(g.model) + '">填入新建任务</button>') + '</td>' : '') + '</tr>';
  }).join('');
}
function renderPlan(plan) {
  lastPlan = plan;
  const panel = $('#plan-results'); panel.hidden = false;
  const usable = plan.gpus.filter(g => g.status !== 'excluded'), excluded = plan.gpus.filter(g => g.status === 'excluded');
  const model = plan.model?.error ? '<p class="notice">模型补充失败：' + esc(plan.model.error) + '。下面是规则结果。</p>'
    : plan.model ? '<p class="hint">模型补充 ' + esc(plan.model.accepted) + ' 条约束（' + esc(plan.model.meta?.model || '') + '，' + esc(((plan.model.meta?.elapsedMs || 0) / 1000).toFixed(1)) + ' 秒）' +
      (plan.model.summary ? '：' + esc(plan.model.summary) : '') + '</p>' + (plan.model.rejected?.length ? '<details><summary>丢弃 ' + esc(plan.model.rejected.length) + ' 条模型输出（引用核对未通过）</summary><ul>' +
      plan.model.rejected.map(r => '<li>' + esc(r.field) + ' = ' + esc(r.value) + '：' + esc(r.reason) + '</li>').join('') + '</ul></details>' : '') : '';
  // 复用公共时间格式化函数显示快照时间，避免引用已不存在的相对时间函数中断整个结果渲染。
  const catalog = plan.catalogCheckedAt ? '目录更新于 ' + time(plan.catalogCheckedAt, true) : '请连接账号，在“抢卡控制台”同步 AutoDL 型号';
  const notices = (plan.notices || []).map(n => '<p class="notice">' + esc(n) + '</p>').join('');
  panel.innerHTML = '<h2>规划结果 · 待你确认</h2>' + notices + model +
    '<div class="ai-result-section"><h3>读出的条件</h3>' + planConstraints(plan.constraints) + '</div>' +
    '<div class="ai-result-section"><h3>候选型号</h3><p class="hint">' + esc(catalog) + '。多个任务成功后分别计费。</p>' +
    (usable.length ? '<table class="plan-table"><thead><tr><th>型号</th><th>结论</th><th>各地区空闲/总数</th><th>原因</th><th></th></tr></thead><tbody>' + planGpuRows(usable, true) + '</tbody></table>' : '<p class="notice">目录中没有满足条件的型号。</p>') +
    (excluded.length ? '<details><summary>不满足条件的型号（' + esc(excluded.length) + '）</summary><table class="plan-table"><tbody>' + planGpuRows(excluded, false) + '</tbody></table></details>' : '') + '</div>' +
    '<div class="ai-result-section"><h3>实例检查命令</h3><p class="hint">在实例终端运行，核对 GPU、驱动和 PyTorch。</p><pre class="plan-commands">' +
    plan.setupCommands.map(esc).join('\n') + '</pre></div>' +
    '<p class="notice">填入任务后，请核对配置和费用再提交。</p>';
}
planForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (planBusy) return;
  const data = { request: planForm.elements.request.value, projectText: planForm.elements.projectText.value, gpuCount: Number(planForm.elements.gpuCount.value),
    useModel: planForm.elements.useModel.checked && !!appState.ai?.ready, consent: planForm.elements.consent.checked };
  if (!data.request.trim() && !data.projectText.trim()) { toast('请先粘贴项目资料', true); return; }
  if (data.useModel && !data.consent) { toast('请先勾选同意把本次文本交给模型分析', true); return; }
  planBusy = true; renderPlanControls();
  $('#plan-status').textContent = data.useModel ? '正在请求模型分析…' : '正在按规则分析…';
  try {
    const plan = await api('/api/plan', data); renderPlan(plan);
    $('#plan-status').textContent = plan.model?.error ? '模型补充失败，已显示规则结果。' : '分析完成，请核对结果。';
  } catch (error) { $('#plan-status').textContent = error.message; toast(error.message, true); }
  finally { planBusy = false; planForm.elements.consent.checked = false; renderPlanControls(); }
});
$('#plan-results').addEventListener('click', async event => {
  const button = event.target.closest('[data-plan-pick]');
  if (!button || !lastPlan) return;
  const gpu = lastPlan.gpus.find(g => g.model === button.dataset.planPick);
  if (!gpu) return;
  if (currentMode !== 'create') $('[data-mode="create"]').click();
  $('[data-view="dashboard"]').click();
  regions(gpu.regions.filter(r => !r.disabled).map(r => r.region));
  keepGpuModel(gpu.model, '规划选择'); updateGpuSelection();
  const form = $('#task-form');
  form.elements.gpuCount.value = planForm.elements.gpuCount.value;
  form.elements.gpuModel.dispatchEvent(new Event('change'));
  if (!accountReady()) { toast('已填入 ' + gpu.model + ' 与地区；登录 AutoDL 后点“同步官方镜像”选择镜像'); return; }
  toast('已填入 ' + gpu.model + '，正在读取官方镜像菜单……');
  try {
    const result = await api('/api/plan/image', { hint: gpu.imageHint });
    const filled = window.applyImagePlan?.(result);
    const stop = result.levels.find(l => !l.label);
    toast(filled ? '已填入 ' + gpu.model + ' 与镜像 ' + result.path.join(' / ') + '，请核对后授权提交' : '已填入型号；镜像' + (stop ? '：' + stop.reason : '需要自行选择'), !filled);
  } catch (error) { toast('型号已填入；读取镜像失败：' + error.message, true); }
});
$('#plan-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 98304) throw new Error('请选择不超过 96KB 的文本，或先摘出相关段落');
    const content = await file.text();
    if (content.includes('\0')) throw new Error('请选择普通文本文件');
    const target = planForm.elements.projectText, appended = (target.value ? target.value + '\n\n' : '') + '文件：' + file.name + '\n' + content;
    if (appended.length > 24000) throw new Error('项目资料超过 24000 字符，请先摘出相关段落');
    target.value = appended; planForm.elements.consent.checked = false; toast('文本已加入，尚未分析');
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});
for (const name of ['useModel', 'request', 'projectText']) planForm.elements[name].addEventListener('input', () => { planForm.elements.consent.checked = false; renderPlanControls(); });
planForm.elements.useModel.addEventListener('change', renderPlanControls);
window.addEventListener('appstatechange', renderPlanControls);
renderPlanControls();

