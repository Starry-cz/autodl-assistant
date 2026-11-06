import { AppError } from './errors.mjs';

export const OBSERVATORY_TIME_ZONE = 'Asia/Shanghai';
export const OBSERVATORY_BILL_DAYS = 35;
const DAY = 86400000, GIB = 2 ** 30;
const text = value => typeof value === 'string' ? value.trim() || null : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = value => Number.isSafeInteger(value) ? value : null;
const gib = value => number(value) === null ? null : value / GIB;
const percent = (used, total) => number(used) !== null && number(total) !== null && total > 0 ? used / total * 100 : null;
const safeError = error => error instanceof AppError ? error.message : 'AutoDL 只读查询未完成，请稍后刷新';
const isAuth = error => ['OBSERVATORY_AUTH', 'OBSERVATORY_SESSION'].includes(error?.code);

// 无时区的平台时间按上海时间解释；带偏移的 ISO 时间遵循自身偏移，不使用服务器本地时区。
export function parseAutodlTime(value) {
  let timestamp = null;
  if (typeof value === 'number' && Number.isFinite(value)) timestamp = value > 1e11 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const input = value.trim();
    const local = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(input);
    timestamp = Date.parse(local ? input.length === 10 ? input + 'T00:00:00+08:00' : input.replace(' ', 'T') + '+08:00' : input);
  }
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8640000000000000 ? timestamp : null;
}
export function shanghaiDate(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  // 上海没有夏令时，按 UTC+8 取自然日，和机器运行位置无关。
  return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
}
export function billingRange(now, days = OBSERVATORY_BILL_DAYS) {
  if (days !== OBSERVATORY_BILL_DAYS) throw new AppError('OBSERVATORY_RANGE', '账单固定读取近35个上海自然日，显示范围可在页面选择');
  const dateTo = shanghaiDate(now), midnight = Date.parse(dateTo + 'T00:00:00+08:00');
  return { days, dateFrom: shanghaiDate(midnight - (days - 1) * DAY), dateTo,
    // 官网将日期原样传给后端，结束日是否包含整天未公开；多取明日边界，再按交易日裁剪。
    queryDateTo: shanghaiDate(midnight + DAY), dates: Array.from({ length: days }, (_, i) => shanghaiDate(midnight - (days - 1 - i) * DAY)) };
}

const STATUS = { running: '运行中', shutdown: '已关机', starting: '开机中', shutting_down: '关机中',
  shutdown_by_starting_error: '开机失败，已关机', shutdown_by_running_error: '运行异常，已关机' };
const stoppedStates = new Set(['shutdown', 'shutdown_by_starting_error', 'shutdown_by_running_error']);

export function normalizeObservatoryInstance(row, monitor = null) {
  const id = text(row?.uuid), monitored = monitor && text(monitor.uuid) === id;
  const usage = monitored ? monitor.UsageInfo || {} : row?.usage_info || {};
  const status = text(row?.status) || 'unknown', knownStatus = Object.hasOwn(STATUS, status);
  const cardless = ['running', 'starting'].includes(status) ? text(row?.start_mode) === null ? null : row.start_mode === 'non_gpu' : knownStatus ? false : null;
  const systemTotal = monitored ? usage.root_fs_total_size : number(row?.root_fs_total_size) ?? usage.root_fs_total_size;
  const systemUsed = monitored ? usage.root_fs_used_size : number(row?.root_fs_used_size) ?? usage.root_fs_used_size;
  return {
    id, name: text(row?.name), status, statusLabel: cardless ? status === 'running' ? '无卡运行中' : '无卡开机中' : STATUS[status] || '状态未知',
    running: knownStatus ? status === 'running' : null, stopped: knownStatus ? stoppedStates.has(status) : null, cardless,
    region: text(row?.region_name), regionSign: text(row?.region_sign), gpuModel: text(row?.gpu_type_name),
    gpuCount: integer(row?.req_gpu_amount), machineId: text(row?.machine_id), cpuCores: monitored ? number(monitor.cpu_number) : null,
    memoryGiB: gib(usage.mem_limit), systemDiskGiB: gib(systemTotal), dataDiskGiB: gib(usage.data_disk_total_size),
    usage: { cpuPercent: number(usage.cpu_usage_percent), memoryUsedGiB: gib(usage.mem_usage),
      memoryPercent: number(usage.mem_usage_percent) ?? percent(usage.mem_usage, usage.mem_limit),
      systemDiskUsedGiB: gib(systemUsed), systemDiskPercent: percent(systemUsed, systemTotal),
      dataDiskUsedGiB: gib(usage.data_disk_used_size), dataDiskPercent: percent(usage.data_disk_used_size, usage.data_disk_total_size),
      // 已证实的监控接口没有 GPU 利用率、显存使用或历史曲线字段，保持缺失。
      gpuPercent: null, gpuMemoryUsedGiB: null, gpuMemoryPercent: null },
    createdAt: parseAutodlTime(row?.created_at), startedAt: null, priceHourlyMilli: null,
  };
}

export function normalizeObservatoryWallet(row) {
  return { balanceMilli: money(row?.assets), blockedMilli: money(row?.blocked_asset), vouchersMilli: money(row?.voucher_balance),
    currency: 'CNY', unit: 'milliYuan' };
}

// 逐页读取并按真实主键去重；首个请求失败直接报错，后续未读完则保留已有数据并明确标为不完整。
export async function collectObservatoryPages(readPage, { pageSize, maxPages = 20 } = {}) {
  const rows = [], seen = new Set();
  let total = null, pages = 0, changed = false, duplicates = false, reason = null, complete = false;
  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    let page;
    try { page = await readPage({ pageIndex, pageSize }); }
    catch (error) {
      if (!pages || isAuth(error)) throw error;
      reason = `第${pageIndex}页未读完；仅显示已读取的记录`; break;
    }
    if (!Array.isArray(page?.list)) {
      if (!pages) throw new AppError('OBSERVATORY_SCHEMA', '只读列表缺少有效分页数据');
      reason = `第${pageIndex}页格式已变化；仅显示已读取的记录`; break;
    }
    pages++;
    const nextTotal = integer(page.result_total);
    if (total !== null && nextTotal !== null && nextTotal !== total) changed = true;
    if (nextTotal !== null) total = nextTotal;
    let added = 0;
    for (const row of page.list) {
      const id = text(row?.uuid) || text(row?.id);
      if (id && seen.has(id)) { duplicates = true; continue; }
      if (id) seen.add(id);
      rows.push(row); added++;
    }
    if (total !== null && rows.length >= total) {
      complete = rows.length === total && !changed && !duplicates;
      if (!complete) reason = '分页期间记录数量或顺序发生变化，请重新刷新';
      break;
    }
    if (!page.list.length || total === null && page.list.length < pageSize) {
      complete = (total === null || rows.length === total) && !changed && !duplicates;
      if (!complete) reason = '已到空页，但读取条数与平台总数不一致';
      break;
    }
    if (!added) { reason = '后续页面重复，未确认全部记录'; break; }
    if (pageIndex === maxPages) reason = `已读取${maxPages}页，达到本次查询上限，记录尚未完整`;
  }
  return { rows, pagination: { pages, pageSize, read: rows.length, total, complete, reason } };
}

const BILL_TYPES = { charge: '消费', refund: '退款', recharge: '充值', withdraw: '提现' };
export function normalizeObservatoryBill(row) {
  const knownType = Object.hasOwn(BILL_TYPES, row?.bill_type), type = knownType ? row.bill_type : 'unknown';
  const raw = money(row?.asset), transactionMilli = raw === null ? null : Math.abs(raw), at = parseAutodlTime(row?.created_at);
  // sub_name 是子账号而非实例名；账单没有已确认的实例名称字段，不能误标成资源名称。
  return { id: text(row?.uuid) || text(row?.id), instanceId: text(row?.product_uuid), name: null,
    type, typeLabel: BILL_TYPES[type] || '未识别类型', at, date: at === null ? null : shanghaiDate(at),
    chargeFrom: parseAutodlTime(row?.details?.charge_from), transactionMilli,
    // 正数消费、负数退款；充值和提现不冒充消费，也不参与净消费图。
    amountMilli: transactionMilli === null ? null : type === 'charge' ? transactionMilli : type === 'refund' ? -transactionMilli : null };
}

export function aggregateObservatoryBills(rows, pagination, { now, days = OBSERVATORY_BILL_DAYS }) {
  const range = billingRange(now, days), normalized = rows.map(normalizeObservatoryBill);
  const unplaced = normalized.filter(row => row.date === null).length;
  const items = normalized.filter(row => row.date === null || row.date >= range.dateFrom && row.date <= range.dateTo);
  const daily = range.dates.map(date => {
    const dayItems = items.filter(row => row.date === date);
    const unknown = dayItems.some(row => row.type === 'unknown' || ['charge', 'refund'].includes(row.type) && row.amountMilli === null);
    const knownAmountMilli = dayItems.reduce((sum, row) => sum + (row.amountMilli ?? 0), 0);
    const complete = pagination.complete && !unplaced && !unknown && Number.isSafeInteger(knownAmountMilli);
    return { date, amountMilli: complete ? knownAmountMilli : null, knownAmountMilli: Number.isSafeInteger(knownAmountMilli) ? knownAmountMilli : null, count: dayItems.length, complete };
  });
  const known = daily.reduce((sum, day) => sum + (day.knownAmountMilli ?? 0), 0);
  const knownTotalMilli = daily.every(day => day.knownAmountMilli !== null) && Number.isSafeInteger(known) ? known : null;
  const complete = daily.every(day => day.complete) && knownTotalMilli !== null;
  return { checkedAt: now, days, dateFrom: range.dateFrom, dateTo: range.dateTo, queryDateTo: range.queryDateTo,
    timeZone: OBSERVATORY_TIME_ZONE, timeBasis: 'created_at', currency: 'CNY', unit: 'milliYuan',
    items, daily, totalMilli: complete ? knownTotalMilli : null, knownTotalMilli, complete, unplaced,
    pagination, error: complete ? null : '当前只显示已读到且可确认的交易；缺失日期不按零消费处理' };
}

export class Observatory {
  constructor({ adapter, clock = () => Date.now() }) { this.adapter = adapter; this.clock = clock; this.clear(); }
  clear() { this.overview = null; this.billing = null; }
  publicState() { return { source: 'autodl-web', timeZone: OBSERVATORY_TIME_ZONE, overview: this.overview, billing: this.billing }; }
  async refreshOverview({ targetId = '' } = {}) {
    try {
      const { rows, pagination } = await collectObservatoryPages(options => this.adapter.observatoryInstances(options), { pageSize: 100 });
      let wallet = null, walletError = null, monitor = null, error = null;
      try { wallet = normalizeObservatoryWallet(await this.adapter.observatoryWallet()); }
      catch (cause) { if (isAuth(cause)) throw cause; walletError = safeError(cause); }
      const target = targetId ? rows.find(row => text(row?.uuid) === targetId) : null;
      if (target) {
        try {
          monitor = await this.adapter.observatoryMonitor(targetId);
          if (text(monitor?.uuid) !== targetId) { monitor = null; error = '监控响应与所选实例不一致，未使用该响应'; }
        } catch (cause) { if (isAuth(cause)) throw cause; error = safeError(cause); }
      }
      const checkedAt = this.clock(), instances = rows.map(row => normalizeObservatoryInstance(row, text(row?.uuid) === targetId ? monitor : null));
      const hasStock = !!target && pagination.complete && text(target.machine_id) !== null
        && integer(target.gpu_idle_num) !== null && integer(target.gpu_all_num) !== null && target.gpu_idle_num <= target.gpu_all_num;
      const stock = targetId ? { instanceId: targetId, machineId: text(target?.machine_id), idleGPUs: hasStock ? target.gpu_idle_num : null,
        totalGPUs: hasStock ? target.gpu_all_num : null, machineFound: target ? text(target.machine_id) !== null : pagination.complete ? false : null,
        checkedAt, complete: hasStock, reason: hasStock ? null : !pagination.complete ? '实例列表尚未完整，不能确认原主机库存'
          : !target ? '完整实例列表未找到所选实例' : '实例列表未提供可确认的原主机空闲卡数' } : null;
      this.overview = { checkedAt, instances, summary: { total: instances.length, running: instances.filter(row => row.running === true).length,
        stopped: instances.filter(row => row.stopped === true).length, unknown: instances.filter(row => row.running === null).length },
        pagination, wallet, walletError, stock, error };
      return this.overview;
    } catch (error) {
      if (isAuth(error)) this.clear();
      else if (this.overview) this.overview = { ...this.overview, error: safeError(error) };
      throw error;
    }
  }
  async refreshBilling({ days = OBSERVATORY_BILL_DAYS } = {}) {
    // 请求期间跨过上海午夜时仍按请求开始的日期范围统计，不把未查询的新一天补成零。
    const requestedAt = this.clock(), range = billingRange(requestedAt, days);
    try {
      const { rows, pagination } = await collectObservatoryPages(options => this.adapter.observatoryBills({
        ...options, dateFrom: range.dateFrom, dateTo: range.queryDateTo }), { pageSize: 500 });
      this.billing = { ...aggregateObservatoryBills(rows, pagination, { now: requestedAt, days }), checkedAt: this.clock() };
      return this.billing;
    } catch (error) {
      if (isAuth(error)) this.clear();
      else if (this.billing) this.billing = { ...this.billing, error: safeError(error) };
      throw error;
    }
  }
}
