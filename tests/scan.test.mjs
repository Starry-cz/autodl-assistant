import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { AppError } from '../src/errors.mjs';
import { testConfig } from './fixtures/config.mjs';
import { marketSample } from '../src/task-monitor.mjs';
// 内存中的合成分页资源列表：只验证扫描编排，不启动浏览器、不访问 AutoDL。
const row = (id, { cuda = '12.8', free = 2, disk = 500 } = {}) => ({ id, cells: ['', id + '机', 'RTX 4090', free + ' / 8',
  'CPU：合成', '数据盘：50GB\n可扩容：' + disk + 'GB', '驱动：570.1 CUDA：' + cuda, '￥2.18 /时'] });
const oldCuda = id => row(id, { cuda: '12.4' });
function listAdapter(regions, { stuck = false } = {}) {
  const adapter = new AutoDLBrowserAdapter('unused-isolated-scan-profile');
  const view = { region: Object.keys(regions)[0], index: Object.fromEntries(Object.keys(regions).map(r => [r, 0])), nextClicks: 0, reads: 0, firstClicks: 0, gotoCalls: 0, catalogCalls: 0, radioCalls: 0 };
  const pages = () => regions[view.region];
  adapter.settle = async () => {}; adapter.checkPage = async () => {}; adapter.goto = async () => { view.gotoCalls++; };
  // 默认汇总未知，使原分页/筛选测试始终覆盖 DOM 路径；专项测试再提供明确库存。
  adapter.gpuCatalog = async () => { view.catalogCalls++; return { checkedAt: Date.now(), regions: [] }; };
  adapter.selectModel = async () => {};
  adapter.radio = async name => { view.radioCalls++; if (regions[name]) view.region = name; };
  adapter.page = { locator(selector) {
    if (selector === 'table tbody tr') return { evaluateAll: async () => { view.reads++; return pages()[view.index[view.region]]; } };
    if (selector === '.el-pagination .btn-next:visible') return { count: async () => pages().length > 1 ? 1 : 0,
      isEnabled: async () => view.index[view.region] < pages().length - 1,
      click: async () => { view.nextClicks++; if (!stuck) view.index[view.region]++; } };
    if (selector === '.el-table__body-wrapper') return { evaluateAll: async () => false };
    if (selector === '.el-pagination .number') return { filter: () => ({ count: async () => 1, first: () => ({ click: async () => { view.firstClicks++; view.index[view.region] = 0; } }) }) };
    throw Error('unexpected synthetic locator: ' + selector);
  } };
  adapter.radioLabel = id => ({ count: async () => pages()[view.index[view.region]].some(h => h.id === id) ? 1 : 0, scrollIntoViewIfNeeded: async () => {} });
  return { adapter, view };
}
const config = (extra = {}) => testConfig({ gpuModel: 'RTX 4090', cuda: '12.8', imagePath: ['PyTorch', '2.8.0', '3.12(ubuntu22.04)', '12.8'], pricePolicy: 'official', ...extra });

// 汇总与主机列表分别合成，验证零库存分支确实不导航、不读取 DOM，而非扫描后再丢弃结果。
const catalogRegion = (region, extra = {}) => ({ region, models: [{ model: 'RTX 4090', available: 0, total: 8, ...extra }] });
function catalogResult(adapter, view, regions) {
  adapter.gpuCatalog = async (requested, options) => {
    view.catalogCalls++; view.catalogRegions = [...requested]; view.catalogOptions = options;
    return { checkedAt: Date.now(), regions };
  };
}
test('新租预筛：全部目标地区型号汇总明确零空闲时，主机 DOM 导航和读取均为零', async () => {
  for (const scope of ['full', 'first-page']) {
    const { adapter, view } = listAdapter({ 北京B区: [[row('a1')]], 西北B区: [[row('b1')]] });
    const regions = ['北京B区', '西北B区'];
    const catalogRows = regions.map(region => catalogRegion(region));
    catalogRows[0].models.push({ model: 'RTX 4090D', available: 99, total: 1000 });
    catalogRows.push(catalogRegion('佛山区', { available: 99, total: 1000 }));
    catalogResult(adapter, view, catalogRows);
    adapter.prepared = { old: true }; adapter.probed = { old: true }; adapter.lastSource = { old: true };
    const probe = await adapter.probe({ config: config({ regions }) }, { scope });
    assert.equal(view.catalogCalls, 1); assert.deepEqual(view.catalogRegions, regions);
    assert.deepEqual(view.catalogOptions, { strict: true });
    assert.equal(view.gotoCalls, 0); assert.equal(view.radioCalls, 0); assert.equal(view.reads, 0); assert.equal(view.nextClicks, 0);
    assert.deepEqual(probe.hosts, []); assert.equal(probe.source, null); assert.equal(probe.complete, true); assert.equal(probe.scope, scope);
    assert.equal(probe.catalogOnly, true); assert.equal(probe.catalogTotal, 16);
    const sample = marketSample(config({ regions }), probe, { at: 100, scope });
    assert.equal(sample.available, 0); assert.equal(sample.total, 16); assert.equal(sample.hostCount, null);
    assert.match(sample.note, /型号汇总.*未读取主机列表/);
    assert.match(probe.summary, /型号汇总确认无空闲，本轮不进入主机列表/);
    assert.equal(probe.timing.openMs, 0); assert.equal(probe.timing.filterMs, 0); assert.equal(probe.timing.scanMs, 0);
    assert.ok(Number.isFinite(probe.timing.catalogMs) && probe.timing.catalogMs >= 0);
    assert.ok(probe.timing.totalMs >= probe.timing.catalogMs);
    assert.equal(adapter.prepared, null); assert.equal(adapter.probed, null); assert.equal(adapter.lastSource, null);
  }
});

test('新租预筛：缺地区、缺精确型号、未知或无效数字均继续原 DOM 精确扫描', async () => {
  const cases = [
    { name: '缺少目标地区', regions: [catalogRegion('北京B区')] },
    { name: '相近型号不能替代目标型号', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { model: 'RTX 4090D' })] },
    { name: '空闲未知', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { available: null })] },
    { name: '总量未知', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { total: null })] },
    { name: '字符串不是已确认数字', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { available: '0' })] },
    { name: '总量为负', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { total: -1 })] },
    { name: '总量非整数', regions: [catalogRegion('北京B区'), catalogRegion('西北B区', { total: 1.5 })] },
    { name: '同型号记录不唯一', regions: [catalogRegion('北京B区'), { region: '西北B区', models: [...catalogRegion('西北B区').models, ...catalogRegion('西北B区').models] }] },
    { name: '地区不可读', regions: [catalogRegion('北京B区'), { ...catalogRegion('西北B区'), disabled: true }] },
  ];
  for (const entry of cases) {
    const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('a1')]], 西北B区: [[row('b1')]] });
    catalogResult(adapter, view, entry.regions);
    const probe = await adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) });
    assert.equal(view.catalogCalls, 1, entry.name); assert.equal(view.gotoCalls, 1, entry.name); assert.ok(view.reads > 0, entry.name);
    assert.deepEqual(probe.hosts.map(host => host.id), ['a1', 'b1'], entry.name);
    assert.match(probe.summary, /找到合格候选/, entry.name); assert.equal(probe.complete, false, entry.name);
  }
});

test('新租预筛：仍有空闲即继续扫描，不能将少于申请卡数当成零库存', async () => {
  for (const available of [1, 2]) {
    const { adapter, view } = listAdapter({ 北京B区: [[row('a1', { free: 2 })]] });
    catalogResult(adapter, view, [catalogRegion('北京B区', { available })]);
    const probe = await adapter.probe({ config: config({ gpuCount: 2 }) });
    assert.equal(view.gotoCalls, 1); assert.ok(view.reads > 0); assert.equal(probe.hosts[0].id, 'a1');
    assert.match(probe.summary, /找到合格候选/); assert.equal(probe.complete, false);
  }
});

test('新租预筛：API 请求错误原样上抛供引擎退避，不再导航 DOM', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[row('a1')]] });
  const error = new AppError('CATALOG_NETWORK', '合成型号汇总请求失败', { retryable: true });
  adapter.gpuCatalog = async (_regions, options) => { view.catalogCalls++; assert.deepEqual(options, { strict: true }); throw error; };
  await assert.rejects(adapter.probe({ config: config() }), caught => caught === error);
  assert.equal(view.catalogCalls, 1); assert.equal(view.gotoCalls, 0); assert.equal(view.radioCalls, 0); assert.equal(view.reads, 0);
});

test('克隆不使用型号汇总预筛，仍打开源实例克隆页并扫描精确主机', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[row('a1')]] });
  const source = { id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1 };
  let cloneCalls = 0;
  adapter.openClone = async () => { cloneCalls++; return source; };
  adapter.gpuCatalog = async () => { throw Error('克隆不应读取型号汇总'); };
  const probe = await adapter.probe({ config: config({ mode: 'clone' }) });
  assert.equal(cloneCalls, 1); assert.equal(view.gotoCalls, 0); assert.ok(view.reads > 0);
  assert.equal(probe.source, source); assert.equal(probe.hosts[0].id, 'a1'); assert.equal(probe.timing.catalogMs, 0);
});

test('完整翻页：第一页有卡但CUDA不符，继续翻到后页找到合格主机', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1'), oldCuda('h2')], [row('h3')]] });
  const scan = await adapter.scanHosts('北京B区', { config: config() });
  assert.equal(scan.found, true); assert.equal(scan.pages, 2); assert.equal(view.nextClicks, 1);
  assert.deepEqual(scan.hosts.map(h => h.id), ['h1', 'h2', 'h3']);
});
test('首页模式只读第一页，不翻页，也不声称已遍历', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1'), oldCuda('h2')], [row('h3')]] });
  const scan = await adapter.scanHosts('北京B区', { config: config(), firstPageOnly: true });
  assert.equal(scan.found, undefined); assert.equal(scan.exhausted, false); assert.equal(view.nextClicks, 0);
  assert.deepEqual(scan.hosts.map(h => h.id), ['h1', 'h2']);
  const probe = await adapter.probe({ config: config({ scanScope: 'first-page', fullScanSeconds: 60 }) }, { scope: 'first-page' });
  assert.equal(probe.complete, false); assert.equal(probe.scope, 'first-page');
  assert.match(probe.summary, /首页快速检查/); assert.match(probe.summary, /仅读第 1 页/); assert.match(probe.summary, /约每 60 秒完整翻页/);
  assert.doesNotMatch(probe.summary, /已到末页|均已读到末页/);
});
test('只有一页时首页模式也确认读到末页，可计作完整检查', async () => {
  const { adapter } = listAdapter({ 北京B区: [[oldCuda('h1')]] });
  const probe = await adapter.probe({ config: config({ scanScope: 'first-page', fullScanSeconds: 60 }) }, { scope: 'first-page' });
  assert.equal(probe.complete, true); assert.match(probe.summary, /均已读到末页/);
});
test('首页模式第一页即有合格主机时立即命中', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1'), row('h2')], [row('h3')]] });
  const probe = await adapter.probe({ config: config() }, { scope: 'first-page' });
  assert.ok(probe.hosts.some(h => h.id === 'h2')); assert.equal(view.nextClicks, 0); assert.match(probe.summary, /找到合格候选/);
  assert.equal(probe.complete, false);
});
test('多地区：首页模式不翻第一个地区的后页，继续检查下一个地区', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('a1')], [row('a2')]], 西北B区: [[row('b1')]] });
  const probe = await adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }, { scope: 'first-page' });
  assert.equal(view.nextClicks, 0); assert.deepEqual(probe.hosts.map(h => h.id), ['a1', 'b1']);
  assert.match(probe.summary, /北京B区（仅读第 1 页）、西北B区（读到第 1 页命中）/);
  const full = listAdapter({ 北京B区: [[oldCuda('a1')], [row('a2')]], 西北B区: [[row('b1')]] });
  const fullProbe = await full.adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }, { scope: 'full' });
  assert.deepEqual(fullProbe.hosts.map(h => h.id), ['a1', 'a2']); assert.match(fullProbe.summary, /完整翻页检查/);
});
test('多地区都读到末页且没有合格主机时，才说明已完整检查', async () => {
  const { adapter } = listAdapter({ 北京B区: [[oldCuda('a1')], [oldCuda('a2')]], 西北B区: [[oldCuda('b1')]] });
  const probe = await adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }, { scope: 'full' });
  assert.equal(probe.complete, true); assert.match(probe.summary, /北京B区（2 页，已到末页）/); assert.match(probe.summary, /均已读到末页/);
});
// 合成“型号筛选”：absent 表示当前地区没有此型号，与真实 selectModel 抛出的错误一致。
const missingIn = (adapter, view, regions, extra = {}) => { adapter.selectModel = async model => {
  if (regions.includes(view.region)) throw new AppError('MODEL_MISSING', '合成：当前地区没有“' + model + '”', { absent: true, ...extra }); }; };
test('多地区：某地区没有此型号时跳过该地区，继续检查其他地区并命中', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[row('a1')]], 西北B区: [[row('b1')]] });
  missingIn(adapter, view, ['北京B区']);
  const probe = await adapter.probe({ id: 'synthetic-task', config: config({ regions: ['北京B区', '西北B区'] }) }, { scope: 'full' });
  assert.deepEqual(probe.hosts.map(h => h.id), ['b1']);
  assert.match(probe.summary, /北京B区（没有此型号，已跳过）、西北B区（读到第 1 页命中）/);
  assert.equal(adapter.probed.region, '西北B区');
  const none = listAdapter({ 北京B区: [[oldCuda('a1')]], 西北B区: [[oldCuda('b1')]] });
  missingIn(none.adapter, none.view, ['西北B区']);
  const complete = await none.adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }, { scope: 'full' });
  assert.equal(complete.complete, true); assert.match(complete.summary, /西北B区（没有此型号，已跳过）/);
});
test('所选地区都没有此型号、单地区没有此型号、或同名多项时报错停止，不改用其他型号', async () => {
  const both = listAdapter({ 北京B区: [[row('a1')]], 西北B区: [[row('b1')]] });
  missingIn(both.adapter, both.view, ['北京B区', '西北B区']);
  await assert.rejects(both.adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }), error => error.code === 'MODEL_MISSING' && /都没有“RTX 4090”/.test(error.message) && !error.retryable);
  const single = listAdapter({ 北京B区: [[row('a1')]] });
  missingIn(single.adapter, single.view, ['北京B区']);
  await assert.rejects(single.adapter.probe({ config: config() }), error => error.code === 'MODEL_MISSING' && error.absent);
  const ambiguous = listAdapter({ 北京B区: [[row('a1')]], 西北B区: [[row('b1')]] });
  ambiguous.adapter.selectModel = async () => { throw new AppError('MODEL_MISSING', '合成：同名多项'); };
  await assert.rejects(ambiguous.adapter.probe({ config: config({ regions: ['北京B区', '西北B区'] }) }), /同名多项/);
});
test('翻页按钮可点但内容不变：有限次等待后标记停滞，不空转到上限', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1')], [row('h2')]] }, { stuck: true });
  const scan = await adapter.scanHosts('北京B区', { config: config() });
  assert.equal(scan.stalled, true); assert.equal(scan.exhausted, false); assert.equal(view.nextClicks, 1); assert.ok(view.reads <= 5, 'reads ' + view.reads);
  const probe = await listAdapter({ 北京B区: [[oldCuda('h1')], [row('h2')]] }, { stuck: true }).adapter.probe({ config: config() }, { scope: 'full' });
  assert.equal(probe.complete, false); assert.match(probe.summary, /翻页停滞/); assert.doesNotMatch(probe.summary, /均已读到末页/);
});
test('提交前按候选ID找回不受首页模式影响，候选移到后页仍能找到', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1')], [oldCuda('h2')], [row('target')]] });
  const scan = await adapter.scanHosts('北京B区', { config: config(), untilId: 'target', firstPageOnly: true });
  assert.equal(scan.found, true); assert.equal(view.nextClicks, 2);
});
test('定位候选：先查当前页；不在当前页时回第一页逐页查找', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[oldCuda('h1')], [row('target')]] });
  view.index['北京B区'] = 1;
  await adapter.locateHost('target'); assert.equal(view.firstClicks, 0); assert.equal(view.nextClicks, 0);
  const moved = listAdapter({ 北京B区: [[oldCuda('h1')], [oldCuda('h2')], [row('target')]] });
  moved.view.index['北京B区'] = 1;
  await moved.adapter.locateHost('target'); assert.equal(moved.view.firstClicks, 1); assert.equal(moved.view.nextClicks, 2);
});
test('定位候选：候选消失或翻页停滞时有限次后报资源变化，可下轮重试', async () => {
  const gone = listAdapter({ 北京B区: [[oldCuda('h1')], [oldCuda('h2')]] });
  await assert.rejects(() => gone.adapter.locateHost('target'), error => error.code === 'RESOURCE_GONE' && error.retryable === true && error.race === true);
  const stuck = listAdapter({ 北京B区: [[oldCuda('h1')], [row('target')]] }, { stuck: true });
  await assert.rejects(() => stuck.adapter.locateHost('target'), error => error.code === 'RESOURCE_SCAN' && error.retryable === true && !error.race);
  assert.ok(stuck.view.nextClicks <= 2, 'clicks ' + stuck.view.nextClicks);
});
test('滚动加载列表：滚动后读取新行；容器滚不动时按到底处理，不空转到上限', async () => {
  const make = (segments, { movable = true } = {}) => {
    const { adapter, view } = listAdapter({ 北京B区: [[]] });
    // 合成滚动容器：每次滚动 240px 显示下一段行。
    const el = { clientHeight: 300, scrollHeight: 300 + 240 * (segments.length - 1), top: 0,
      get scrollTop() { return this.top; }, set scrollTop(v) { if (movable) this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); } };
    adapter.page = { locator(selector) {
      if (selector === 'table tbody tr') return { evaluateAll: async () => { view.reads++; return segments[Math.round(el.top / 240)]; } };
      if (selector === '.el-table__body-wrapper') return { evaluateAll: async fn => fn([el]) };
      if (selector === '.el-pagination .btn-next:visible') return { count: async () => 0 };
      throw Error('unexpected synthetic locator: ' + selector);
    } };
    return { adapter, view };
  };
  const scrolling = make([[oldCuda('a1')], [oldCuda('a2')], [row('a3')]]);
  const scan = await scrolling.adapter.scanHosts('北京B区', { config: config() });
  assert.equal(scan.found, true); assert.equal(scan.pages, 3); assert.deepEqual(scan.hosts.map(h => h.id), ['a1', 'a2', 'a3']);
  const first = await make([[oldCuda('a1')], [row('a2')]]).adapter.scanHosts('北京B区', { config: config(), firstPageOnly: true });
  assert.equal(first.exhausted, false); assert.deepEqual(first.hosts.map(h => h.id), ['a1']);
  const locked = make([[oldCuda('a1')], [oldCuda('a2')]], { movable: false });
  const end = await locked.adapter.scanHosts('北京B区', { config: config() });
  assert.equal(end.exhausted, true); assert.ok(locked.view.reads <= 3, 'reads ' + locked.view.reads);
});
test('最近被平台拒绝的主机不算命中：第一页只有它合格时继续翻页，找到下一台合格主机', async () => {
  const { adapter, view } = listAdapter({ 北京B区: [[row('a1')], [row('a2')]] });
  const skip = host => host.id === 'a1';
  const scan = await adapter.scanHosts('北京B区', { config: config(), skip });
  assert.equal(scan.found, true); assert.equal(scan.pages, 2); assert.equal(view.nextClicks, 1);
  const probe = await listAdapter({ 北京B区: [[row('a1')], [row('a2')]] }).adapter.probe({ id: 'synthetic-task', config: config() }, { scope: 'full', skip });
  assert.deepEqual(probe.hosts.map(h => h.id), ['a1', 'a2']); assert.match(probe.summary, /读到第 2 页命中/);
  // 只有被暂停选择的主机合格：读到末页，不算命中。
  const only = await listAdapter({ 北京B区: [[row('a1')], [oldCuda('a2')]] }).adapter.scanHosts('北京B区', { config: config(), skip });
  assert.equal(only.found, undefined); assert.equal(only.exhausted, true);
});

