'use strict';

// 监测显示只消费后端采样与调度时间，不根据前端间隔推测库存或下一轮时间。
(() => {
  let clockOffset = 0;
  const exporting = new Set();
  const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const scopeLabel = scope => ({ target: '原实例', 'first-page': '首页已读范围', full: '完整扫描范围' }[scope] || '读取范围未确认');
  const samplesOf = task => (task.monitor?.samples || []).slice(-60);

  function reading(sample) {
    if (!sample) return '未采样';
    if (sample.status === 'error') return '检查失败';
    if (sample.kind === 'boot') return sample.status !== 'ok' ? 'GPU 待确认' : sample.gpuAvailable === true ? 'GPU 充足' : sample.gpuAvailable === false ? 'GPU 不足' : 'GPU 待确认';
    if (sample.complete && sample.status === 'ok' && Number.isFinite(sample.available))
      return '空闲 ' + number(sample.available) + (Number.isFinite(sample.total) ? ' / ' + number(sample.total) : '') + ' 张 · ' + scopeLabel(sample.scope);
    if (Number.isFinite(sample.knownAvailable)) return '已读空卡 ' + number(sample.knownAvailable) + ' 张 · ' + scopeLabel(sample.scope) + '（未完整）';
    return '库存待确认 · ' + scopeLabel(sample.scope);
  }

  function countdown(task, now) {
    if (!ACTIVE.includes(task.state)) return ({ paused: '已暂停', cancelled: '已停止', expired: '监测已到期', found: '已找到资源', completed: '已完成', attention: '等待处理', reconciling: '等待核对' }[task.state] || STATES[task.state] || task.state);
    if (task.monitor?.checking) return '检查中';
    if (task.state === 'submitting') return '正在提交';
    if (task.state === 'preparing') return '正在核对配置';
    if (!Number.isFinite(task.nextCheckAt)) return '等待检查安排';
    const seconds = Math.ceil((task.nextCheckAt - now) / 1000);
    return seconds > 0 ? '下次检查 ' + seconds + ' 秒' : '等待检查';
  }

  function summary(task) {
    const sample = samplesOf(task).at(-1), checkedAt = task.monitor?.lastCheckedAt || sample?.at;
    // 占位文字固定，倒计时由 tick 单独写入，避免每两秒改变整个任务卡的 HTML 签名。
    return '<div class="task-monitor-summary"><span>最近库存 <strong data-monitor-latest title="' + esc(sample?.note || '') + '">' + esc(reading(sample)) + '</strong></span>'
      + '<span>上次检查 <time data-monitor-checked title="' + esc(checkedAt ? time(checkedAt, true) : '尚未检查') + '">' + (checkedAt ? time(checkedAt) : '—') + '</time></span>'
      + '<span class="task-next-check" data-task-countdown="' + esc(task.id) + '" data-next="' + esc(task.nextCheckAt ?? '') + '">—</span></div>';
  }

  function pointValue(sample, boot) {
    if (sample.status === 'error') return null;
    if (boot) return sample.status === 'ok' && typeof sample.gpuAvailable === 'boolean' ? { value: sample.gpuAvailable ? 1 : 0, partial: false } : null;
    if (sample.status === 'ok' && sample.complete && Number.isFinite(sample.available)) return { value: sample.available, partial: false };
    // 部分结果只画已读值的空心点，不把缺失主机当作零，也不接入完整数量折线。
    return Number.isFinite(sample.knownAvailable) ? { value: sample.knownAvailable, partial: true } : null;
  }

  function chart(task, samples) {
    if (!samples.length) return '<p class="task-monitor-empty">尚未采样。开始检查后显示实际读取结果，不补造历史。</p>';
    const boot = task.config.mode === 'boot', points = samples.map(sample => pointValue(sample, boot));
    const width = 640, height = 196, left = 56, right = 18, top = 24, bottom = 46;
    const maximum = boot ? 1 : Math.max(1, ...points.filter(Boolean).map(point => point.value));
    const x = index => samples.length === 1 ? (width + left - right) / 2 : left + index * (width - left - right) / (samples.length - 1);
    const y = value => top + (1 - value / maximum) * (height - top - bottom);
    let svg = '<svg class="task-sample-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + (boot ? '最近采样的原实例 GPU 充足与不足状态，未知或错误处断开' : '最近采样空闲卡数；空心点仅代表已读范围，未知或错误处断开') + '">';
    const ticks = boot ? [{ value: 1, label: '充足' }, { value: 0, label: '不足' }] : [maximum, maximum > 1 ? Math.round(maximum / 2) : null, 0].filter(value => value !== null).map(value => ({ value, label: number(value) }));
    for (const tick of ticks) svg += '<line class="task-sample-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(tick.value) + '" y2="' + y(tick.value) + '"/><text class="task-sample-label" x="' + (left - 10) + '" y="' + (y(tick.value) + 5) + '" text-anchor="end">' + tick.label + '</text>';
    let previous = null;
    samples.forEach((sample, index) => {
      const point = points[index], detail = time(sample.at, true) + ' · ' + reading(sample) + (sample.note ? ' · ' + sample.note : '');
      if (!point) {
        svg += '<line class="task-sample-gap" data-sample-index="' + index + '" x1="' + x(index) + '" x2="' + x(index) + '" y1="' + top + '" y2="' + (height - bottom) + '" tabindex="0" aria-label="' + esc(detail) + '"><title>' + esc(detail) + '</title></line>';
        previous = null; return;
      }
      // 完整点也只连接相邻、同范围的读数，避免把首页与完整扫描误看作同一总量。
      if (!point.partial && previous && !previous.point.partial && previous.sample.scope === sample.scope)
        svg += '<line class="task-sample-line" data-from-index="' + previous.index + '" data-to-index="' + index + '" x1="' + x(previous.index) + '" y1="' + y(previous.point.value) + '" x2="' + x(index) + '" y2="' + y(point.value) + '"/>';
      svg += '<circle class="task-sample-point' + (point.partial ? ' task-sample-partial' : '') + '" data-sample-index="' + index + '" cx="' + x(index) + '" cy="' + y(point.value) + '" r="3.5" tabindex="0" aria-label="' + esc(detail) + '"><title>' + esc(detail) + '</title></circle>';
      previous = { sample, point, index };
    });
    const first = samples[0], last = samples.at(-1);
    svg += '<text class="task-sample-label" x="' + left + '" y="' + (height - 13) + '" text-anchor="start">' + time(first.at) + '</text>';
    if (samples.length > 1) svg += '<text class="task-sample-label" x="' + (width - right) + '" y="' + (height - 13) + '" text-anchor="end">' + time(last.at) + '</text>';
    return '<div class="task-sample-chart" tabindex="0" aria-label="最近采样图，可横向滚动">' + svg + '</svg></div>';
  }

  function history(task) {
    const samples = samplesOf(task), boot = task.config.mode === 'boot';
    return '<details class="task-monitor-history" data-monitor-history="' + esc(task.id) + '"><summary><span>最近 60 次采样</span><small>' + (samples.length ? '已记录 ' + samples.length + ' 次' : '未采样') + '</small></summary>'
      + '<div class="task-monitor-history-body">' + summary(task) + chart(task, samples)
      + '<p class="task-sample-note">' + (boot ? '纵轴为 GPU 是否充足，不代表卡数。' : '实心点为完整读数；空心点仅为已读空卡，不代表全范围总量。不同扫描范围不连线。') + '未知或失败处断开。横向按检查顺序排列，可聚焦采样点查看时间与说明。</p></div></details>';
  }

  function tick() {
    const tasks = new Map(appState.tasks.map(task => [String(task.id), task])), now = Date.now() + clockOffset;
    for (const node of document.querySelectorAll('[data-task-countdown]')) {
      const task = tasks.get(node.dataset.taskCountdown);
      if (task) { const text = countdown(task, now); if (node.textContent !== text) node.textContent = text; }
    }
  }

  async function exportLogs(id) {
    if (exporting.has(id)) return;
    exporting.add(id);
    const owner = appState.account?.identity?.ownerId;
    const buttons = () => [...document.querySelectorAll('[data-export-logs]')].filter(button => button.dataset.exportLogs === id);
    buttons().forEach(button => { button.disabled = true; button.textContent = '正在导出…'; });
    try {
      const result = await api('/api/tasks/' + encodeURIComponent(id) + '/logs');
      // 等待期间切账号或关闭旧任务详情时，不下载此前账号的响应。
      if (owner !== appState.account?.identity?.ownerId || !appState.tasks.some(task => String(task.id) === id) || !document.getElementById('task-dialog').open || String(detailId) !== id) return;
      const task = result.task;
      const lines = ['AutoDL 任务日志', '任务：' + task.name, '任务 ID：' + task.id, '类型：' + modeLabel(task.mode), '状态：' + (STATES[task.state] || task.state),
        '创建：' + time(task.createdAt, true), '更新：' + time(task.updatedAt, true), '本机最近最多 ' + result.limit + ' 条日志，本次导出 ' + result.logs.length + ' 条。', '',
        ...result.logs.map(log => '[' + time(log.at, true) + '] [' + log.level + '] ' + log.message)];
      const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'AutoDL-' + String(task.name || task.id).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 70) + '-日志.txt';
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出本机最近 ' + result.logs.length + ' 条日志。');
    } catch (error) { toast(error.message, true); }
    finally { exporting.delete(id); buttons().forEach(button => { button.disabled = false; button.textContent = '导出日志'; }); }
  }

  window.taskMonitor = { summary, history, tick, exportLogs, setClock(now) { clockOffset = now - Date.now(); } };
})();
