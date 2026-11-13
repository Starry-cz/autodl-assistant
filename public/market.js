'use strict';

// 市场图表与主机明细只读；仅“用于抢卡”填写原表单，不创建或执行任务。
(() => {
  const element = id => document.getElementById(id);
  const numeric = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  // 同步时间显示完整年月日，统一使用北京时间。
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const empty = message => '<p class="market-empty">' + esc(message) + '</p>';
  const set = (id, value) => { if (element(id).textContent !== String(value)) element(id).textContent = value; };
  const html = (id, value) => {
    const node = element(id);
    if (node._rendered !== value) {
      // 同步库存会重建表格，保留外层双轴滚动与条形列表的浏览位置。
      const top = node.scrollTop, left = node.scrollLeft, barsTop = node.querySelector('.market-bar-list')?.scrollTop || 0;
      node.innerHTML = value; node._rendered = value; node.scrollTop = top; node.scrollLeft = left;
      const bars = node.querySelector('.market-bar-list'); if (bars) bars.scrollTop = barsTop;
    }
  };
  const ready = () => accountReady();
  const owner = () => appState.account?.identity?.ownerId || (appState.account?.enabled ? '' : 'local');
  const visible = () => !document.hidden && document.querySelector('.nav-item.active')?.dataset.view === 'overview';
  const externalBusy = () => !!window.workspaceSyncing || !!appState.browser?.busy || typeof gpuSyncing !== 'undefined' && gpuSyncing;
  let pending = '', lastAttempt = 0, hostOwner = null, hostModel = '', hostRegion = '', hosts = null, hostError = '';

  function ring(summary) {
    const percent = summary?.availabilityPct, known = Number.isFinite(percent), circumference = 2 * Math.PI * 64;
    // 极低的正比例不四舍五入为 0，避免与“确实没有空闲卡”混淆。
    const percentText = !known ? '—' : percent > 0 && percent < 0.1 ? '<0.1%' : percent.toFixed(1) + '%';
    return '<svg class="market-ring-svg" viewBox="0 0 200 200" role="img" aria-label="' + (known ? '目录可用比例 ' + esc(percentText) : '目录可用比例未知') + '">'
      + '<circle class="market-ring-track" cx="100" cy="100" r="64" fill="none" stroke-width="15"/>'
      + (known ? '<circle class="market-ring-fill" cx="100" cy="100" r="64" fill="none" stroke-width="15" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + circumference * (1 - percent / 100) + '" transform="rotate(-90 100 100)"/>' : '')
      + '<text class="market-ring-value" x="100" y="98" text-anchor="middle">' + esc(percentText) + '</text>'
      + '<text class="market-ring-label" x="100" y="124" text-anchor="middle">目录可用比例</text></svg>'
      + '<p class="market-chart-note">' + (summary?.complete ? numeric(summary.available) + ' 可用 / ' + numeric(summary.total) + ' 总计' : '完整同步后计算比例') + '</p>';
  }

  function barList(rows, kind) {
    if (!rows.length) return empty('尚未同步库存');
    const maximum = Math.max(1, ...rows.map(row => row.knownTotal));
    return '<div class="market-bar-list">' + rows.map(row => {
      const label = kind === 'model' ? row.model : row.region;
      const attribute = kind === 'model' ? 'data-market-model' : 'data-market-region';
      const detail = row.complete ? numeric(row.available) + ' / ' + numeric(row.total) : '已读 ' + numeric(row.knownAvailable) + ' / ' + numeric(row.knownTotal) + ' · 未完整';
      // 空闲数是操作依据，总量是参考；无障碍名称仍保留完整纯文本读数。
      const reading = row.complete ? '<strong class="market-bar-current' + (row.available === 0 ? ' is-zero' : '') + '">' + numeric(row.available) + '</strong><span class="market-bar-total-value"> / ' + numeric(row.total) + '</span>' : esc(detail);
      const totalWidth = row.knownTotal / maximum * 100, availableWidth = row.knownAvailable / maximum * 100;
      const selected = label === (kind === 'model' ? hostModel : hostRegion);
      return '<button type="button" class="market-bar-row" ' + attribute + '="' + esc(label) + '" aria-pressed="' + selected + '" aria-label="' + esc(label + '，' + detail + (kind === 'model' ? '，查看此型号在全部地区的主机' : '，查看此地区的全部型号主机')) + '">'
        + '<span class="market-bar-label">' + esc(label) + '</span><span class="market-bar-values">' + reading + '</span>'
        + '<span class="market-bar-track"><svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">'
        + '<rect class="market-bar-total" x="0" y="0" width="' + totalWidth + '" height="14" rx="3"/>'
        + '<rect class="market-bar-fill" x="0" y="0" width="' + availableWidth + '" height="14" rx="3"/></svg></span></button>';
    }).join('') + '</div>';
  }

  function heatmap(data) {
    if (!data?.models.length) return empty('尚未同步库存');
    const byKey = new Map(data.cells.map(cell => [cell.key + '\n' + cell.region, cell]));
    // 标题区已显示读数说明，表格保留无障碍名称，避免再占一行重复文字。
    return '<table class="market-heatmap-table"><caption class="visually-hidden">型号 × 地区，数值为空闲 / 总数；— 表示未列出或未确认</caption><thead><tr><th scope="col">GPU 型号</th>'
      + data.regions.map(region => '<th scope="col">' + esc(region) + '</th>').join('') + '</tr></thead><tbody>'
      + data.models.map(model => '<tr><th scope="row">' + esc(model.model) + '</th>' + data.regions.map(region => {
        const cell = byKey.get(model.key + '\n' + region), known = cell.complete;
        const intensity = known && cell.available > 0 ? Math.max(1, Math.ceil(cell.available / cell.total * 5)) : 0;
        const value = known ? '<span class="heat-reading"><strong>' + numeric(cell.available) + '</strong><span class="heat-total"> / ' + numeric(cell.total) + '</span></span>' : '—';
        const detail = model.model + '，' + region + '，' + (known ? '可用 ' + cell.available + '，总计 ' + cell.total : cell.reason);
        return '<td><button type="button" class="market-heat-cell heat-' + intensity + (!known ? ' unknown' : cell.available === 0 ? ' empty' : '')
          + '" data-market-listed="' + cell.listed + '" data-market-model="' + esc(model.model) + '" data-market-region="' + esc(region) + '" title="' + esc(detail) + '" aria-label="' + esc(detail)
          + '" aria-pressed="' + (hostModel === model.model && hostRegion === region) + '"' + (!cell.listed ? ' disabled' : '') + '>' + value + '</button></td>';
      }).join('') + '</tr>').join('') + '</tbody></table>';
  }

  function trend(history) {
    if (!history?.some(point => point.complete)) return empty('同步库存后开始记录趋势');
    // 宽度取实际栏宽，高度由响应式样式指定，避免缩放字体或由 SVG 高度反算自身。
    const chart = element('market-trend');
    const width = Math.max(200, chart.clientWidth), height = parseFloat(getComputedStyle(chart).getPropertyValue('--plot-height'));
    const left = 48, right = 22, top = 18, bottom = 38;
    const first = history[0].at, last = history.at(-1).at, maximum = Math.max(2, ...history.filter(point => point.complete).map(point => point.available));
    const x = at => first === last ? (width + left - right) / 2 : left + (at - first) / (last - first) * (width - left - right);
    const y = value => top + (1 - value / maximum) * (height - top - bottom);
    let svg = '<svg class="market-trend-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="本会话目录可用 GPU 采样趋势，失败或未完整读取处不连线">';
    for (const value of [0, maximum / 2, maximum]) svg += '<line class="market-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text class="market-chart-label" x="' + (left - 9) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + numeric(Math.round(value)) + '</text>';
    let previous = null;
    for (const point of history) {
      if (!point.complete) {
        // 缺口本身没有可用数量，折线在这里断开，只保留时间位置。
        svg += '<line class="market-trend-gap" x1="' + x(point.at) + '" x2="' + x(point.at) + '" y1="' + top + '" y2="' + (height - bottom) + '"><title>' + esc(timeFormat.format(point.at) + ' · ' + point.reason) + '</title></line>';
        previous = null; continue;
      }
      if (previous) svg += '<line class="market-trend-line" x1="' + x(previous.at) + '" y1="' + y(previous.available) + '" x2="' + x(point.at) + '" y2="' + y(point.available) + '"/>';
      svg += '<circle class="market-trend-dot" cx="' + x(point.at) + '" cy="' + y(point.available) + '" r="4" tabindex="0"><title>' + esc(timeFormat.format(point.at) + ' · 可用 ' + point.available + ' / 总计 ' + point.total) + '</title></circle>';
      previous = point;
    }
    // 窄图只保留首尾时间，避免三组时间标签相互挤压。
    const ticks = first === last ? [first] : width < 400 ? [first, last] : [first, first + (last - first) / 2, last];
    for (const at of ticks) svg += '<text class="market-chart-label" x="' + x(at) + '" y="' + (height - 14) + '" text-anchor="' + (at === first && first !== last ? 'start' : at === last && first !== last ? 'end' : 'middle') + '">' + timeFormat.format(at) + '</text>';
    return svg + '</svg><p class="market-chart-note">本次运行 · ' + history.filter(point => point.complete).length + ' 次采样</p>';
  }

  function render() {
    const state = appState.market, snapshot = state?.snapshot, summary = snapshot?.summary;
    // 其他入口刚完成目录同步时沿用该采样时间，避免自动刷新马上再读一遍。
    lastAttempt = Math.max(lastAttempt, state?.history?.at(-1)?.at || 0);
    set('market-total', numeric(summary?.total)); set('market-available', numeric(summary?.available));
    set('market-model-count', snapshot ? numeric(summary.modelCount) : '—'); set('market-region-count', snapshot ? summary.regionCount + ' / ' + summary.expectedRegions : '—');
    set('market-updated', snapshot ? dateFormat.format(snapshot.checkedAt) + '（北京时间）' : '尚未同步');
    // 指标名称已注明目录范围；状态栏只保留同步进度和需要处理的异常。
    set('market-status', !ready() ? '连接 AutoDL 后同步库存' : pending === 'catalog' || typeof gpuSyncing !== 'undefined' && gpuSyncing ? '正在同步库存…' : !snapshot ? '点击刷新目录开始'
      : snapshot.complete ? '目录已同步' : '目录未完整：' + snapshot.issues.join('；'));
    element('market-refresh').disabled = !!pending || !ready() || externalBusy();
    html('market-availability', ring(summary)); html('market-models', barList(snapshot?.models || [], 'model'));
    html('market-regions', barList(snapshot?.regions || [], 'region')); html('market-heatmap', heatmap(snapshot?.heatmap));
    html('market-trend', trend(state?.history || []));
    for (const id of ['market-models', 'market-regions', 'market-heatmap']) {
      for (const button of element(id).querySelectorAll('button')) button.disabled = !!pending || !ready() || button.dataset.marketListed === 'false';
    }
    renderHosts(); renderTracking();
  }
  function renderHosts() {
    const snapshot = appState.market?.snapshot;
    const options = (rows, selected, prompt) => '<option value="">' + prompt + '</option>'
      + [...new Set([...rows, ...(selected && !rows.includes(selected) ? [selected] : [])])].map(value => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
    html('market-host-model', options((snapshot?.models || []).map(row => row.model), hostModel, '全部型号'));
    html('market-host-region', options(appState.regions || [], hostRegion, '全部地区'));
    const onlyAvailable = element('market-host-available').checked;
    const rows = (hosts?.rows || []).filter(row => !onlyAvailable || row.available > 0 && !row.disabled);
    const selected = !!hostModel || !!hostRegion;
    const scope = (hostModel || '全部型号') + ' · ' + (hostRegion || '全部地区');
    element('market-host-model').disabled = !!pending;
    element('market-host-region').disabled = !!pending;
    element('market-host-clear').disabled = !!pending || !hostModel && !hostRegion;
    element('market-host-refresh').disabled = !!pending || !selected || !ready() || externalBusy();
    set('market-host-count', hosts ? rows.length + ' / ' + hosts.rows.length + ' 台' : '尚未读取');
    set('market-host-status', !ready() ? '连接 AutoDL 后查看主机' : pending === 'hosts' ? (!hostRegion ? '正在读取 ' + hostModel + ' 的各地区主机…' : '正在读取 ' + scope + ' 的主机…')
      : hostError ? '读取失败：' + hostError + (hosts ? '；显示 ' + dateFormat.format(hosts.checkedAt) + ' 的结果' : '')
      : !selected ? '选择型号或地区查看主机'
      : hosts ? (hosts.complete ? '' : '列表尚未完整：' + (hosts.note || hosts.error || '仍有未读取主机') + ' · ') + '同步于 ' + dateFormat.format(hosts.checkedAt) + '（北京时间）'
      : '点击刷新查看主机');
    if (!hosts || !rows.length) {
      html('market-host-list', empty(!hosts ? pending === 'hosts' ? '正在读取主机…' : selected ? '尚未读取当前筛选结果' : '尚未选择筛选条件' : onlyAvailable ? '已读结果中暂无空闲主机' : '当前筛选暂无主机'));
      return;
    }
    html('market-host-list', '<table class="market-host-table"><caption>' + esc(scope) + '</caption><thead><tr>'
      + ['主机 / 型号', '地区', '空闲 / 总数', '单卡小时价', '状态', '操作'].map(label => '<th scope="col">' + label + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map(row => '<tr><td class="host-main"><strong>' + esc(row.hostNumber || row.hostId) + '</strong><span class="host-meta">' + esc(row.model) + '</span></td>'
        + '<td>' + esc(row.region) + '</td><td class="host-availability"><strong' + (row.available > 0 ? ' class="has-stock"' : '') + '>' + numeric(row.available) + '</strong><span class="host-total"> / ' + numeric(row.total) + '</span></td>'
        + '<td class="host-price">' + (Number.isFinite(row.pricePerHour) ? '¥' + row.pricePerHour.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + '/时' : '—')
        + (row.priceNote ? '<span class="host-meta">' + esc(row.priceNote) + '</span>' : '') + '</td><td class="host-status">' + esc(row.status) + '</td>'
        + '<td><button type="button" class="button small" data-market-use-model="' + esc(row.model) + '" data-market-use-region="' + esc(row.region) + '">用于抢卡</button></td></tr>').join('') + '</tbody></table>');
  }
  function renderTracking() {
    const tracking = element('market-auto').checked;
    element('market-track-toggle').textContent = tracking ? '暂停跟踪' : '开始跟踪';
    element('market-track-toggle').setAttribute('aria-pressed', String(tracking));
    const seconds = Math.max(0, Math.ceil((lastAttempt + Number(element('market-interval').value) * 1000 - Date.now()) / 1000));
    set('market-tracking-status', pending ? (tracking ? '' : '跟踪已暂停；') + (pending === 'hosts' ? '正在读取当前主机明细' : '正在同步目录')
      : !tracking ? '跟踪已暂停' : !ready() ? '等待账号连接' : !visible() ? '返回监控室后继续'
      : externalBusy() ? '等待当前操作完成' : seconds + ' 秒后刷新' + (hostModel || hostRegion ? '目录与明细' : '目录'));
  }
  async function fetchHosts() {
    const selectedOwner = owner(), model = hostModel, region = hostRegion;
    pending = 'hosts'; hostError = ''; lastAttempt = Date.now(); render();
    try {
      // 至少限定型号或地区；由后台串行读取另一维度，空卡筛选只处理已读结果。
      const result = await api('/api/market/hosts', { model, region });
      if (selectedOwner === owner()) hosts = result;
    } catch (error) { if (selectedOwner === owner()) hostError = error.message; }
    finally { pending = ''; render(); }
  }
  async function queryHosts() {
    if (pending || (!hostModel && !hostRegion) || !ready() || externalBusy()) return;
    await fetchHosts();
  }
  async function sync(automatic = false) {
    if (pending || !ready() || externalBusy()) return;
    const selectedOwner = owner();
    pending = 'catalog'; lastAttempt = Date.now(); render();
    try {
      await syncGpuCatalog({ auto: automatic });
      // 同一轮串行读目录与明细；暂停或切换账号后不再开始第二个请求。
      if ((!automatic || element('market-auto').checked) && selectedOwner === owner() && ready() && (hostModel || hostRegion)) await fetchHosts();
    } finally { pending = ''; render(); }
  }
  function selectHosts(model, region) {
    if (pending) return;
    hostModel = model ?? hostModel; hostRegion = region ?? hostRegion; hosts = null; hostError = ''; render();
    element('market-host-model').closest('section').scrollIntoView({ block: 'start', behavior: 'auto' });
    void queryHosts();
  }
  element('market-refresh').addEventListener('click', () => void sync());
  for (const id of ['market-models', 'market-regions', 'market-heatmap']) element(id).addEventListener('click', event => {
    const button = event.target.closest('[data-market-model],[data-market-region]');
    if (!button || button.disabled) return;
    // 图条是独立筛选入口，清掉另一条件；热力格携带双条件，下拉框则保留另一项。
    selectHosts(button.dataset.marketModel || '', button.dataset.marketRegion || '');
  });
  element('market-host-model').addEventListener('change', event => selectHosts(event.target.value, undefined));
  element('market-host-region').addEventListener('change', event => selectHosts(undefined, event.target.value));
  element('market-host-available').addEventListener('change', renderHosts);
  element('market-host-refresh').addEventListener('click', () => void queryHosts());
  element('market-host-clear').addEventListener('click', () => selectHosts('', ''));
  element('market-host-list').addEventListener('click', event => {
    const button = event.target.closest('[data-market-use-model]');
    if (button) window.applyMarketSelection({ model: button.dataset.marketUseModel, region: button.dataset.marketUseRegion });
  });
  const automatic = element('market-auto'), interval = element('market-interval');
  automatic.checked = localStorage.getItem('autodl.market.auto') === '1';
  const savedInterval = localStorage.getItem('autodl.market.interval');
  interval.value = ['30', '60', '120'].includes(savedInterval) ? savedInterval : '60';
  automatic.addEventListener('change', () => { localStorage.setItem('autodl.market.auto', automatic.checked ? '1' : '0'); renderTracking(); if (automatic.checked && visible()) void sync(true); });
  element('market-track-toggle').addEventListener('click', () => { automatic.checked = !automatic.checked; automatic.dispatchEvent(new Event('change')); });
  interval.addEventListener('change', () => { localStorage.setItem('autodl.market.interval', interval.value); renderTracking(); });
  setInterval(() => {
    renderTracking();
    if (automatic.checked && visible() && Date.now() - lastAttempt >= Number(interval.value) * 1000) void sync(true);
  }, 1000);
  window.addEventListener('appstatechange', () => {
    if (hostOwner !== owner()) { hostOwner = owner(); hostModel = ''; hostRegion = ''; hosts = null; hostError = ''; }
    render();
  });
  window.addEventListener('appviewchange', render);
  window.addEventListener('resize', render);
  render();
})();
