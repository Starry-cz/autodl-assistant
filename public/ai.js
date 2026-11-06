'use strict';
let aiSettingsLoaded = false, aiSettingsDirty = false, aiBusyLocal = false;
const aiSettingsForm = $('#ai-settings-form'), aiAnalysisForm = $('#ai-analysis-form');
function aiHint() {
  const preset = (appState.aiProviders || []).find(p => p.id === aiSettingsForm.elements.provider.value);
  $('#ai-provider-hint').textContent = preset?.hint || '';
}
function aiShowSettings(settings) {
  $('#ai-provider').innerHTML = (appState.aiProviders || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  for (const key of ['enabled', 'provider', 'baseUrl', 'model', 'timeoutSeconds', 'maxTokens', 'rememberKey']) {
    const field = aiSettingsForm.elements[key];
    if (field.type === 'checkbox') field.checked = !!settings[key];
    else field.value = settings[key] ?? '';
  }
  aiSettingsForm.elements.apiKey.value = '';
  aiHint();
}
function aiRenderState(force = false) {
  if (!appState.ai) return;
  const settings = appState.ai;
  if (!aiSettingsLoaded || force) { aiShowSettings(settings); aiSettingsLoaded = true; aiSettingsDirty = false; }
  const storage=appState.credentialStorage;
  if(storage){aiSettingsForm.elements.rememberKey.disabled=!storage.available;if(!storage.available)aiSettingsForm.elements.rememberKey.checked=false;$('#ai-storage-hint').textContent=storage.available?'记住后由 '+storage.method+' 加密保护，下次自动恢复为已配置；真实 Key 不回填页面。不勾选则仅在本次服务中使用。':'此系统尚无可用的安全凭据存储，Key 仅在本次服务内存中使用。';}
  const busy = aiBusyLocal || settings.busy;
  $('#ai-status').textContent = busy ? '分析中' : settings.ready ? '已配置 · 按需调用' : settings.enabled ? '等待 API Key' : '未启用 · 核心功能可用';
  $('#ai-key-status').textContent = settings.hasKey ? (settings.rememberKey ? '已记住本机 Key，接口不会回显原文。' : 'Key 仅在本次服务运行期间保存，重启后需重新填写。') : '尚未配置 API Key。';
  $('#ai-analyze').disabled = !settings.ready || busy || aiSettingsDirty;
  $('#ai-cancel').disabled = !busy;
  if (settings.notice) $('#ai-analysis-status').textContent = settings.notice;
  else if (!busy && !settings.ready) $('#ai-analysis-status').textContent = settings.enabled ? '请重新填写自己的 API Key 并保存；核心功能仍可使用。' : 'AI 未启用；你可以直接使用资源监测、新建、克隆和通知。';
}
window.addEventListener('appstatechange', () => aiRenderState());
aiSettingsForm.addEventListener('input', () => {
  aiSettingsDirty = true; aiAnalysisForm.elements.consent.checked = false; $('#ai-analyze').disabled = true;
  $('#ai-analysis-status').textContent = '设置有改动，请先保存；保存不会调用模型。';
});
$('#ai-provider').addEventListener('change', () => {
  const preset = appState.aiProviders.find(p => p.id === aiSettingsForm.elements.provider.value);
  if (!preset) return;
  aiSettingsForm.elements.baseUrl.value = preset.baseUrl;
  aiSettingsForm.elements.model.value = preset.model;
  aiSettingsForm.elements.apiKey.value = ''; aiHint();
});
aiSettingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = aiSettingsForm.querySelector('button[type="submit"]'); button.disabled = true;
  const data = Object.fromEntries(new FormData(aiSettingsForm));
  data.enabled = aiSettingsForm.elements.enabled.checked; data.rememberKey = aiSettingsForm.elements.rememberKey.checked;
  try {
    const saved = await api('/api/ai/settings', data); appState.ai = saved.ai; aiRenderState(true);
    $('#ai-analysis-status').textContent = saved.ai.ready ? '配置已保存；选择资料后点击“发送并分析”才会调用模型。' : 'AI 已停用；核心功能仍可使用。';
    toast('AI 设置已保存，未调用模型');
  } catch (error) { toast(error.message, true); }
  finally { aiSettingsForm.elements.apiKey.value = ''; button.disabled = false; }
});
$('#ai-clear-key').addEventListener('click', async () => {
  try {
    const cleared = await api('/api/ai/clear-key', {}); appState.ai = cleared.ai; aiRenderState(true);
    $('#ai-results').replaceChildren(); $('#ai-results').hidden = true;
    toast('API Key 已清除，AI 已停用；核心功能仍可使用');
  } catch (error) { toast(error.message, true); }
});
$('#ai-project-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 49152) throw new Error('请选择不超过48KB的文本片段；可先手动提取相关内容');
    const content = await file.text();
    if (content.includes('\0')) throw new Error('请选择普通文本文件');
    const target = aiAnalysisForm.elements.projectText;
    const appended = (target.value ? target.value + '\n\n' : '') + '文件：' + file.name + '\n' + content;
    if (appended.length > 12000) throw new Error('项目资料超过12000字符，请先提取相关片段');
    target.value = appended; aiAnalysisForm.elements.consent.checked = false;
    toast('文本已加入表单，尚未发送');
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});
for (const name of ['request', 'projectText', 'errorText', 'mode'])
  aiAnalysisForm.elements[name].addEventListener('input', () => { aiAnalysisForm.elements.consent.checked = false; });
function aiList(title, items, render) {
  return '<div class="ai-result-section"><h3>' + esc(title) + '</h3>' + (items.length ? '<ul>' + items.map(item => '<li>' + render(item) + '</li>').join('') + '</ul>' : '<p class="hint">无</p>') + '</div>';
}
function aiRenderResult(result, meta) {
  const panel = $('#ai-results'); panel.hidden = false;
  const usage = meta.usage?.total_tokens;
  panel.innerHTML = '<h2>分析建议 · 待人工核对</h2><p class="hint">' + esc(meta.model) + ' · ' + esc((meta.elapsedMs / 1000).toFixed(1)) + ' 秒' + (usage === undefined ? '' : ' · ' + esc(usage) + ' Token（服务商返回）') + '</p>' +
    '<p class="ai-summary">' + esc(result.summary) + '</p><p class="notice">未创建或修改任何任务，未运行任何检查。引用命中只表示文字出现在输入中，不代表结论已验证。GPU、数据完整性与项目运行结果需实际核验。</p>' +
    aiList('发现与依据', result.findings, item => '<p>' + esc(item.message) + '</p><small class="' + (item.evidenceMatched ? 'ai-evidence' : 'ai-uncertain') + '">' + (item.evidenceMatched ? '输入原文匹配：' : '未验证依据：') + esc(item.evidence || '未提供原文引用，请视为待验证假设') + '</small>') +
    aiList('建议与核验方法', result.recommendations, item => '<p><strong>' + esc(item.action) + '</strong></p><p>' + esc(item.reason) + '</p><small>如何核验：' + esc(item.verification) + '</small>') +
    aiList('需要补充的信息', result.questions, esc) + aiList('限制与提醒', result.warnings, esc);
}
aiAnalysisForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (aiBusyLocal || !appState.ai?.ready || aiSettingsDirty) return;
  const data = Object.fromEntries(new FormData(aiAnalysisForm)); data.consent = aiAnalysisForm.elements.consent.checked;
  if (data.request.length + data.projectText.length + data.errorText.length > 16000) { toast('三项文本合计不能超过16000字符', true); return; }
  if (data.mode === 'diagnose' && !data.errorText.trim()) { toast('请先提供脱敏错误日志', true); return; }
  aiBusyLocal = true; aiRenderState(); $('#ai-results').hidden = true;
  $('#ai-analysis-status').textContent = '正在请求已保存的模型服务；资源监测继续运行。';
  try {
    const response = await api('/api/ai/analyze', data); aiRenderResult(response.result, response.meta);
    $('#ai-analysis-status').textContent = '分析已完成，结果仅供核对，未自动执行。';
  } catch (error) { $('#ai-analysis-status').textContent = error.message; toast(error.message, true); }
  finally { aiBusyLocal = false; aiAnalysisForm.elements.consent.checked = false; await refresh(); aiRenderState(); }
});
$('#ai-cancel').addEventListener('click', async () => {
  try { await api('/api/ai/cancel', {}); $('#ai-analysis-status').textContent = '已请求取消等待；已发送的请求可能仍由服务商计费。'; }
  catch (error) { toast(error.message, true); }
});
aiRenderState();

