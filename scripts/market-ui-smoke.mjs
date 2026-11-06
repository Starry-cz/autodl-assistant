import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { createObservatoryFixtureAdapter } from '../tests/fixtures/observatory.mjs';
import { seedGpuCatalog, SYNTHETIC_GPU_CATALOG, syntheticGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';

// 全部为隔离合成数据；时钟快进只验证网页调度，不连接真实账号或修改云端主机。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-market-ui-'));
const output = path.join(root, 'output', 'playwright'); fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', synthetic: true,
  widths: [1920, 1440, 1366, 768, 390, 320], pages: [], sticky: [], screenshots: [],
  calls: [], errors: [], externalRequests: [], taskPosts: 0, forbiddenCalls: 0, maxConcurrentReads: 0 };
let app, browser, activeReads = 0, catalogGate, releaseCatalog, partial = false, longCatalog = false, inventoryRevision = 0;
const forbidden = async () => { report.forbiddenCalls++; throw Error('市场 UI 验收禁止云端操作'); };
const count = kind => report.calls.filter(call => call.kind === kind).length;
async function read(kind, payload, work) {
  report.calls.push({ kind, ...payload }); activeReads++;
  report.maxConcurrentReads = Math.max(report.maxConcurrentReads, activeReads);
  try { return await work(); } finally { activeReads--; }
}
try {
  const adapter = createObservatoryFixtureAdapter();
  adapter.gpuCatalog = regions => read('catalog', {}, async () => {
    if (catalogGate) await catalogGate;
    const catalog = await syntheticGpuCatalog(regions);
    catalog.regions[0].models[0].available -= inventoryRevision;
    // 足够长的合成目录用于验证真实滚动后的双轴固定表头；不向页面直接塞样式。
    if (longCatalog) for (let index = 1; index <= 18; index++) catalog.regions[0].models.push({ model: 'Synthetic GPU ' + index, available: index % 3, total: 8, disabled: false });
    return catalog;
  });
  adapter.marketHosts = ({ model, region }) => read('hosts', { model, region }, async () => ({
    checkedAt: Date.now(), complete: !partial, more: partial, note: partial ? '合成首页已读取，后续页尚未读取' : '', rows: [
      { hostId: 'synthetic-host-free', hostNumber: '合成可用主机', model: 'RTX 4090', region: '北京B区', available: 2, total: 4, pricePerHour: 1.98 + inventoryRevision / 100, status: '可用', disabled: false },
      { hostId: 'synthetic-host-full', hostNumber: '合成满租主机', model: 'RTX 4090', region: '北京B区', available: 0, total: 2, pricePerHour: 1.88, status: '暂无空卡', disabled: false },
      { hostId: 'synthetic-host-disabled', hostNumber: '合成不可选主机', model: 'RTX 4090', region: '北京B区', available: 1, total: 1, pricePerHour: 2.2, status: '当前不可选', disabled: true },
      { hostId: 'synthetic-host-unknown', hostNumber: '合成未知主机', model: 'RTX 4090', region: '北京B区', available: null, total: 1, pricePerHour: null, status: '指标待确认', disabled: false },
      { hostId: 'synthetic-host-northwest', hostNumber: '合成西北主机', model: 'RTX 4090', region: '西北B区', available: 0, total: 16, pricePerHour: 2.08, status: '暂无空卡', disabled: false },
      { hostId: 'synthetic-host-l20', hostNumber: '合成 L20 主机', model: 'L20', region: '北京B区', available: 1, total: 8, pricePerHour: 1.28, status: '可用', disabled: false },
    ].filter(row => (!model || row.model === model) && (!region || row.region === region)),
  }));
  Object.assign(adapter, { login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden, boot: forbidden });
  app = createApplication({ updatesOptions: offlineUpdateOptions, runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-market-ui-build',
    adapters: { autodl: adapter }, aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  seedGpuCatalog(app.store, { ...structuredClone(SYNTHETIC_GPU_CATALOG), checkedAt: Date.now() });
  app.market.record(app.store.data.gpuCatalog);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const executablePath = [process.env.AI_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(candidate => fs.existsSync(candidate));
  assert.ok(executablePath, '未找到可用的 Chromium 测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date() });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') report.taskPosts++; });
  const settled = async () => page.waitForFunction(() => !document.querySelector('#market-refresh').disabled && !document.querySelector('#market-host-refresh').disabled);
  const syncHosts = async action => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/market/hosts');
    await action(); assert.equal((await response).status(), 200); await settled();
  };
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#market-total').textContent === '96');
  assert.equal(await page.locator('#market-track-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#market-host-refresh').isDisabled(), true);
  assert.equal(report.calls.length, 0);
  const cell = page.locator('#market-heatmap [data-market-model="RTX 4090"][data-market-region="北京B区"]');
  await syncHosts(() => cell.click());
  assert.equal(await page.locator('#overview').isVisible(), true);
  assert.equal(await page.locator('#market-host-model').inputValue(), 'RTX 4090');
  assert.equal(await page.locator('#market-host-region').inputValue(), '北京B区');
  assert.equal(await cell.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 4);
  assert.equal(await page.locator('.market-host-table tbody tr').filter({ hasText: '合成未知主机' }).locator('.host-price').innerText(), '—');
  assert.match(await page.locator('.market-host-table').innerText(), /¥1\.98\/时/);
  const beforeFilter = count('hosts');
  await page.locator('#market-host-available').check();
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 1, '有空卡但不可选的主机不进入可用筛选');
  assert.equal(count('hosts'), beforeFilter, '空闲筛选只操作当前结果');
  await page.locator('#market-host-available').uncheck();
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 4);
  partial = true; await syncHosts(() => page.locator('#market-host-refresh').click());
  assert.match(await page.locator('#market-host-status').innerText(), /尚未完整.*后续页/);
  partial = false;
  await page.locator('#market-host-clear').click();
  const modelBar = page.locator('#market-models [data-market-model="RTX 4090"]');
  const regionBar = page.locator('#market-regions [data-market-region="北京B区"]');
  // 条形图各自代表独立筛选；固定主机池能检出偷偷残留另一条件的回归。
  await syncHosts(() => modelBar.click());
  assert.equal(await page.locator('#market-host-region').inputValue(), '');
  assert.equal(await modelBar.getAttribute('aria-pressed'), 'true');
  assert.equal(await regionBar.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 5);
  assert.match(await page.locator('.market-host-table').innerText(), /西北B区/);
  assert.deepEqual(report.calls.filter(call => call.kind === 'hosts').at(-1), { kind: 'hosts', model: 'RTX 4090', region: '' });
  await syncHosts(() => regionBar.click());
  assert.equal(await page.locator('#market-host-model').inputValue(), '');
  assert.equal(await modelBar.getAttribute('aria-pressed'), 'false');
  assert.equal(await regionBar.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 5);
  assert.match(await page.locator('.market-host-table').innerText(), /合成 L20 主机/);
  assert.doesNotMatch(await page.locator('.market-host-table').innerText(), /西北B区/);
  assert.deepEqual(report.calls.filter(call => call.kind === 'hosts').at(-1), { kind: 'hosts', model: '', region: '北京B区' });
  const beforeSingleFilter = count('hosts');
  await page.locator('#market-host-available').check();
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 2);
  assert.equal(count('hosts'), beforeSingleFilter);
  await page.locator('#market-host-available').uncheck();
  await syncHosts(() => page.locator('#market-host-model').selectOption('RTX 4090'));
  assert.deepEqual(report.calls.filter(call => call.kind === 'hosts').at(-1), { kind: 'hosts', model: 'RTX 4090', region: '北京B区' });
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 4);
  assert.equal(await cell.getAttribute('aria-pressed'), 'true');
  await syncHosts(() => page.locator('#market-host-region').selectOption(''));
  const beforeClearBoth = count('hosts');
  await page.locator('#market-host-model').selectOption('');
  await page.clock.fastForward(3000);
  assert.equal(count('hosts'), beforeClearBoth, '下拉均为全部时不执行全市场扫描');
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 0);
  assert.equal(await page.locator('#market-host-refresh').isDisabled(), true);
  await syncHosts(() => modelBar.click());
  const beforeClear = count('hosts');
  await page.locator('#market-host-clear').click();
  assert.equal(await page.locator('#market-host-model').inputValue(), '');
  assert.equal(await page.locator('#market-host-region').inputValue(), '');
  assert.equal(count('hosts'), beforeClear, '清空筛选不查询');
  await syncHosts(() => cell.click());
  assert.equal(await cell.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.market-host-table tbody tr').count(), 4);
  await syncHosts(() => modelBar.click());
  assert.equal(await page.locator('#market-host-region').inputValue(), '', '单项跟踪前清除热力格留下的地区');
  assert.equal(report.taskPosts, 0);
  report.filtering = { modelAcrossRegions: true, regionAcrossModels: true, dropdownCombination: true,
    heatmapCombination: true, availableFilterLocal: true, bothEmptyNoRequest: true, clearNoRequest: true, selectionAria: true };

  // 暂停发生在目录请求途中时，允许只读请求收尾，但不继续明细或下一个周期。
  await page.locator('#market-interval').selectOption('30');
  catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  await page.locator('#market-track-toggle').click();
  await page.waitForFunction(() => document.querySelector('#market-refresh').disabled);
  const hostsBeforePause = count('hosts');
  assert.equal(await page.locator('#market-track-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await cell.isDisabled(), true, '读取期间热力格应明确禁用');
  await page.locator('#market-track-toggle').click();
  assert.equal(await page.locator('#market-track-toggle').getAttribute('aria-pressed'), 'false');
  await page.clock.fastForward(65000);
  assert.equal(count('catalog'), 1); assert.equal(count('hosts'), hostsBeforePause);
  releaseCatalog(); catalogGate = null; releaseCatalog = null; await settled();
  assert.equal(count('hosts'), hostsBeforePause);
  assert.match(await page.locator('#market-tracking-status').innerText(), /已暂停/);
  await page.locator('#market-track-toggle').click(); await settled();
  await page.waitForFunction(() => /秒后/.test(document.querySelector('#market-tracking-status').textContent));
  assert.equal(count('catalog'), 2); assert.equal(count('hosts'), hostsBeforePause + 1);
  await page.clock.fastForward(31000); await settled();
  assert.equal(count('catalog'), 3); assert.equal(count('hosts'), hostsBeforePause + 2);
  assert.deepEqual(report.calls.filter(call => call.kind === 'hosts').at(-1), { kind: 'hosts', model: 'RTX 4090', region: '' }, '自动跟踪保留单项筛选范围');
  await page.locator('#market-track-toggle').click();
  const pausedCalls = report.calls.length;
  await page.clock.fastForward(65000);
  assert.equal(report.calls.length, pausedCalls);
  assert.equal(report.maxConcurrentReads, 1);
  report.tracking = { pauseStopsFollowingReads: true, countdown: true, singleCondition: true, intervalSeconds: 30, maxConcurrentReads: report.maxConcurrentReads };

  // 只有明细的明确操作按钮才填入任务；即使此前勾选过费用授权也必须清空。
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-action-choice=execute]').click(); await page.locator('#task-form [name=paidConsent]').check();
  await page.locator('[data-view=overview]').click();
  await page.locator('#market-host-list [data-market-use-model]').first().click();
  assert.equal(await page.locator('#dashboard').isVisible(), true);
  assert.equal(await page.locator('#task-form [name=gpuModel]').inputValue(), 'RTX 4090');
  assert.deepEqual(await page.locator('#task-form [name=region]:checked').evaluateAll(nodes => nodes.map(node => node.value)), ['北京B区']);
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);
  assert.equal(report.taskPosts, 0); assert.equal(app.store.tasks().length, 0);
  await page.locator('[data-view=overview]').click();
  longCatalog = true;
  await page.locator('#market-refresh').click(); await settled();
  await page.waitForFunction(() => document.querySelectorAll('.market-heatmap-table tbody tr').length === 24);
  await page.clock.fastForward(7000);
  // 库存和价格实际变化后重绘，热力表与主机表仍停留在原横向/纵向位置。
  await page.setViewportSize({ width: 390, height: 844 });
  const scrollState = () => page.evaluate(() => ['market-heatmap', 'market-host-list'].map(id => {
    const node = document.getElementById(id); return { id, top: node.scrollTop, left: node.scrollLeft };
  }));
  await page.locator('#market-heatmap').evaluate(node => { node.scrollTop = 140; node.scrollLeft = 160; });
  await page.locator('#market-host-list').evaluate(node => { node.scrollLeft = 160; });
  const beforeRefresh = await scrollState(); inventoryRevision = 1;
  await page.locator('#market-refresh').click(); await settled();
  assert.deepEqual(await scrollState(), beforeRefresh, '刷新数据不应重置正在查看的地区/型号表格位置');
  assert.equal(await page.locator('#market-heatmap [data-market-model="RTX 4090"][data-market-region="北京B区"]').innerText(), '1 / 8');
  assert.match(await page.locator('.market-host-table').innerText(), /¥1\.99\/时/);
  report.scrollPreservation = { before: beforeRefresh, after: await scrollState(), passed: true };
  await page.clock.fastForward(7000);
  await page.locator('#toast').waitFor({ state: 'hidden' });

  for (const width of report.widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1080 });
    await page.locator('[data-view=overview]').click();
    await page.mouse.move(width - 1, 300);
    await page.locator('#market-heatmap').evaluate(node => { node.scrollTop = 140; node.scrollLeft = 160; });
    const geometry = await page.locator('#market-heatmap').evaluate(node => {
      const box = node.getBoundingClientRect(), head = node.querySelector('thead th').getBoundingClientRect(), row = node.querySelector('tbody th').getBoundingClientRect();
      return { scrollLeft: node.scrollLeft, scrollTop: node.scrollTop, headerTopDifference: head.top - box.top,
        rowLeftDifference: row.left - box.left, headerPosition: getComputedStyle(node.querySelector('thead th')).position,
        rowPosition: getComputedStyle(node.querySelector('tbody th')).position };
    });
    assert.ok(geometry.scrollTop > 0); assert.equal(geometry.headerPosition, 'sticky'); assert.equal(geometry.rowPosition, 'sticky');
    assert.ok(Math.abs(geometry.headerTopDifference) <= 2, JSON.stringify(geometry));
    if (geometry.scrollLeft > 0) assert.ok(Math.abs(geometry.rowLeftDifference) <= 2, JSON.stringify(geometry));
    if (width <= 390) assert.ok(geometry.scrollLeft > 0, '手机热力表应能横向浏览');
    report.sticky.push({ width, ...geometry, passed: true });
    const pageWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(pageWidth.document <= pageWidth.viewport + 1, JSON.stringify(pageWidth));
    report.pages.push({ width, ...pageWidth, passed: true });
    await page.locator('#market-heatmap').evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
    const imagePath = path.join(output, 'market-details-' + width + '.png');
    await page.screenshot({ path: imagePath, fullPage: true, animations: 'disabled' });
    report.screenshots.push(imagePath);
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  assert.equal(report.taskPosts, 0); assert.equal(report.forbiddenCalls, 0); assert.equal(report.maxConcurrentReads, 1);
  report.status = 'passed';
  console.log('市场 UI 验收通过：型号/地区独立筛选、热力与下拉组合、单项自动跟踪和暂停、双空不查询、空卡本地过滤、未知价格与不完整提示、明确填表不提交、双轴固定表头、六宽度无溢出。全部为隔离合成数据。');
} catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
finally {
  releaseCatalog?.(); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'market-ui-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await app?.close();
  const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('autodl-market-ui-')); fs.rmSync(target, { recursive: true, force: true });
}
