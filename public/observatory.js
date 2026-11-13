'use strict';

// 看板只消费服务端的白名单字段；目标选择仅用于查看，开机仍经过原任务表单授权。
(() => {
  let targetId = '', targetOwner = null;
  let pending = '', lastRefresh = 0, range = 14, selectedDay = '';
  // 流水默认只预览最近五条；展开属于当前账号的阅读状态，普通轮询不会重置。
  const LEDGER_PREVIEW_ROWS = 5;
  let ledgerExpanded = false;
  const currency = new Intl.NumberFormat('zh-CN', { style:'currency', currency:'CNY', minimumFractionDigits:2, maximumFractionDigits:3 });
  const chinaTime = new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const moneyMilli = n => Number.isFinite(n) ? currency.format(n / 1000) : '—';
  const number = (n, unit = '') => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits:1 }) + unit : '—';
  const when = n => n ? chinaTime.format(new Date(n)) : '尚未同步';
  const overview = () => appState.observatory?.overview;
  const bills = () => appState.observatory?.billing;
  const ready = () => accountReady();
  const active = t => ['queued','watching','preparing','submitting','verifying','reconciling'].includes(t.state);
  const empty = message => '<div class="empty"><p>' + esc(message) + '</p></div>';
  const set = (id, value) => { const el = document.getElementById(id); if(el.textContent !== String(value))el.textContent = value; };
  const html = (id, value) => { const el = document.getElementById(id); if(el._rendered !== value){el.innerHTML = value;el._rendered = value;} };
  const go = view => document.querySelector('.nav-item[data-view="' + view + '"]').click();
  const official = '<a class="button small" href="https://www.autodl.com/console/instance/list" target="_blank" rel="noopener noreferrer">官网管理 ↗</a>';
  function statusText() {
    if(!ready())return '请先连接 AutoDL';
    if(pending)return pending === 'billing' ? '正在同步近 35 天账单…' : '正在同步实例、资源与余额…';
    const data = overview();
    if(data?.error)return '部分数据未确认：' + data.error;
    if(!data?.checkedAt)return '点击同步我的实例';
    // 成功状态保持简短，缺页或余额错误仍明确显示。
    return (data.pagination.complete ? '实例已同步' : '实例列表尚未完整：' + (data.pagination.reason || '分页未完成'))
      + (data.walletError ? ' · 余额未确认：' + data.walletError : '');
  }
  function renderOverview() {
    const data = overview(), rows = data?.instances || [], target = rows.find(i => i.id === targetId);
    const stock = data?.stock?.instanceId === targetId ? data.stock : null;
    set('overview-status', statusText());set('overview-updated', when(data?.checkedAt));
    set('overview-gpu-count', number(stock?.idleGPUs));
    set('overview-gpu-note', target ? (Number.isFinite(stock?.idleGPUs) ? '主机共 ' + number(stock.totalGPUs) + ' 张' : stock?.reason || '尚未读取主机库存') : '请选择监控实例');
    set('overview-target-count', target ? 1 : 0);
    set('overview-running-count', data?.checkedAt ? data.summary.running : '—');
    html('overview-gpus', target ? '<div class="data-row"><div><strong>' + esc(target.gpuModel || '型号未知') + ' × ' + number(target.gpuCount) + '</strong><p>' + esc(target.region || '区域未知') + ' · ' + esc(target.machineId || '主机编号未知') + '</p></div><span class="badge neutral">' + esc(target.statusLabel) + '</span></div>' : empty('请选择监控实例'));
    const watching = (appState.tasks || []).filter(t => t.config.mode === 'boot' && t.config.sourceId === targetId && t.config.action === 'execute' && active(t));
    const options = '<option value="">选择监控实例</option>' + rows.map(i => '<option value="' + esc(i.id) + '"' + (i.id === targetId ? ' selected' : '') + '>' + esc(i.name || i.id) + ' · ' + esc(i.gpuModel || '型号未知') + '</option>').join('');
    html('overview-targets', '<div class="overview-target-picker"><label>监控目标<select id="overview-target-select" aria-label="监控目标">' + options + '</select></label><button type="button" class="button" data-configure-boot="' + esc(targetId) + '"' + (!target || !ready() ? ' disabled' : '') + '>配置自动开机</button></div><p class="hint">' + (watching.length ? '开机任务：' + esc(watching.map(t => STATES[t.state] || t.state).join('、')) : '自动开机未启用') + '</p>');
    html('overview-resources', target ? resourceReadings(target) : empty('请选择监控实例'));
    const activity = (appState.notifications || []).slice(0, 6);
    html('overview-activity', activity.length ? activity.map(n => '<article class="activity-row"><div><h3>' + esc(n.name) + '</h3><p>' + esc(n.message) + '</p></div><time>' + when(n.at) + '</time></article>').join('') : empty('暂无任务动态'));
    for(const id of ['overview-refresh','fleet-refresh','billing-refresh'])document.getElementById(id).disabled = !!pending || !!appState.browser?.busy;
  }
  function resourceReadings(instance) {
    const usage = instance.usage || {};
    const gauge = (name, value, max, detail, unit) => '<div class="resource-reading"><span>' + name + '</span><strong>' + number(value, unit) + '</strong>'
      + (Number.isFinite(value) && Number.isFinite(max) && max > 0 ? '<meter min="0" max="' + max + '" value="' + Math.max(0, Math.min(value, max)) + '" aria-label="' + name + '"></meter>' : '<span class="resource-unavailable">指标未提供</span>')
      + '<p>' + esc(detail) + '</p></div>';
    const remaining = (total, used) => Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null;
    return '<div class="resource-grid">'
      + gauge('CPU 使用率', usage.cpuPercent, 100, 'CPU 核数：' + number(instance.cpuCores), '%')
      + gauge('剩余内存', remaining(instance.memoryGiB, usage.memoryUsedGiB), instance.memoryGiB, '总计 ' + number(instance.memoryGiB, ' GiB') + ' · 已用 ' + number(usage.memoryUsedGiB, ' GiB'), ' GiB')
      + gauge('系统盘剩余', remaining(instance.systemDiskGiB, usage.systemDiskUsedGiB), instance.systemDiskGiB, '总计 ' + number(instance.systemDiskGiB, ' GiB') + ' · 已用 ' + number(usage.systemDiskUsedGiB, ' GiB'), ' GiB')
      + gauge('数据盘剩余', remaining(instance.dataDiskGiB, usage.dataDiskUsedGiB), instance.dataDiskGiB, '总计 ' + number(instance.dataDiskGiB, ' GiB') + ' · 已用 ' + number(usage.dataDiskUsedGiB, ' GiB'), ' GiB')
      + '</div><p class="hint">' + esc(instance.statusLabel) + ' · ' + when(overview()?.checkedAt) + '（北京时间）</p>';
  }
  function renderFleet() {
    const data = overview(), all = data?.instances || [], query = $('#fleet-search').value.trim().toLowerCase(), filter = $('#fleet-status').value;
    const rows = all.filter(i => (!query || [i.id,i.name,i.gpuModel,i.region,i.machineId].join(' ').toLowerCase().includes(query))
      && (filter === 'all' || filter === 'running' && i.running && !i.cardless || filter === 'stopped' && i.stopped || filter === 'cardless' && i.cardless || filter === 'starting' && i.status === 'starting' || filter === 'other' && !i.running && !i.stopped && i.status !== 'starting'));
    set('fleet-count', data?.checkedAt ? rows.length + ' / ' + all.length : '—');set('fleet-updated', when(data?.checkedAt));
    const list = $('#fleet-list');
    // 原生 details 的展开属于阅读状态；同账号刷新内容后恢复，换账号不沿用旧状态。
    const opened = list._detailsOwner === targetOwner
      ? new Set([...list.querySelectorAll('details[data-instance-details][open]')].map(node => node.dataset.instanceDetails)) : new Set();
    list._detailsOwner = targetOwner;
    html('fleet-list', rows.length ? rows.map(fleetInstanceRow).join('')
      : empty(data?.checkedAt ? all.length ? '没有符合筛选条件的实例。' : '当前账号没有实例。' : '点击“同步实例”读取当前账号。'));
    for (const detail of list.querySelectorAll('details[data-instance-details]')) detail.open = opened.has(detail.dataset.instanceDetails);
  }
  function fleetField(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  function fleetCapacity(value, unit) {
    if (Number.isFinite(value) && value > 0) return number(value, unit);
    // 关机等状态可能返回 0；这不能证明该实例的真实配置就是零容量。
    return value === 0 ? '平台返回 0，分配情况待确认' : '平台未提供';
  }
  function fleetInstanceRow(instance) {
    const name = typeof instance.name === 'string' ? instance.name.trim() : '';
    const model = typeof instance.gpuModel === 'string' ? instance.gpuModel.trim() : '';
    const gpu = (model || '型号待确认') + (Number.isFinite(instance.gpuCount) && instance.gpuCount > 0 ? ' × ' + number(instance.gpuCount) : '');
    const primary = [['GPU', gpu], ['地区', instance.region || '地区待确认']];
    const details = [['完整实例 ID', instance.id || '平台未提供'], ['主机编号', instance.machineId || '平台未提供'],
      ['CPU', fleetCapacity(instance.cpuCores, ' 核')], ['内存', fleetCapacity(instance.memoryGiB, ' GiB')]];
    // 已确认磁盘配置直接显示；缺失容量放进详情，主列表不堆叠未知占位。
    for (const [label, value] of [['系统盘', instance.systemDiskGiB], ['数据盘', instance.dataDiskGiB]]) {
      if (Number.isFinite(value) && value > 0) primary.push([label, number(value, ' GiB')]);
      else details.push([label, fleetCapacity(value, ' GiB')]);
    }
    return '<article class="fleet-row"><div class="fleet-main fleet-instance-main">'
      + '<div class="fleet-heading"><h2>' + esc(name || '未命名实例') + '</h2><span class="badge' + (instance.running && !instance.cardless ? '' : ' neutral') + '">' + esc(instance.statusLabel || '状态待确认') + '</span></div>'
      + '<dl class="fleet-specs">' + primary.map(([label, value]) => fleetField(label, value)).join('') + '</dl>'
      + '<details class="fleet-disclosure" data-instance-details="' + esc(instance.id) + '"><summary>实例详情</summary>'
      + '<dl class="fleet-detail-fields">' + details.map(([label, value]) => fleetField(label, value)).join('') + '</dl></details></div>'
      + '<div class="fleet-actions"><button class="button small" type="button" data-monitor-instance="' + esc(instance.id) + '">' + (instance.id === targetId ? '查看监控' : '设为监控目标') + '</button>'
      + '<button class="button small" type="button" data-configure-boot="' + esc(instance.id) + '">配置开机</button>' + official + '</div></article>';
  }
  function renderBilling() {
    const data = bills(), wallet = overview()?.wallet;
    set('billing-updated', when(data?.checkedAt));
    set('billing-balance', moneyMilli(wallet?.balanceMilli));set('billing-voucher', moneyMilli(wallet?.vouchersMilli));set('billing-blocked', moneyMilli(wallet?.blockedMilli));
    set('billing-status', !ready() ? '请先连接 AutoDL' : pending === 'billing' ? '正在同步账单…' : data?.error ? (data.complete === false ? '账单仍有未确认数据：' : '同步失败，保留上次结果：') + data.error : data?.checkedAt ? '净消费 = 消费 − 退款' : '点击同步账单');
    const daily = [...(data?.daily || [])].sort((a,b) => a.date.localeCompare(b.date));
    const last = daily.at(-1)?.date || '', month = last.slice(0,7), period = daily.slice(-range);
    const sum = rows => rows.length && rows.every(r => r.complete && Number.isFinite(r.amountMilli)) ? rows.reduce((n,r) => n + r.amountMilli,0) : null;
    set('billing-today', moneyMilli(sum(daily.slice(-1))));set('billing-week', moneyMilli(sum(daily.slice(-7))));
    set('billing-month', moneyMilli(sum(daily.filter(r => r.date.startsWith(month)))));set('billing-period-total', moneyMilli(sum(period)));
    const partial = data && (!data.pagination.complete || daily.some(d => !d.complete));
    set('billing-coverage', data?.checkedAt ? data.dateFrom + ' 至 ' + data.dateTo + ' · ' + data.pagination.read + (data.pagination.total !== null ? ' / ' + data.pagination.total : '') + ' 条' + (partial ? ' · 尚未完整：' + (data.pagination.reason || '部分记录的日期或金额无法确认') : '') + (overview()?.walletError ? '；余额：' + overview().walletError : '') : '尚未同步账单');
    $('#billing-chart-empty').hidden = !!daily.length;
    renderChart(period);
    const items = (data?.items || []).filter(i => i.date === null || i.date >= (period[0]?.date || '') && i.date <= last);
    const groups = new Map();
    for(const item of items.filter(i => i.date !== null && (i.type === 'charge' || i.type === 'refund'))) {
      const name = item.typeLabel || (item.type === 'refund' ? '退款' : '消费');
      if(Number.isFinite(item.amountMilli))groups.set(name,(groups.get(name)||0) + item.amountMilli);
    }
    html('billing-breakdown', groups.size ? '<table class="ledger-table"><caption>近 ' + range + ' 天' + (partial ? '已读取' : '') + '消费构成</caption><thead><tr><th>项目</th><th>金额</th></tr></thead><tbody>' + [...groups].map(([name,amount]) => '<tr><td>' + esc(name) + '</td><td>' + moneyMilli(amount) + '</td></tr>').join('') + '</tbody></table>' : empty(data?.checkedAt ? '当前区间没有可归类的消费记录。' : '同步后查看消费构成。'));
    const recent = [...items].sort((a,b) => b.at - a.at).slice(0,50);
    renderTransactions(recent, !!data?.checkedAt);
  }
  function renderTransactions(recent, synced) {
    const hasMore = recent.length > LEDGER_PREVIEW_ROWS;
    if(!hasMore)ledgerExpanded = false;
    const shown = ledgerExpanded ? recent : recent.slice(0, LEDGER_PREVIEW_ROWS);
    const button = $('#billing-transactions-toggle'), list = $('#billing-transactions');
    button.hidden = !hasMore;
    button.textContent = ledgerExpanded ? '收起流水' : '展开最近 ' + recent.length + ' 条';
    button.setAttribute('aria-expanded', String(ledgerExpanded));
    list.classList.toggle('is-expanded', ledgerExpanded);
    $('#billing-transactions-count').hidden = !recent.length;
    set('billing-transactions-count', recent.length
      ? (ledgerExpanded || !hasMore ? '最近 ' + recent.length + ' 条' : '显示 ' + shown.length + ' / ' + recent.length + ' 条') + (recent.some(i => i.date === null) ? ' · 含日期待确认项' : '')
      : synced ? '当前区间暂无流水。' : '同步后查看近期流水。');
    html('billing-transactions', shown.length ? '<table class="ledger-table" aria-label="近期流水"><thead><tr><th scope="col">北京时间</th><th scope="col">项目 / 实例</th><th scope="col">类型</th><th scope="col">金额</th></tr></thead><tbody>' + shown.map(i => '<tr><td>' + (i.at ? when(i.at) : '日期未知') + '</td><td>' + esc(i.name || i.instanceId || '—') + '</td><td>' + esc(i.typeLabel || i.type) + '</td><td>' + moneyMilli(Number.isFinite(i.amountMilli) ? i.amountMilli : i.transactionMilli) + '</td></tr>').join('') + '</tbody></table>' : empty(synced ? '当前区间暂无流水。' : '同步后查看近期流水。'));
  }
  function renderChart(rows) {
    if(!rows.length){html('billing-chart','');$('#billing-chart-tooltip').hidden = true;return;}
    const values = rows.map(r => r.amountMilli).filter(Number.isFinite), maximum = Math.max(1000,...values), minimum = Math.min(0,...values);
    // 画布跟随可用宽度，手机保留 520px 横向区域，避免 SVG 缩放把日期字体缩成小字。
    const width = Math.max(520,$('#billing-chart').clientWidth), height = 260, left = 62, right = 14, top = 18, bottom = 36;
    const labelStep = Math.ceil(rows.length / 6);
    const y = value => top + (maximum - value) / (maximum - minimum) * (height - top - bottom), zero = y(0), step = (width-left-right)/rows.length;
    let svg = '<svg class="billing-chart-svg" viewBox="0 0 '+width+' '+height+'" role="group" aria-label="近 '+range+' 天每日净消费，金额单位元"><line class="chart-axis" x1="'+left+'" y1="'+zero+'" x2="'+(width-right)+'" y2="'+zero+'"/><text class="chart-label" x="4" y="'+(top+6)+'">'+moneyMilli(maximum)+'</text>';
    for(let n = 0; n < rows.length; n++) {
      const row = rows[n], known = Number.isFinite(row.amountMilli), value = known ? row.amountMilli : 0;
      const barY = Math.min(zero,y(value)), barHeight = known ? Math.max(2,Math.abs(y(value)-zero)) : 3, x = left + n*step + step*.2;
      svg += '<rect class="bar'+(!known?' missing':value<0?' refund':'')+'" x="'+x+'" y="'+barY+'" width="'+step*.6+'" height="'+barHeight+'" rx="3" tabindex="0" role="button" data-bill-date="'+row.date+'" aria-label="'+row.date+' '+(known?moneyMilli(value):'数据不完整')+'"/>';
      // 最后日期保留；省略紧挨末尾的普通刻度，避免手机上的两组日期相互挤压。
      if(n===0 || n===rows.length-1 || n%labelStep===0 && rows.length-1-n>=labelStep)svg += '<text class="chart-label" text-anchor="middle" x="'+(x+step*.3)+'" y="'+(height-10)+'">'+row.date.slice(5)+'</text>';
    }
    const markup = svg + '</svg>', changed = $('#billing-chart')._rendered !== markup;
    html('billing-chart',markup);
    // 窄屏图表可以横向浏览，首次显示及切换时段时先呈现最近日期。
    if(changed)requestAnimationFrame(showLatestDates);
    if(!rows.some(r => r.date===selectedDay))selectedDay = rows.at(-1).date;
    showDay(selectedDay);
  }
  function showLatestDates(){const chart=$('#billing-chart');chart.scrollLeft=chart.scrollWidth;}
  function showDay(date) {
    const row = bills()?.daily?.find(d => d.date === date);if(!row)return;
    selectedDay = date;const el = $('#billing-chart-tooltip');el.hidden = false;
    el.textContent = date + ' · ' + (row.complete ? '净消费 ' + moneyMilli(row.amountMilli) : '数据不完整，已读取 ' + moneyMilli(row.knownAmountMilli)) + ' · ' + row.count + ' 条记录';
  }
  function renderAll(){renderOverview();renderFleet();renderBilling();}
  async function sync(kind, automatic=false) {
    if(pending)return;
    if(!ready()){if(!automatic){toast('请先连接 AutoDL 账号');focusLogin();}return;}
    if(automatic && (appState.browser?.busy||window.workspaceSyncing))return;
    pending=kind;renderAll();const errors=[];
    try {
      // 账单和实例按顺序读取，共享后台操作锁，避免与抢卡页面操作互相打断。
      if(kind==='billing') {
        try{const result=await api('/api/observatory/billing',{});appState.observatory ||= {};appState.observatory.billing=result.billing;}catch(error){errors.push(error.message);}
      }
      try{const result=await api('/api/observatory/overview',{targetId});appState.observatory ||= {};appState.observatory.overview=result.overview;}catch(error){errors.push(error.message);}
      lastRefresh=Date.now();
      if(errors.length&&!automatic)toast(errors.join('；'),true);
    } finally {pending='';renderAll();}
  }
  async function configureBoot(id) {
    if(!id || pending)return;
    if(!ready()){toast('请先连接 AutoDL');focusLogin();return;}
    pending='overview';renderAll();
    try {
      // 复用原实例开机表单的 DOM 核验；看板 API 数据不能直接绕过付费授权。
      appState.autodlInstances=await api('/api/autodl/instances',{});
      go('dashboard');document.querySelector('[data-mode="boot"]').click();renderAccount();
      const form=$('#task-form'), option=[...form.elements.sourceId.options].find(o=>o.value===id&&!o.disabled);
      if(!option)throw new Error('该实例当前不能自动开机，请在官网核对状态。');
      form.elements.sourceId.value=id;form.elements.paidConsent.checked=false;updateAccountForm();updateForm();
      $('#live-source-fields').scrollIntoView({block:'center'});toast('已填入原实例，请核对参数并勾选费用授权后启动任务。');
    } catch(error){toast(error.message,true);} finally {pending='';renderAll();}
  }
  function selectTarget(id) {targetId=id;localStorage.setItem('autodl.overview.target.'+targetOwner,id);renderOverview();go('overview');void sync('overview');}
  $('#overview-refresh').addEventListener('click',()=>void sync('overview'));
  $('#fleet-refresh').addEventListener('click',()=>void sync('overview'));
  $('#billing-refresh').addEventListener('click',()=>void sync('billing'));
  $('#fleet-search').addEventListener('input',renderFleet);$('#fleet-status').addEventListener('change',renderFleet);
  $('#billing-range').addEventListener('change',e=>{range=Number(e.target.value);selectedDay='';ledgerExpanded=false;$('#billing-transactions').scrollTop=0;renderBilling();});
  $('#billing-transactions-toggle').addEventListener('click',()=>{
    ledgerExpanded=!ledgerExpanded;
    // 收起时回到最新记录；按钮留在滚动区外，无需先滚完全部流水。
    $('#billing-transactions').scrollTop=0;renderBilling();
  });
  $('#overview-targets').addEventListener('change',e=>{if(e.target.id==='overview-target-select')selectTarget(e.target.value);});
  for(const id of ['overview-targets','fleet-list'])$('#'+id).addEventListener('click',e=>{
    const target=e.target.closest('[data-monitor-instance]'),boot=e.target.closest('[data-configure-boot]');
    if(target)selectTarget(target.dataset.monitorInstance);
    if(boot&&!boot.disabled)void configureBoot(boot.dataset.configureBoot);
  });
  for(const event of ['mouseover','focusin','click'])$('#billing-chart').addEventListener(event,e=>{const bar=e.target.closest('[data-bill-date]');if(bar)showDay(bar.dataset.billDate);});
  $('#billing-chart').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const bar=e.target.closest('[data-bill-date]');if(bar){e.preventDefault();showDay(bar.dataset.billDate);}}});
  const automatic=$('#overview-auto-refresh');automatic.checked=localStorage.getItem('autodl.overview.auto')==='1';
  automatic.addEventListener('change',()=>{localStorage.setItem('autodl.overview.auto',automatic.checked?'1':'0');if(automatic.checked)void sync('overview');});
  setInterval(()=>{const view=document.querySelector('.nav-item.active')?.dataset.view;if(automatic.checked&&!document.hidden&&['overview','fleet'].includes(view)&&Date.now()-lastRefresh>=30000)void sync('overview',true);},30000);
  window.addEventListener('appstatechange',()=>{
    const owner=appState.account?.identity?.ownerId || (appState.account?.enabled?'':'local');
    if(owner!==targetOwner){targetOwner=owner;targetId=owner?localStorage.getItem('autodl.overview.target.'+owner)||'':'';ledgerExpanded=false;$('#billing-transactions').scrollTop=0;}
    renderAll();
  });
  window.addEventListener('appviewchange',event=>{renderAll();if(event.detail.view==='billing')requestAnimationFrame(showLatestDates);});
  renderAll();
})();
