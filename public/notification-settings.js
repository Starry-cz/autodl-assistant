'use strict';
// 测试只提交渠道名，凭据由后台读取已保存配置；表单尚未保存时不允许误用旧配置发送。
(() => {
  const form = $('#settings-form'), saveButton = $('button[type=submit]', form);
  const saveStatus = $('#notification-save-status'), reloadButton = $('#reload-notification-settings'), channels = ['webhook', 'wechat'];
  const fields = ['webhookEnabled', 'webhookUrl', 'webhookToken', 'wechatEnabled', 'wechatToken', 'rememberCredentials'];
  let savedSignature = null, savedSettings = {}, savedRevision = 0, busy = null, generation = 0, results = {}, conflicted = false;
  const values = () => Object.fromEntries(fields.map(name => [name, form.elements[name].type === 'checkbox'
    ? form.elements[name].checked : form.elements[name].value]));
  const dirty = () => savedSignature !== null && JSON.stringify(values()) !== savedSignature;
  function status(node, message, state = 'neutral') {
    // 心跳只更新实际变化的文本，避免屏幕阅读器重复播报相同结果。
    if (node.textContent !== message) node.textContent = message;
    node.dataset.state = state;
  }
  function hydrate(settings, revision) {
    savedSettings = { ...settings };
    savedRevision = revision; conflicted = false;
    for (const name of fields) {
      const field = form.elements[name];
      if (field.type === 'checkbox') field.checked = name === 'rememberCredentials'
        ? settings[name] !== false && appState.credentialStorage?.available !== false : settings[name] === true;
      else field.value = settings[name] || '';
    }
    savedSignature = JSON.stringify(values());
  }
  function render() {
    const changed = dirty(), loading = savedSignature === null;
    form.setAttribute('aria-busy', String(!!busy));
    // 存储能力与请求锁统一由此管理，避免账号心跳或编辑其他字段时错误解锁。
    for (const name of fields) form.elements[name].disabled = !!busy || loading
      || (name === 'rememberCredentials' && appState.credentialStorage?.available === false);
    saveButton.disabled = !!busy || loading || conflicted;
    saveButton.textContent = busy === 'save' ? '保存中…' : '保存通知设置';
    reloadButton.hidden = !conflicted;
    reloadButton.disabled = !!busy;
    reloadButton.textContent = busy === 'reload' ? '载入中…' : '载入最新配置';
    for (const channel of channels) {
      const button = $('#test-' + channel), node = $('#' + channel + '-test-status');
      const configured = savedSettings[channel + 'Enabled'] && (channel === 'webhook' ? savedSettings.webhookUrl : savedSettings.wechatToken);
      button.disabled = !!busy || changed || conflicted || !configured || loading;
      button.textContent = busy === channel ? '发送中…' : '发送测试通知';
      if (busy === channel) status(node, '正在发送测试通知，请稍候…', 'pending');
      else if (loading) status(node, '正在读取已保存配置…');
      else if (conflicted) status(node, '通知配置已在其他页面修改，请先载入最新配置。');
      else if (changed) status(node, '配置已修改，请先保存后再测试。');
      else if (results[channel]) status(node, results[channel].message, results[channel].state);
      else status(node, configured ? '使用已保存配置，发送一条测试消息。' : '保存并启用此渠道后，即可测试。');
    }
  }
  function conflict() {
    conflicted = true; results = {};
    status(saveStatus, '其他页面已修改通知配置。载入最新配置会替换当前未保存输入。', 'error');
  }
  function sync(reset = false) {
    if (reset) {
      // 切换账号或首次读取时清除旧结果，迟到的请求不能被当成新账号的测试结果。
      generation++; results = {}; hydrate(appState.settings || {}, appState.notificationSettingsRevision); status(saveStatus, '');
    } else if (!busy && !conflicted && appState.notificationSettingsRevision > savedRevision) {
      // 同账号多窗口保存也要同步；保留未保存草稿，绝不悄悄将旧掩码用于新凭据。
      if (dirty()) conflict();
      else {
        results = {}; hydrate(appState.settings, appState.notificationSettingsRevision);
        status(saveStatus, '已同步其他页面保存的配置。');
      }
    }
    render();
  }
  function edited() {
    results = {}; if (!conflicted) status(saveStatus, dirty() ? '有未保存的修改。' : ''); render();
  }
  form.addEventListener('input', edited);
  form.addEventListener('change', edited);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || conflicted || savedSignature === null) return;
    const data = { ...values(), expectedRevision: savedRevision }, current = generation;
    busy = 'save'; results = {}; status(saveStatus, '正在保存…'); render();
    try {
      const response = await api('/api/notifications/settings', data);
      if (generation !== current) return;
      appState.settings = response.settings; appState.notificationSettingsRevision = response.notificationSettingsRevision;
      hydrate(response.settings, response.notificationSettingsRevision); initialSettings = true;
      status(saveStatus, '已保存，可以发送测试通知。', 'success');
    } catch (error) {
      if (generation === current) {
        if (error.code === 'NOTIFICATION_SETTINGS_CHANGED') conflict();
        else status(saveStatus, '保存失败：' + error.message, 'error');
      }
    } finally { busy = null; render(); }
  });
  reloadButton.addEventListener('click', async () => {
    if (busy) return;
    const current = generation; busy = 'reload'; render();
    try {
      const state = await api('/api/state');
      if (generation !== current) return;
      appState.settings = state.settings; appState.notificationSettingsRevision = state.notificationSettingsRevision;
      hydrate(state.settings, state.notificationSettingsRevision); results = {};
      status(saveStatus, '已载入最新配置，可重新编辑或发送测试通知。', 'success');
    } catch (error) {
      if (generation === current) status(saveStatus, '载入失败：' + error.message, 'error');
    } finally { busy = null; render(); }
  });
  for (const channel of channels) $('#test-' + channel).addEventListener('click', async () => {
    if (busy || dirty() || $('#test-' + channel).disabled) return;
    const current = generation;
    busy = channel; delete results[channel]; render();
    try {
      const response = await api('/api/notifications/test', { channel, expectedRevision: savedRevision });
      if (generation !== current) return;
      const result = response.test;
      results[channel] = { state: result.success ? 'success' : 'error',
        message: (result.success ? '发送成功' : '发送失败') + ' · ' + time(result.at) + '：' + result.message };
    } catch (error) {
      if (generation === current) {
        if (error.code === 'NOTIFICATION_SETTINGS_CHANGED') conflict();
        else results[channel] = { state: 'error', message: '未能完成测试：' + error.message };
      }
    } finally { busy = null; render(); }
  });
  window.notificationSettings = { sync };
  render();
})();
