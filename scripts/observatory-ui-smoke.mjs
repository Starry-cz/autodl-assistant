import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID } from '../tests/fixtures/observatory.mjs';
import { testConfig } from '../tests/fixtures/config.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';

// 所有页面数据来自共享合成 fixture；外网请求被阻止，临时引擎关闭。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-observatory-ui-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const errors = [], blocked = [], taskPosts = [];
const report = {
  startedAt: new Date().toISOString(), status: 'running',
  dataSource: 'tests/fixtures/observatory.mjs（合成数据，不代表真实账号或云端状态）',
  isolation: { temporaryRuntime: true, engineRunning: false, headless: true, externalRequestsBlocked: true },
  widths: [1920, 1440, 1366, 768, 390, 320], pageChecks: [], screenshots: [], alignment: [], mobileChartChecks: [], searchFieldChecks: [],
};
let app, browser, forbiddenCalls = 0, unknownResources = false, instanceFailure = false, partialBills = false;
const forbidden = async () => { forbiddenCalls++; throw Error('监控页面验收禁止真实账号、付费操作及外部请求'); };
const numericMoney = text => Number(text.replace(/[^\d.\-]/g, ''));
const chinaDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

try {
  const adapter = createObservatoryFixtureAdapter();
  let session = adapter.sessionStatus();
  adapter.sessionStatus = () => ({ ...session });
  const readInstances = adapter.observatoryInstances.bind(adapter);
  const readMonitor = adapter.observatoryMonitor.bind(adapter);
  const readBills = adapter.observatoryBills.bind(adapter);
  const sampleRows = (await readInstances({ pageIndex: 1, pageSize: 100 })).list;
  const source = sampleRows.find(row => row.uuid === OBSERVATORY_INSTANCE_ID);
  assert.ok(source, '共享 fixture 必须包含监控目标');
  const sourceId = source.uuid;
  let reads = 0;
  adapter.observatoryInstances = async options => {
    reads++;
    if (instanceFailure) throw Error('合成列表暂时无法读取');
    const result = await readInstances(options);
    if (!unknownResources) return result;
    // 在同一共享样例中移除可选指标，验证未知与真实零值的区别。
    return { ...result, list: result.list.map(row => row.uuid !== sourceId ? row : {
      ...row, gpu_idle_num: undefined, gpu_all_num: undefined, usage_info: {},
      root_fs_total_size: undefined, root_fs_used_size: undefined,
      mem_limit: undefined, mem_limit_in_byte: undefined, mem_usage: undefined,
      expand_data_disk_size: undefined,
    }) };
  };
  adapter.observatoryMonitor = async id => unknownResources ? { uuid: id, UsageInfo: {} } : readMonitor(id);
  adapter.observatoryBills = async options => {
    const result = await readBills(options);
    return partialBills ? { ...result, result_total: 9999 } : result;
  };
  Object.assign(adapter, { login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden,
    submit: forbidden, boot: forbidden, inspectBoot: forbidden });
  app = createApplication({ runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-observatory-ui-build', adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  seedGpuCatalog(app.store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(executablePath, '未找到可用的 Chromium 浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { blocked.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/tasks' && request.method() === 'POST') taskPosts.push(request.postDataJSON());
  });
  const view = async name => {
    await page.locator(`.nav-item[data-view="${name}"]`).click();
    await page.locator(`#${name}`).waitFor({ state: 'visible' });
    // 等待有限入场动画完成，避免把半透明过渡帧误当成最终界面。
    await page.locator(`#${name}`).evaluate(async element => {
      const animations = element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime));
      await Promise.allSettled(animations.map(animation => animation.finished));
    });
  };
  const sync = async (button, endpoint, status = 200) => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST');
    await page.locator(button).click();
    assert.equal((await response).status(), status);
    await page.waitForFunction(id => !document.querySelector(id).disabled, button);
  };
  const assertNoOverflow = async (name, width) => {
    const result = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(result.content <= result.width + 1, `${name} 在 ${width}px 横向溢出：${JSON.stringify(result)}`);
    report.pageChecks.push({ page: name, viewportWidth: width, documentWidth: result.content, passed: true });
  };
  const assertLatestDateVisible = async () => {
    await page.waitForFunction(() => {
      const chart = document.querySelector('#billing-chart');
      return chart.scrollWidth > chart.clientWidth && Math.abs(chart.scrollLeft - (chart.scrollWidth - chart.clientWidth)) <= 1;
    });
    const result = await page.locator('#billing-chart').evaluate(chart => {
      const bounds = chart.getBoundingClientRect(), latest = chart.querySelector('.bar:last-of-type').getBoundingClientRect();
      return { scrollLeft: chart.scrollLeft, maxScrollLeft: chart.scrollWidth - chart.clientWidth,
        latestVisible: latest.left >= bounds.left && latest.right <= bounds.right,
        latestDate: chart.querySelector('.bar:last-of-type').dataset.billDate };
    });
    assert.ok(result.latestVisible, '最近日期的柱子应完整出现在窄屏图表内');
    assert.equal(result.latestDate, chinaDay(new Date()));
    return result;
  };
  const assertMobileDatesReadable = async () => {
    // 使用最终渲染边界，避免 SVG 缩放使名义字号与实际可读尺寸不符。
    const labels = await page.locator('#billing-chart').evaluate(chart => {
      const viewport = chart.getBoundingClientRect();
      return [...chart.querySelectorAll('text.chart-label[text-anchor=middle]')].map(label => {
        const bounds = label.getBoundingClientRect();
        return { text: label.textContent, left: bounds.left, right: bounds.right, height: bounds.height };
      }).filter(label => label.right > viewport.left && label.left < viewport.right);
    });
    assert.ok(labels.length >= 2, '窄屏图表至少应显示两个日期刻度');
    for (let index = 0; index < labels.length; index++) {
      assert.ok(labels[index].height >= 12, `日期渲染高度不足 12px：${JSON.stringify(labels[index])}`);
      if (index) assert.ok(labels[index].left >= labels[index - 1].right, `可见日期刻度重叠：${JSON.stringify(labels)}`);
    }
    return labels;
  };
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  assert.equal(await page.locator('#overview').isVisible(), true, '默认进入监控室');
  // 余额已归入账单页，控制台只保留任务配置与队列。
  await view('billing');
  assert.equal(await page.locator('#billing-balance').innerText(), '—');
  assert.equal(await page.locator('#billing-budget-credentials').evaluate(node => node.open), false);
  await view('overview');
  assert.equal(await page.locator('#overview-gpu-count').innerText(), '—');
  assert.equal(reads, 0, '进入新页面不应擅自开始后台读取');
  await sync('#overview-refresh', '/api/observatory/overview');
  const targetResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/observatory/overview' && r.request().method() === 'POST');
  await page.locator('#overview-target-select').selectOption(sourceId);
  assert.equal((await targetResponse).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#overview-refresh').disabled);
  assert.equal(await page.locator('#overview-target-count').innerText(), '1');
  assert.equal(await page.evaluate(() => localStorage.getItem('autodl.overview.target.' + (appState.account?.identity?.ownerId || 'local'))), sourceId);
  assert.equal(await page.evaluate(() => localStorage.getItem('autodl.overview.target')), null, '不再写跨账号共用的旧选择键');
  assert.equal(app.store.tasks().length, 0);

  // 同步失败保留已有数据，并明确说明该数据不是本次成功读取的结果。
  const oldStock = await page.locator('#overview-gpu-count').innerText();
  const previousSync = app.observatory.publicState().overview.checkedAt;
  instanceFailure = true;
  await sync('#overview-refresh', '/api/observatory/overview', 500);
  await page.evaluate(() => refresh());
  await page.waitForFunction(() => /未确认|失败|上次/.test(document.querySelector('#overview-status').textContent));
  assert.match(await page.locator('#overview-status').innerText(), /未确认|失败|上次/);
  assert.equal(app.observatory.publicState().overview.checkedAt, previousSync);
  assert.equal(await page.locator('#overview-gpu-count').innerText(), oldStock);
  instanceFailure = false;
  unknownResources = true;
  await sync('#overview-refresh', '/api/observatory/overview');
  assert.equal(await page.locator('#overview-gpu-count').innerText(), '—');
  assert.deepEqual(await page.locator('#overview-resources .resource-reading strong').allTextContents(), ['—', '—', '—', '—']);
  unknownResources = false;
  await sync('#overview-refresh', '/api/observatory/overview');

  await view('fleet');
  assert.equal(await page.locator('#fleet-list .fleet-row').count(), sampleRows.length);
  await page.locator('#fleet-search').fill(sourceId);
  assert.equal(await page.locator('#fleet-list .fleet-row').count(), 1);
  await page.locator('#fleet-search').fill('绝不存在的合成实例');
  assert.equal(await page.locator('#fleet-list .fleet-row').count(), 0);
  assert.match(await page.locator('#fleet-list').innerText(), /没有符合/);
  await page.locator('#fleet-search').fill('');
  await page.locator('#fleet-status').selectOption('running');
  const runningCount = sampleRows.filter(row => row.status === 'running' && row.start_mode !== 'non_gpu').length;
  assert.equal(await page.locator('#fleet-list .fleet-row').count(), runningCount);
  await page.locator('#fleet-status').selectOption('all');
  const selectResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/observatory/overview' && r.request().method() === 'POST');
  await page.locator(`#fleet-list [data-monitor-instance="${sourceId}"]`).click();
  assert.equal((await selectResponse).status(), 200);
  await page.locator('#overview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#overview-refresh').disabled);
  assert.equal(await page.locator('#overview-target-select').inputValue(), sourceId);

  // “配置开机”只复核实例并填入原有表单，不能替用户勾选授权或创建任务。
  await view('dashboard');
  await page.locator('[data-action-choice=execute]').click();
  await page.locator('#task-form [name=paidConsent]').check();
  await view('overview');
  await page.locator(`#overview-targets [data-configure-boot="${sourceId}"]`).click();
  await page.waitForFunction(id => document.querySelector('#task-form [name=sourceId]').value === id, sourceId);
  assert.equal(await page.locator('[data-mode=boot]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);
  assert.equal(taskPosts.length, 0);
  assert.equal(app.store.tasks().length, 0);

  await view('billing');
  assert.equal(await page.locator('#billing-today').innerText(), '—');
  await sync('#billing-refresh', '/api/observatory/billing');
  assert.equal(await page.locator('#billing-chart .bar').count(), 14);
  const billing = app.observatory.publicState().billing;
  const rawBills = (await readBills({ dateFrom: billing.dateFrom, dateTo: billing.dateTo, pageIndex: 1, pageSize: 500 })).list;
  const today = chinaDay(new Date());
  const dateOf = row => chinaDay(new Date(row.created_at));
  const expectedToday = rawBills.filter(row => dateOf(row) === today).reduce((sum, row) =>
    row.bill_type === 'charge' ? sum + row.asset : row.bill_type === 'refund' ? sum - row.asset : sum, 0) / 1000;
  assert.ok(rawBills.some(row => row.bill_type === 'recharge'), '共享样例须覆盖充值非消费');
  assert.ok(rawBills.some(row => row.bill_type === 'refund'), '共享样例须覆盖退款');
  assert.equal(numericMoney(await page.locator('#billing-today').innerText()), expectedToday);
  assert.doesNotMatch(await page.locator('#billing-breakdown').innerText(), /充值/);
  await page.locator('#billing-range').selectOption('30');
  assert.equal(await page.locator('#billing-chart .bar').count(), 30);
  const bars = page.locator('#billing-chart .bar');
  await bars.first().focus();
  assert.match(await page.locator('#billing-chart-tooltip').innerText(), new RegExp(await bars.first().getAttribute('data-bill-date')));
  await bars.last().hover();
  assert.match(await page.locator('#billing-chart-tooltip').innerText(), new RegExp(await bars.last().getAttribute('data-bill-date')));
  await page.locator('#billing-range').selectOption('14');
  assert.equal(await page.locator('#billing-chart .bar').count(), 14);

  // 不完整分页不能把未获取日期显示成零消费，已知部分仍有明确的提示。
  partialBills = true;
  await sync('#billing-refresh', '/api/observatory/billing');
  assert.match(await page.locator('#billing-coverage').innerText(), /未完整|不完整/);
  assert.equal(await page.locator('#billing-period-total').innerText(), '—');
  assert.ok(await page.locator('#billing-chart .bar.missing').count() > 0);
  partialBills = false;
  await sync('#billing-refresh', '/api/observatory/billing');
  assert.equal(await page.locator('#billing-chart .bar.refund').count(), 1, '净退款日必须保留负数柱');
  await page.locator('#toast').waitFor({ state: 'hidden' });

  // 六种宽度逐一检查新页面，导航允许自身滚动，整页不能横向溢出。
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1080 });
    for (const name of ['overview', 'fleet', 'billing']) {
      await view(name);
      await assertNoOverflow(name, width);
      if (name === 'fleet') {
        const search = await page.locator('.search-field').evaluate(field => {
          const input = field.querySelector('input'), icon = field.querySelector('svg');
          return { paddingLeft: parseFloat(getComputedStyle(input).paddingLeft),
            iconRightFromInput: icon.getBoundingClientRect().right - input.getBoundingClientRect().left };
        });
        assert.ok(search.paddingLeft > search.iconRightFromInput, '搜索文字左内边距需超过图标右缘');
        report.searchFieldChecks.push({ viewportWidth: width, ...search, passed: true });
      }
      if (name === 'billing' && width <= 390) {
        const entered = await assertLatestDateVisible();
        // 普通状态刷新保留用户查看旧日期的位置；切换统计时段才重新定位。
        await page.locator('#billing-chart').evaluate(chart => { chart.scrollLeft = 0; });
        await page.evaluate(async () => {
          window.dispatchEvent(new Event('appstatechange'));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const retainedScrollLeft = await page.locator('#billing-chart').evaluate(chart => chart.scrollLeft);
        assert.equal(retainedScrollLeft, 0, '普通状态刷新不应重置手动横向滚动');
        await page.locator('#billing-range').selectOption('30');
        const thirtyDays = await assertLatestDateVisible();
        thirtyDays.visibleDateLabels = await assertMobileDatesReadable();
        await page.locator('#billing-range').selectOption('14');
        const fourteenDays = await assertLatestDateVisible();
        fourteenDays.visibleDateLabels = await assertMobileDatesReadable();
        report.mobileChartChecks.push({ viewportWidth: width, entered, retainedScrollLeft, thirtyDays, fourteenDays, passed: true });
      }
      if ([1440, 390].includes(width)) {
        const imagePath = path.join(output, `observatory-${name}-${width}.png`);
        await page.screenshot({ path: imagePath, fullPage: true, animations: 'disabled' });
        const opacity = await page.locator(`#${name}`).evaluate(element => Number(getComputedStyle(element).opacity));
        assert.equal(opacity, 1, `${name} 截图时仍处于透明度过渡`);
        report.screenshots.push({ page: name, viewportWidth: width, opacity, path: imagePath });
      }
    }
  }

  // 资源监测两列由内容决定高度，左侧参数可独立滚动，底部与右列对齐。
  await page.setViewportSize({ width: 1440, height: 1080 });
  await view('dashboard');
  await page.locator('[data-mode=create]').click();
  for (const width of [1920, 1440, 1366]) {
    await page.setViewportSize({ width, height: 1080 });
    const geometry = await page.evaluate(() => {
      const left = document.querySelector('.workspace-grid > .composer').getBoundingClientRect();
      const right = document.querySelector('.workspace-grid > .task-column').getBoundingClientRect();
      const fields = document.querySelector('.config-fields');
      return { leftBottom: left.bottom, rightBottom: right.bottom, scrollHeight: fields.scrollHeight, clientHeight: fields.clientHeight, overflow: getComputedStyle(fields).overflowY };
    });
    assert.ok(Math.abs(geometry.leftBottom - geometry.rightBottom) <= 2, `两列底部不齐 ${width}: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.overflow, 'auto');
    assert.ok(geometry.scrollHeight > geometry.clientHeight, `参数区不可滚动 ${width}: ${JSON.stringify(geometry)}`);
    await page.locator('.config-fields').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const scrollTop = await page.locator('.config-fields').evaluate(el => el.scrollTop);
    assert.ok(scrollTop > 0);
    report.alignment.push({ viewportWidth: width, scenario: 'empty-queue', ...geometry,
      bottomDifference: Math.abs(geometry.leftBottom - geometry.rightBottom), scrollTop, passed: true });
    await assertNoOverflow('dashboard', width);
  }
  // 合成队列增长不能令左列底部停留在旧固定高度；引擎始终关闭。
  for (let index = 0; index < 5; index++) app.store.create(testConfig({ name: `隔离布局样例 ${index + 1}`, action: 'observe' }));
  await page.evaluate(() => refresh());
  const grown = await page.evaluate(() => {
    const a = document.querySelector('.composer').getBoundingClientRect(), b = document.querySelector('.task-column').getBoundingClientRect();
    return { left: a.bottom, right: b.bottom };
  });
  assert.ok(Math.abs(grown.left - grown.right) <= 2, '任务增长后两列仍需对齐');
  report.alignment.push({ viewportWidth: 1366, scenario: 'five-synthetic-tasks', leftBottom: grown.left,
    rightBottom: grown.right, bottomDifference: Math.abs(grown.left - grown.right), passed: true });
  for (const width of [768, 390, 320]) { await page.setViewportSize({ width, height: 844 }); await assertNoOverflow('dashboard', width); }
  session = { state: 'expired', browserOpen: true, label: '合成会话已过期' };
  await page.evaluate(() => refresh());
  await view('overview');
  assert.match(await page.locator('#overview-status').innerText(), /账号入口.*连接/);
  assert.equal(await page.locator('#overview-gpu-count').innerText(), '—');
  await view('billing');
  assert.match(await page.locator('#billing-status').innerText(), /账号入口.*连接|请先连接/);
  assert.equal(await page.locator('#billing-today').innerText(), '—');
  assert.equal(await page.locator('#billing-balance').innerText(), '—');
  await view('profile');
  assert.equal(await page.locator('#autodl-connection').isVisible(), true);
  assert.equal(taskPosts.length, 0);
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  report.status = 'passed';
  report.checks = { unknownResourcesRemainUnknown: true, failedRefreshPreservesTimestamp: true,
    expiredSessionHidesCachedData: true, incompleteBillingNotZero: true, chartRanges: [14, 30],
    refundNegativeBar: true, rechargeExcludedFromConsumption: true, expectedTodayYuan: expectedToday,
    instanceSearchAndStatusFilter: true, targetSelection: true, configureBootOnlyFillsForm: true };
  console.log('监控室、实例与账单隔离 UI 验收通过：六种宽度、未知指标、旧数据与不完整提示、14/30 天图表、退款充值、实例筛选和目标选择、只配置不提交，以及桌面两列对齐和参数滚动。');
} catch (error) {
  report.status = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  report.browserErrors = errors;
  report.blockedExternalRequests = blocked;
  report.forbiddenCallCount = forbiddenCalls;
  report.taskPostCount = taskPosts.length;
  fs.writeFileSync(path.join(output, 'observatory-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await app?.close();
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('autodl-observatory-ui-'));
  fs.rmSync(target, { recursive: true, force: true });
}
