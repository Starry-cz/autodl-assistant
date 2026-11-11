import { AppError } from '../errors.mjs';
import { REGIONS } from '../config.mjs';
import { gpuKey } from '../matching.mjs';
import { marketHostQuery } from './autodl-market.mjs';

// 接口和字段核对于 2026-11-06 官方公开前端：service-code.bb17a80f.js、
// components.27efcd29.js、utils.af1d555c.js、index.f223598a.js、index.3f0bd7d5.js。
// 页面只执行查询；网页 Token 留在页面中，Node 仅收到下列字段投影。
export async function readInventoryInPage({ kind, params = {} }) {
  const endpoints = {
    regions: { method: 'GET', path: '/api/v1/region/list' },
    gpus: { method: 'POST', path: '/api/v1/machine/region/gpu_type' },
    hosts: { method: 'POST', path: '/api/v1/user/machine/list' },
    membership: { method: 'GET', path: '/api/v1/user/member/detail' },
  };
  if ((!endpoints[kind] && kind !== 'task-gpus') || location.origin !== 'https://www.autodl.com') return { error: 'SESSION' };
  try {
    const token = localStorage.getItem('token');
    if (!token) return { error: 'AUTH' };
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const app = JSON.parse(localStorage.getItem('app_version') || '{"version":"0.0.0"}');
    // 库存和会员接口都不在官网拦截器的例外表中，子账号统一替换此路径前缀。
    const subName = user?.sub_name || '', prefix = subName ? '/api/v1/sub_user' : '/api/v1';
    const sameSession = () => {
      try { return localStorage.getItem('token') === token
        && (JSON.parse(localStorage.getItem('user') || 'null')?.sub_name || '') === subName; }
      catch { return false; }
    };
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && Object.hasOwn(value, key)
      && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))).map(key => [key, value[key]]));
    // 同一批读取共用网页内的身份快照和字段投影；凭据不传出页面，也不为并行复制另一套请求逻辑。
    const query = async (queryKind, queryParams, cancelled = null) => {
      try {
        if (!sameSession()) return { error: 'CHANGED' };
        const endpoint = endpoints[queryKind], url = new URL(endpoint.path.replace('/api/v1', prefix), location.origin);
        const headers = { Authorization: token, AppVersion: String(app.version || '0.0.0') };
        if (endpoint.method === 'POST') headers['Content-Type'] = 'application/json';
        const timeout = AbortSignal.timeout(15000);
        const response = await fetch(url.href, { method: endpoint.method, headers, credentials: 'include',
          redirect: 'error', signal: cancelled ? AbortSignal.any([timeout, cancelled]) : timeout,
          ...(endpoint.method === 'POST' ? { body: JSON.stringify(queryParams) } : {}) });
        if (!sameSession()) return { error: 'CHANGED' };
        if (response.status === 401 || response.status === 403) return { error: 'AUTH' };
        if (!response.ok) return { error: response.status === 429 || response.status >= 500 ? 'TRANSIENT' : 'API' };
        const result = await response.json();
        if (!sameSession()) return { error: 'CHANGED' };
        if (result?.code === 'AuthorizeFailed') return { error: 'AUTH' };
        if (result?.code !== 'Success') return { error: 'API' };
        const data = result.data;
        if (queryKind === 'membership') {
          if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'SCHEMA' };
          return { data: pick(data, ['member_level']) };
        }
        if (queryKind === 'regions') {
          if (!Array.isArray(data)) return { error: 'SCHEMA' };
          return { data: data.map(row => pick(row, ['data_center', 'region_name', 'region_sign', 'used_for', 'visible'])) };
        }
        if (queryKind === 'gpus') {
          if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return { error: 'SCHEMA' };
          return { data: data.map(row => Object.fromEntries(Object.entries(row)
            .map(([model, stock]) => [model, pick(stock, ['idle_gpu_num', 'total_gpu_num'])]))) };
        }
        if (!data || !Array.isArray(data.list)) return { error: 'SCHEMA' };
        const list = data.list.map(row => ({
          ...pick(row, ['machine_id', 'machine_alias', 'gpu_name', 'gpu_number', 'gpu_idle_num', 'region_name', 'region_sign',
            'on_line', 'max_instance_num', 'binding_instance_num']),
          machine_sku_info: Array.isArray(row?.machine_sku_info) ? row.machine_sku_info.map(sku => ({
            ...pick(sku, ['type', 'current_price']),
            level_config: Array.isArray(sku?.level_config) ? sku.level_config.map(level => pick(level, ['level_name', 'discount'])) : [],
          })) : [],
        }));
        return { data: { list, ...pick(data, ['result_total', 'max_page']) } };
      } catch {
        // 主动结束其余只读查询属于批次收尾，不作为库存失败写回会话。
        return { error: cancelled?.aborted ? 'CANCELLED' : 'NETWORK' };
      }
    };
    if (kind !== 'task-gpus') return await query(kind, params);

    const { groups, modelKey } = params, rows = new Array(groups.length), controller = new AbortController();
    let cursor = 0, stopped = false, failure = null;
    const stop = error => { failure = error || null; stopped = true; controller.abort(); };
    const knownZero = data => {
      const matches = data.flatMap(row => Object.entries(row))
        .filter(([model]) => String(model).toUpperCase().replace(/[\s_-]/g, '') === modelKey);
      if (matches.length !== 1) return false;
      const stock = matches[0][1];
      return Number.isSafeInteger(stock.total_gpu_num) && stock.total_gpu_num >= 0 && stock.idle_gpu_num === 0;
    };
    const worker = async () => {
      while (!stopped && cursor < groups.length) {
        const index = cursor++, group = groups[index];
        if (!sameSession()) { stop('CHANGED'); return; }
        if (!group.signs.length) {
          rows[index] = { region: group.region, ...(group.error ? { error: group.error } : { missing: true }) };
          stop(); return;
        }
        const result = await query('gpus', { region_sign_list: group.signs }, controller.signal);
        // 已明确返回的会话错误优先于另一区的库存命中；主动取消不冒充登录失效。
        if (result.error === 'AUTH' || result.error === 'CHANGED') { stop(result.error); return; }
        // 命中/失败之后已取消的其他响应不再改变本批结果；最后仍会核对登录身份。
        if (stopped) return;
        if (result.error) { stop(result.error); return; }
        rows[index] = { region: group.region, data: result.data };
        if (!knownZero(result.data)) { stop(); return; }
      }
    };
    // 只读预筛最多同时查询两个地区。首个非明确零即停止派发，取消并收齐其余请求后才允许主页面导航。
    const workers = Array.from({ length: Math.min(2, groups.length) }, () => worker());
    try { await Promise.all(workers); }
    finally { controller.abort(); await Promise.allSettled(workers); }
    if (!sameSession()) return { error: 'CHANGED' };
    if (failure) return { error: failure };
    return { data: rows.filter(Boolean) };
  } catch {
    // 平台响应和异常可能包含网页凭据，不把原文转交服务或日志。
    return { error: 'NETWORK' };
  }
}

export async function readAutodlInventory(adapter, kind, params = {}) {
  const page = adapter.page;
  if (adapter.session?.state !== 'ready' || !page || page.isClosed() || !page.url().startsWith('https://www.autodl.com/'))
    throw new AppError('INVENTORY_SESSION', '请先连接 AutoDL 账号再读取库存', { status: 409 });
  let result;
  try { result = await page.evaluate(readInventoryInPage, { kind, params }); }
  catch { throw new AppError('INVENTORY_UNAVAILABLE', 'AutoDL 库存查询未完成，请稍后重试', { status: 503, retryable: true }); }
  if (result?.error === 'AUTH') {
    adapter.setSession('expired', { checked: true });
    throw new AppError('INVENTORY_AUTH', 'AutoDL 网页登录已失效，请重新连接账号', { status: 409 });
  }
  if (result?.error === 'CHANGED')
    throw new AppError('INVENTORY_SESSION', '库存读取期间账号已切换，请重新连接账号', { status: 409 });
  if (result?.error || result?.data == null)
    throw new AppError('INVENTORY_UNAVAILABLE', 'AutoDL 库存接口暂不可用或数据格式已变化', {
      status: 503, retryable: ['NETWORK', 'TRANSIENT'].includes(result?.error),
    });
  return result.data;
}

const text = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sessionError = error => ['INVENTORY_SESSION', 'INVENTORY_AUTH'].includes(error?.code);
const gpuModels = data => data.flatMap(row => Object.entries(row).map(([model, stock]) => {
  const total = count(stock.total_gpu_num), available = count(stock.idle_gpu_num);
  return { model, available: available !== null && total !== null && available > total ? null : available,
    total, disabled: false };
}));

// 官网按 data_center 合并 region_sign，同一地区可能包含多个机房签名，不能只取第一条。
export function inventoryRegions(rows, requested = REGIONS) {
  const groups = new Map();
  for (const row of rows) {
    const center = text(row?.data_center), name = text(row?.region_name), sign = text(row?.region_sign);
    if (!center || !name || !sign) continue;
    if (!groups.has(center)) groups.set(center, { region: name, signs: [] });
    const group = groups.get(center);
    if (!group.signs.includes(sign)) group.signs.push(sign);
  }
  return requested.map(region => {
    const matches = [...groups.values()].filter(group => group.region === region);
    return matches.length === 1 ? matches[0] : { region, signs: [], missing: !matches.length,
      ...(matches.length > 1 ? { error: '地区名称对应多个机房分组，未猜测地区签名' } : {}) };
  });
}

// 只有精确型号的完整、有效零库存证据才能省略主机读取；缺项、歧义和未知值仍需进入 DOM 核验。
export function catalogRegionHasNoStock(row, model) {
  if (!row || row.missing || row.disabled || row.error) return false;
  const models = (row.models || []).filter(item => gpuKey(item.model) === gpuKey(model));
  if (models.length !== 1) return false;
  const stock = models[0];
  return Number.isInteger(stock.available) && Number.isInteger(stock.total)
    && stock.total >= 0 && stock.available === 0;
}

async function collectGpuCatalog(adapter, regions, { strict = false } = {}) {
  const groups = inventoryRegions(await readAutodlInventory(adapter, 'regions'), regions), rows = [];
  for (const group of groups) {
    if (!group.signs.length) {
      rows.push({ region: group.region, models: [], ...(group.error ? { error: group.error } : { missing: true }) });
      continue;
    }
    try {
      const data = await readAutodlInventory(adapter, 'gpus', { region_sign_list: group.signs });
      rows.push({ region: group.region, models: gpuModels(data) });
    } catch (error) {
      // 任务读取失败直接退避或暂停；看板允许展示明确标记的部分结果。
      if (strict || sessionError(error)) throw error;
      rows.push({ region: group.region, models: [], error: '该地区型号库存读取失败' });
    }
  }
  return { checkedAt: Date.now(), regions: rows };
}

export async function readGpuCatalogApi(adapter, regions = REGIONS, { strict = false } = {}) {
  return collectGpuCatalog(adapter, regions, { strict });
}

// 抢卡预筛只回答“是否全部明确无卡”；浏览器内以两个只读请求并行，首个非零/未知即可继续匹配。
// 看板仍串行读取完整目录；任务的部分结果不冒充全市场快照，所有在途请求在本方法返回前收尾。
export async function readTaskGpuCatalogApi(adapter, regions, model) {
  const groups = inventoryRegions(await readAutodlInventory(adapter, 'regions'), regions);
  const rows = await readAutodlInventory(adapter, 'task-gpus', { groups, modelKey: gpuKey(model) });
  return { checkedAt: Date.now(), regions: rows.map(row => row.data
    ? { region: row.region, models: gpuModels(row.data) }
    : { ...row, models: [] }) };
}

export function inventoryHostQuery({ signs, model = '', pageIndex = 1, pageSize = 90 }) {
  // 保持官网 service 默认排序及查询字段；0 表示不排除暂无空卡的主机。
  return { charge_type: 'payg', region_sign: '', region_sign_list: signs, gpu_type_name: model ? [model] : [],
    machine_tag_name: [], gpu_idle_num: 0, mount_net_disk: false, cpu_arch: [], chip_corp: [],
    instance_disk_size_order: '', date_range: '', date_from: '', date_to: '', page_index: pageIndex, page_size: pageSize,
    pay_price_order: '', gpu_idle_type: '', default_order: true };
}

export function inventoryHourlyPrice(row, memberLevel) {
  const sku = row.machine_sku_info?.find(item => item.type === 'payg');
  const level = ['member_level_1', 'member_level_2', 'member_level_3'].includes(memberLevel) ? 'member_user' : memberLevel;
  const discount = sku?.level_config?.find(item => item.level_name === level)?.discount;
  // 官网页面用会员档位折扣和毫元价格计算两位小数；缺任一证据就保留未知价格。
  if (!level || !Number.isFinite(sku?.current_price) || sku.current_price < 0
    || !Number.isFinite(discount) || discount < 0 || discount > 100) return null;
  return Math.round(Math.round(sku.current_price * discount / 100) / 10) / 100;
}

export function normalizeInventoryHost(row, group, memberLevel) {
  const hostId = text(row?.machine_id), model = text(row?.gpu_name), sign = text(row?.region_sign);
  if (!hostId || !model || !group.signs.includes(sign)) return null;
  const total = count(row.gpu_number), idle = count(row.gpu_idle_num);
  const maximum = count(row.max_instance_num), bound = count(row.binding_instance_num), online = count(row.on_line);
  const offline = [3, 4, 5, 6].includes(online), full = maximum !== null && bound !== null && bound >= maximum;
  const statusKnown = online !== null && maximum !== null && bound !== null;
  // 官网对不可用/实例名额已满的主机显示可租空卡为 0；缺失状态不伪造成 0。
  const available = offline || full ? 0 : statusKnown && idle !== null && total !== null && idle <= total ? idle : null;
  const pricePerHour = inventoryHourlyPrice(row, memberLevel);
  return { hostId, hostNumber: text(row.machine_alias) || hostId, model, region: group.region, available, total, pricePerHour,
    disabled: offline || full || available === null || available === 0,
    status: offline ? '当前不可选' : full ? '实例名额已满' : available === null ? '空闲数未知' : available > 0 ? '有空闲资源' : '暂无空闲资源',
    ...(pricePerHour === null ? { priceNote: '未确认当前账号的每卡小时价' } : {}) };
}

async function collectRegionHosts(adapter, group, model, { pageSize, maxPages, memberLevel }) {
  const hosts = new Map(); let pages = 0, total = null, lastPage = null, changed = false, duplicate = false, invalid = false, complete = false, note = '';
  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    let data;
    try { data = await readAutodlInventory(adapter, 'hosts', inventoryHostQuery({ signs: group.signs, model, pageIndex, pageSize })); }
    catch (error) {
      if (sessionError(error)) throw error;
      note = `第 ${pageIndex} 页读取失败，仅显示已读主机`; break;
    }
    pages++;
    const nextTotal = count(data.result_total), nextLastPage = count(data.max_page);
    if (total !== null && nextTotal !== null && total !== nextTotal) changed = true;
    if (lastPage !== null && nextLastPage !== null && lastPage !== nextLastPage) changed = true;
    if (nextTotal !== null) total = nextTotal;
    if (nextLastPage !== null) lastPage = nextLastPage;
    let added = 0;
    for (const row of data.list) {
      const host = normalizeInventoryHost(row, group, memberLevel);
      if (!host || model && gpuKey(host.model) !== gpuKey(model)) { invalid = true; continue; }
      if (hosts.has(host.hostId)) { duplicate = true; continue; }
      hosts.set(host.hostId, host); added++;
    }
    const empty = !data.list.length, countReached = total !== null && hosts.size >= total;
    // 官网明确还有下一页时，即使本页较短也继续；数量提前达到总数则记录元数据冲突。
    if (lastPage !== null && pageIndex < lastPage && countReached) changed = true;
    const ended = lastPage !== null ? pageIndex >= lastPage || empty
      : countReached || empty || total === null && data.list.length < pageSize;
    if (ended) {
      const pageComplete = lastPage === null || pageIndex === lastPage || lastPage === 0 && pageIndex === 1 && !hosts.size;
      // 已知分页中途出现空页不能当作读完；空目录可由第 1 页和 0/1 个总页数确认。
      const emptyConsistent = !empty || lastPage === null || pages === 1 && !hosts.size && lastPage <= 1;
      complete = !changed && !duplicate && !invalid && pageComplete && emptyConsistent && (total === null || hosts.size === total);
      if (!complete) note = '分页期间数量、顺序或主机字段未能完整确认';
      break;
    }
    if (!added) { note = invalid ? '当前页存在无法精确确认的主机字段，读取未完整' : '分页返回重复主机，读取未完整'; break; }
    if (pageIndex === maxPages) note = `已达到 ${maxPages} 页读取上限，仅显示已读主机`;
  }
  return { rows: [...hosts.values()], region: group.region, pages, count: hosts.size, complete, note };
}

export async function readMarketHostsApi(adapter, options, { pageSize = 90, maxPages = 100 } = {}) {
  const { model, region } = marketHostQuery(options);
  const groups = inventoryRegions(await readAutodlInventory(adapter, 'regions'), region ? [region] : REGIONS);
  // 官网通过 member/detail 更新会员档位；一次明细查询只读一次，不逐主机询价。
  let memberLevel = null;
  try { memberLevel = text((await readAutodlInventory(adapter, 'membership')).member_level) || null; }
  catch (error) { if (sessionError(error)) throw error; }
  const rows = [], results = [];
  // 按地区和页码顺序请求；不为加速向平台并发扫完整市场。
  for (const group of groups) {
    if (!group.signs.length) {
      results.push({ region: group.region, pages: 0, count: 0, complete: false, note: group.error || '地区目录未列出该地区' }); continue;
    }
    const result = await collectRegionHosts(adapter, group, model, { pageSize, maxPages, memberLevel });
    rows.push(...result.rows);
    const { rows: ignored, ...summary } = result;
    results.push(summary);
  }
  return { checkedAt: Date.now(), model, region, rows, complete: results.every(result => result.complete), regions: results,
    pages: results.reduce((sum, result) => sum + result.pages, 0), source: 'AutoDL 按量计费主机列表',
    note: results.filter(result => !result.complete).map(result => result.region + '：' + result.note).join('；'),
    priceNote: '官网列表显示的每卡小时价；实际费用以提交时配置报价为准。' };
}
