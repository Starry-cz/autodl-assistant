import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { Observatory, normalizeObservatoryInstance, normalizeObservatoryWallet, normalizeObservatoryBill,
  parseAutodlTime, shanghaiDate, billingRange, collectObservatoryPages, aggregateObservatoryBills } from '../src/observatory.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID, OBSERVATORY_RUNNING_ID } from './fixtures/observatory.mjs';

// 金额、实例和时间都是合成数据；不连接 AutoDL，也不启动任务引擎。
const NOW = Date.parse('2026-11-05T10:00:00Z'), clock = () => NOW;
const complete = { pages: 1, pageSize: 500, read: 1, total: 1, complete: true, reason: null };
const bill = (overrides = {}) => ({ uuid: 'synthetic-bill', bill_type: 'charge', asset: 1234, created_at: '2026-11-05 09:00:00', ...overrides });

test('监控容量按 GiB 换算，CPU百分比不放大也不裁到100', () => {
  const instance = normalizeObservatoryInstance({ uuid: 'a-b', status: 'running', start_mode: 'gpu' }, {
    uuid: 'a-b', cpu_number: 16, UsageInfo: { mem_limit: 8 * 2 ** 30, mem_usage: 2 * 2 ** 30, mem_usage_percent: 25,
      cpu_usage_percent: 250.5, root_fs_total_size: 30 * 2 ** 30, root_fs_used_size: 6 * 2 ** 30 } });
  assert.equal(instance.cpuCores, 16); assert.equal(instance.memoryGiB, 8); assert.equal(instance.usage.memoryUsedGiB, 2);
  assert.equal(instance.usage.cpuPercent, 250.5); assert.equal(instance.usage.memoryPercent, 25);
  assert.equal(instance.usage.systemDiskPercent, 20); assert.equal(instance.dataDiskGiB, null);
  assert.equal(instance.usage.dataDiskUsedGiB, null); assert.equal(instance.usage.gpuPercent, null);
});

test('缺失数据不填0、不补50GiB，真实0用量仍保留', () => {
  const missing = normalizeObservatoryInstance({ uuid: 'a-b', status: 'running' });
  assert.equal(missing.cardless, null); assert.equal(missing.cpuCores, null); assert.equal(missing.memoryGiB, null);
  assert.equal(missing.dataDiskGiB, null); assert.equal(missing.priceHourlyMilli, null);
  const empty = normalizeObservatoryInstance({ uuid: 'a-b', usage_info: { mem_limit: 10, mem_usage: 0, data_disk_used_size: 0 } });
  assert.equal(empty.usage.memoryPercent, 0); assert.equal(empty.usage.dataDiskUsedGiB, 0); assert.equal(empty.usage.dataDiskPercent, null);
});

test('不采纳其他实例的监控数据，系统盘与数据盘分别归一化', () => {
  const value = normalizeObservatoryInstance({ uuid: 'a-b', root_fs_total_size: 30 * 2 ** 30, root_fs_used_size: 2 ** 30,
    usage_info: { data_disk_total_size: 100 * 2 ** 30, data_disk_used_size: 10 * 2 ** 30 } }, { uuid: 'wrong-id', cpu_number: 999, UsageInfo: { mem_limit: 999 } });
  assert.equal(value.cpuCores, null); assert.equal(value.memoryGiB, null); assert.equal(value.systemDiskGiB, 30);
  assert.equal(value.dataDiskGiB, 100); assert.equal(value.usage.dataDiskPercent, 10);
});

test('识别关机错误态、过渡态和无卡运行，未知状态不猜测', () => {
  assert.equal(normalizeObservatoryInstance({ status: 'shutdown_by_running_error' }).stopped, true);
  assert.equal(normalizeObservatoryInstance({ status: 'starting', start_mode: 'non_gpu' }).cardless, true);
  assert.equal(normalizeObservatoryInstance({ status: 'running', start_mode: 'non_gpu' }).statusLabel, '无卡运行中');
  assert.equal(normalizeObservatoryInstance({ status: 'vendor_new_state' }).running, null);
});

test('网页钱包保留整数千分元，负现金余额不改成可用余额', () => {
  assert.deepEqual(normalizeObservatoryWallet({ assets: -500, blocked_asset: 1000, voucher_balance: 300 }),
    { balanceMilli: -500, blockedMilli: 1000, vouchersMilli: 300, currency: 'CNY', unit: 'milliYuan' });
  assert.equal(normalizeObservatoryWallet({ assets: '1000', voucher_balance: null }).balanceMilli, null);
  assert.equal(normalizeObservatoryWallet({ assets: 0 }).balanceMilli, 0);
});

test('无时区交易时间按上海解析，带时区ISO与秒/毫秒时间戳保留含义', () => {
  assert.equal(parseAutodlTime('2026-11-05 00:30:00'), Date.parse('2026-11-04T16:30:00Z'));
  assert.equal(shanghaiDate(parseAutodlTime('2026-11-04T16:30:00Z')), '2026-11-05');
  assert.equal(parseAutodlTime(NOW / 1000), NOW); assert.equal(parseAutodlTime(NOW), NOW);
  assert.equal(parseAutodlTime(null), null); assert.equal(parseAutodlTime(''), null);
});

test('固定35个上海自然日，包含31天月份且查询边界到明日', () => {
  const range = billingRange(Date.parse('2026-10-31T16:01:00Z'));
  assert.equal(range.dateTo, '2026-11-01'); assert.equal(range.queryDateTo, '2026-11-02');
  assert.equal(range.dates.length, 35); assert.ok(range.dates.includes('2026-10-01'));
  assert.throws(() => billingRange(NOW, 14), { code: 'OBSERVATORY_RANGE' });
});

test('账单正消费负退款，充值提现与未知类型不算消费，订单号不当实例ID', () => {
  assert.equal(normalizeObservatoryBill(bill()).amountMilli, 1234);
  assert.equal(normalizeObservatoryBill(bill({ bill_type: 'refund', asset: -300 })).amountMilli, -300);
  for (const type of ['recharge', 'withdraw', 'future_type']) assert.equal(normalizeObservatoryBill(bill({ bill_type: type })).amountMilli, null);
  assert.equal(normalizeObservatoryBill(bill({ order_uuid: 'not-instance' })).instanceId, null);
  assert.equal(normalizeObservatoryBill(bill({ product_uuid: 'right-instance' })).instanceId, 'right-instance');
  assert.equal(normalizeObservatoryBill(bill({ sub_name: 'synthetic-sub-account' })).name, null);
  assert.equal(normalizeObservatoryBill(bill({ asset: 1.23 })).amountMilli, null);
});

test('按交易日聚合保留净退款日，起租日不改变入账日', () => {
  const result = aggregateObservatoryBills([bill({ details: { charge_from: '2026-10-01 00:00:00' } }),
    bill({ uuid: 'refund', bill_type: 'refund', asset: 2000 }), bill({ uuid: 'recharge', bill_type: 'recharge', asset: 90000 })], complete, { now: NOW });
  assert.equal(result.totalMilli, -766); assert.equal(result.daily.at(-1).amountMilli, -766);
  assert.equal(result.daily[0].amountMilli, 0); assert.equal(result.daily.at(-1).count, 3);
  assert.equal(result.timeBasis, 'created_at'); assert.equal(result.items[0].date, '2026-11-05');
});

test('未读完分页时缺失日为null，仅提供已读到的净消费', () => {
  const result = aggregateObservatoryBills([bill()], { ...complete, complete: false, total: 100 }, { now: NOW });
  assert.equal(result.totalMilli, null); assert.equal(result.knownTotalMilli, 1234);
  assert.ok(result.daily.every(day => day.amountMilli === null)); assert.equal(result.daily.at(-1).knownAmountMilli, 1234);
});

test('无时间或未知类型不能制造完整的消费日图，范围外记录被裁剪', () => {
  const missing = aggregateObservatoryBills([bill({ created_at: null })], complete, { now: NOW });
  assert.equal(missing.unplaced, 1); assert.equal(missing.totalMilli, null); assert.ok(missing.daily.every(day => !day.complete));
  const unknown = aggregateObservatoryBills([bill({ bill_type: 'unknown' })], complete, { now: NOW });
  assert.equal(unknown.daily.at(-1).amountMilli, null); assert.equal(unknown.totalMilli, null);
  const outside = aggregateObservatoryBills([bill({ created_at: '2026-11-06 00:00:00' }), bill({ created_at: '2026-01-01 00:00:00' })], complete, { now: NOW });
  assert.equal(outside.items.length, 0); assert.equal(outside.totalMilli, 0);
});

test('实例/账单按总数完整翻页，不把第一页当全部', async () => {
  const calls = [];
  const result = await collectObservatoryPages(async ({ pageIndex, pageSize }) => {
    calls.push([pageIndex, pageSize]); return { list: pageIndex === 1 ? [{ uuid: 'a' }, { uuid: 'b' }] : [{ uuid: 'c' }], result_total: 3 };
  }, { pageSize: 2 });
  assert.deepEqual(calls, [[1, 2], [2, 2]]); assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.read, 3); assert.equal(result.pagination.pages, 2);
});

test('达到分页上限、页面重复或总数变化均明确不完整', async () => {
  const capped = await collectObservatoryPages(async ({ pageIndex }) => ({ list: [{ uuid: String(pageIndex) }], result_total: 9 }), { pageSize: 1, maxPages: 2 });
  assert.equal(capped.pagination.complete, false); assert.match(capped.pagination.reason, /上限/);
  const repeated = await collectObservatoryPages(async () => ({ list: [{ uuid: 'same' }], result_total: 3 }), { pageSize: 1 });
  assert.equal(repeated.pagination.read, 1); assert.match(repeated.pagination.reason, /重复/);
  const changed = await collectObservatoryPages(async ({ pageIndex }) => ({ list: [{ uuid: String(pageIndex) }], result_total: pageIndex === 1 ? 3 : 2 }), { pageSize: 1 });
  assert.equal(changed.pagination.complete, false); assert.match(changed.pagination.reason, /变化/);
});

test('后续页失败保留部分读取，鉴权失败不可继续返回缓存', async () => {
  const partial = await collectObservatoryPages(async ({ pageIndex }) => {
    if (pageIndex === 2) throw Error('synthetic failure'); return { list: [{ uuid: 'a' }], result_total: 2 };
  }, { pageSize: 1 });
  assert.equal(partial.pagination.complete, false); assert.equal(partial.rows.length, 1);
  await assert.rejects(collectObservatoryPages(async ({ pageIndex }) => {
    if (pageIndex === 2) throw new AppError('OBSERVATORY_AUTH', '合成登录过期'); return { list: [{ uuid: 'a' }], result_total: 2 };
  }, { pageSize: 1 }), { code: 'OBSERVATORY_AUTH' });
});

test('没有总数时继续读到短页，空页与已知总数冲突则不完整', async () => {
  const noTotal = await collectObservatoryPages(async ({ pageIndex }) => ({ list: pageIndex === 1 ? [{ uuid: 'a' }, { uuid: 'b' }] : [{ uuid: 'c' }] }), { pageSize: 2 });
  assert.equal(noTotal.pagination.complete, true); assert.equal(noTotal.pagination.total, null);
  const empty = await collectObservatoryPages(async () => ({ list: [], result_total: 3 }), { pageSize: 2 });
  assert.equal(empty.pagination.complete, false);
});

test('监控只查询所选实例，原主机明确零库存与未知库存不混淆', async () => {
  const adapter = createObservatoryFixtureAdapter({ clock }), calls = [];
  const original = adapter.observatoryMonitor;
  adapter.observatoryMonitor = id => { calls.push(id); return original(id); };
  const observatory = new Observatory({ adapter, clock });
  const result = await observatory.refreshOverview({ targetId: OBSERVATORY_INSTANCE_ID });
  assert.deepEqual(calls, [OBSERVATORY_INSTANCE_ID]); assert.equal(result.stock.idleGPUs, 0);
  assert.equal(result.stock.complete, true); assert.deepEqual(result.summary, { total: 3, running: 1, stopped: 1, unknown: 1 });
  const missing = await observatory.refreshOverview({ targetId: 'missing-instance' });
  assert.equal(missing.stock.idleGPUs, null); assert.equal(missing.stock.machineFound, false);
  const unselected = await observatory.refreshOverview(); assert.equal(unselected.stock, null);
});

test('实例分页未完整，即使选中行写了零空闲也不声称库存是零', async () => {
  const adapter = createObservatoryFixtureAdapter({ clock }), original = adapter.observatoryInstances;
  adapter.observatoryInstances = async options => ({ ...await original(options), result_total: 300 });
  const result = await new Observatory({ adapter, clock }).refreshOverview({ targetId: OBSERVATORY_INSTANCE_ID });
  assert.equal(result.pagination.complete, false); assert.equal(result.stock.idleGPUs, null); assert.equal(result.stock.complete, false);
});

test('监控身份不匹配不污染原实例，钱包失败不丢掉已读取实例', async () => {
  const adapter = createObservatoryFixtureAdapter({ clock });
  adapter.observatoryMonitor = async () => ({ uuid: 'other-instance', cpu_number: 999, UsageInfo: { cpu_usage_percent: 999 } });
  adapter.observatoryWallet = async () => { throw Error('synthetic wallet failure'); };
  const result = await new Observatory({ adapter, clock }).refreshOverview({ targetId: OBSERVATORY_RUNNING_ID });
  assert.equal(result.instances.find(row => row.id === OBSERVATORY_RUNNING_ID).usage.cpuPercent, null);
  assert.match(result.error, /不一致/); assert.equal(result.wallet, null); assert.ok(result.walletError);
});

test('账单查询明日边界并冻结请求日期，跨上海午夜不补造新一天', async () => {
  let now = Date.parse('2026-11-05T15:59:59Z'), request;
  const adapter = createObservatoryFixtureAdapter({ clock: () => now });
  adapter.observatoryBills = async options => { request = options; now += 2000; return { list: [], result_total: 0 }; };
  const value = await new Observatory({ adapter, clock: () => now }).refreshBilling();
  assert.equal(request.dateTo, '2026-11-06'); assert.equal(value.dateTo, '2026-11-05');
  assert.equal(value.checkedAt, now); assert.equal(value.daily.length, 35);
});

test('清空与鉴权失败同时清除监控、账单缓存，防止跨账号显示', async () => {
  const adapter = createObservatoryFixtureAdapter({ clock }), observatory = new Observatory({ adapter, clock });
  await observatory.refreshOverview(); await observatory.refreshBilling();
  observatory.clear(); assert.equal(observatory.publicState().overview, null); assert.equal(observatory.publicState().billing, null);
  await observatory.refreshOverview(); await observatory.refreshBilling();
  adapter.observatoryInstances = async () => { throw new AppError('OBSERVATORY_AUTH', '合成会话失效'); };
  await assert.rejects(observatory.refreshOverview(), { code: 'OBSERVATORY_AUTH' });
  assert.equal(observatory.publicState().overview, null); assert.equal(observatory.publicState().billing, null);
});
