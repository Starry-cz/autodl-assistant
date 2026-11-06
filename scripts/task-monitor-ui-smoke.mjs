import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { testConfig } from '../tests/fixtures/config.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog, SYNTHETIC_GPU_CATALOG } from '../tests/fixtures/gpu-catalog.mjs';

// 只在临时服务中放入合成记录；停用引擎，任何云端操作和新建任务请求都会使验收失败。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-task-monitor-ui-'));
const output = path.join(root, 'output', 'playwright'); fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', synthetic: true,
  checks: [], layouts: [], screenshots: [], errors: [], externalRequests: [], taskPosts: 0, forbiddenCalls: 0, logRequests: [] };
let app, browser, releaseExport;
const forbidden = async () => { report.forbiddenCalls++; throw Error('任务监测 UI 验收禁止云端操作'); };
const sample = (at, overrides = {}) => ({ at, kind: 'market', available: 4, total: 16, knownAvailable: 4,
  hostCount: 3, complete: true, gpuAvailable: null, scope: 'full', status: 'ok', note: '合成完整已读范围', ...overrides });
const bootSample = (at, gpuAvailable) => sample(at, { kind: 'boot', available: null, total: null, knownAvailable: null,
  hostCount: null, gpuAvailable, complete: gpuAvailable !== null, scope: 'target', status: gpuAvailable === null ? 'unknown' : 'ok', note: '只核对原实例 GPU 状态' });
const monitor = (samples, checking = false) => ({ checking, lastCheckStartedAt: samples.at(-1)?.at ?? null,
  lastCheckedAt: samples.at(-1)?.at ?? null, samples });

try {
  const adapter = Object.assign(new SyntheticAdapter(), {
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '合成会话可用', checkedAt: Date.now() }),
    login: forbidden, checkLogin: forbidden, instances: forbidden, probe: forbidden, prepare: forbidden,
    submit: forbidden, boot: forbidden, reconcile: forbidden,
  });
  app = createApplication({ runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-task-monitor-ui-build',
    adapters: { autodl: adapter }, aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  seedGpuCatalog(app.store, { ...structuredClone(SYNTHETIC_GPU_CATALOG), checkedAt: Date.now() });
  const now = Date.now();
  const seed = (name, config, patch) => {
    const task = app.store.create(testConfig({ name, pollSeconds: 20, ...config }));
    app.store.patch(task, { state: 'watching', attempts: 60, nextCheckAt: now + 30000, ...patch });
    return task;
  };
  const unknown = seed('原实例状态待确认', { mode: 'boot' }, { monitor: monitor([bootSample(now - 1000, null)]) });
  const completed = seed('新建已完成', {}, { state: 'completed', result: { id: 'synthetic-completed' }, monitor: monitor([sample(now - 2000)]) });
  const found = seed('发现原实例有卡', { mode: 'boot' }, { state: 'found', monitor: monitor([bootSample(now - 2000, true)]) });
  const paused = seed('原实例暂时无卡', { mode: 'boot' }, { state: 'paused', monitor: monitor([bootSample(now - 3000, false)]) });
  const partialSample = sample(now - 3000, { available: null, total: null, knownAvailable: 3, complete: false,
    scope: 'first-page', note: '已读范围：北京B区首页，后续页面未读取' });
  const partial = seed('新建首页已读范围', { scanScope: 'first-page' }, { monitor: monitor([partialSample]) });
  const checking = seed('克隆正在检查', { mode: 'clone', scanScope: 'first-page' }, { monitor: monitor([partialSample], true) });
  const history = Array.from({ length: 60 }, (_, index) => sample(now - (60 - index) * 20000, { available: index % 7, knownAvailable: index % 7 }));
  history[10] = sample(history[10].at, { available: null, total: null, knownAvailable: null, complete: false, status: 'unknown', note: '合成未知库存' });
  history[20] = sample(history[20].at, { available: null, total: null, knownAvailable: null, complete: false, status: 'error', note: '合成读取失败' });
  history[30] = { ...partialSample, at: history[30].at };
  const name = '监测 <b>合成</b> & "日志"';
  const primary = seed(name, {}, { monitor: monitor(history), logs: Array.from({ length: 200 }, (_, index) => ({
    at: now - (200 - index) * 1000, level: index % 17 === 0 ? 'warn' : 'info',
    message: `合成日志${String(index + 1).padStart(3, '0')}：<标签> & "引号"${index === 0 ? '\n第二行完整保留' : ''}`,
  })) });
  const initialTaskCount = app.store.tasks().length;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const executablePath = [process.env.AI_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(candidate => fs.existsSync(candidate));
  assert.ok(executablePath, '未找到 Chromium 测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
  let downloads = 0;
  const exportGate = new Promise(resolve => { releaseExport = resolve; });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
    if (/^\/api\/tasks\/[^/]+\/logs$/.test(url.pathname)) {
      report.logRequests.push({ method: request.method(), path: url.pathname });
      await exportGate;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('download', () => { downloads++; });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') report.taskPosts++; });
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  await page.locator('[data-view=dashboard]').click();
  await page.waitForFunction(count => document.querySelectorAll('article[data-task-id]').length === count, initialTaskCount);
  const card = task => page.locator(`article[data-task-id="${task.id}"]`);
  const countdown = task => card(task).locator(`[data-task-countdown="${task.id}"]`);
  assert.equal(await card(primary).locator('h3').innerText(), name);
  assert.equal(await card(primary).locator('h3 b').count(), 0, '任务名按普通文本显示');
  assert.match(await countdown(checking).innerText(), /检查中/);
  assert.match(await countdown(paused).innerText(), /已暂停/);
  assert.match(await countdown(found).innerText(), /发现|已找到|有空卡/);
  assert.match(await countdown(completed).innerText(), /完成/);
  for (const [task, expected] of [[found, /GPU 充足/], [paused, /GPU 不足/], [unknown, /GPU 待确认/]]) {
    const latest = await card(task).locator('[data-monitor-latest]').innerText();
    assert.match(latest, expected); assert.doesNotMatch(latest, /\d+\s*(张|台)|\d+\s*\/\s*\d+/, '原实例开机不伪造数值库存');
  }
  for (const task of [partial, checking]) {
    const latest = await card(task).locator('[data-monitor-latest]').innerText();
    assert.match(latest, /已读范围/); assert.match(latest, /3/); assert.doesNotMatch(latest, /总数|总量/);
  }
  report.checks.push('状态与库存语义：checking / paused / found / completed；boot 只有充足、 不足、待确认；create 和 clone 的不完整读数标注已读范围');

  // 使用真实 nextCheckAt 和真实秒钟，跨越一次 /state 轮询；倒计时本身不能替换任务卡或移动焦点。
  app.store.patch(primary, { nextCheckAt: Date.now() + 20000 });
  await page.evaluate(() => refresh());
  await page.waitForFunction(({ id, due }) => document.querySelector(`[data-task-countdown="${id}"]`)?.dataset.next === String(due), { id: primary.id, due: primary.nextCheckAt });
  const before = await page.evaluate(id => {
    const article = document.querySelector(`article[data-task-id="${id}"]`), button = article.querySelector('[data-detail]');
    window.scrollTo(0, 240); button.focus({ preventScroll: true });
    window.__monitorQueueChanges = 0;
    window.__monitorNodes = { article, button };
    window.__monitorObserver = new MutationObserver(records => { window.__monitorQueueChanges += records.filter(record => record.type === 'childList').length; });
    window.__monitorObserver.observe(document.querySelector('#tasks'), { childList: true });
    return { at: Date.now(), text: article.querySelector('[data-task-countdown]').textContent, y: scrollY, listTop: document.querySelector('#tasks').scrollTop };
  }, primary.id);
  await page.waitForTimeout(3200);
  const after = await page.evaluate(id => {
    const article = document.querySelector(`article[data-task-id="${id}"]`);
    window.__monitorObserver.disconnect();
    return { at: Date.now(), text: article.querySelector('[data-task-countdown]').textContent, y: scrollY,
      listTop: document.querySelector('#tasks').scrollTop, sameArticle: article === window.__monitorNodes.article,
      sameButton: document.activeElement === window.__monitorNodes.button, queueChanges: window.__monitorQueueChanges };
  }, primary.id);
  const seconds = value => Number(value.match(/\d+/)?.[0]);
  const elapsed = (after.at - before.at) / 1000, difference = seconds(before.text) - seconds(after.text);
  // 向上取整与一秒刷新各自有相位差；同时用真实到期时间限制显示误差为一秒。
  assert.ok(difference >= 2 && Math.abs(difference - elapsed) <= 2, JSON.stringify({ before, after }));
  assert.ok(Math.abs(seconds(after.text) - Math.ceil((primary.nextCheckAt - after.at) / 1000)) <= 1, '倒计时从真实 nextCheckAt 计算');
  assert.equal(after.sameArticle, true); assert.equal(after.sameButton, true); assert.equal(after.queueChanges, 0);
  assert.equal(after.y, before.y); assert.equal(after.listTop, before.listTop);
  report.countdown = { before, after, elapsed, difference };
  app.store.patch(primary, { nextCheckAt: Date.now() - 1000 }); await page.evaluate(() => refresh());
  await page.waitForFunction(id => document.querySelector(`[data-task-countdown="${id}"]`).textContent.includes('等待检查'), primary.id);
  report.checks.push('真实截止时间秒级倒计时、到期等待；两秒状态轮询不重写队列、不丢焦点和滚动位置');

  await card(primary).locator('[data-detail]').click(); await page.locator('#task-dialog').waitFor({ state: 'visible' });
  const historyDetails = page.locator(`[data-monitor-history="${primary.id}"]`);
  assert.equal(await historyDetails.evaluate(node => node.open), false);
  await historyDetails.locator('summary').click();
  const svg = historyDetails.locator('svg.task-sample-svg');
  assert.equal(await svg.locator('[data-sample-index]').count(), 60);
  assert.equal(await svg.locator('.task-sample-gap').count(), 2);
  assert.equal(await svg.locator('.task-sample-partial').count(), 1);
  const lines = await svg.locator('.task-sample-line').evaluateAll(nodes => nodes.map(node => [Number(node.dataset.fromIndex), Number(node.dataset.toIndex)]));
  const expectedLines = history.flatMap((entry, index) => index > 0 && entry.status === 'ok' && entry.complete && history[index - 1].status === 'ok'
    && history[index - 1].complete && entry.scope === history[index - 1].scope ? [[index - 1, index]] : []);
  assert.equal(expectedLines.length, 53); assert.deepEqual(lines, expectedLines, '未知、失败与不完整采样两侧均断开，不跨缺失点连线');
  await page.evaluate(() => refresh()); assert.equal(await historyDetails.evaluate(node => node.open), true, '刷新保留展开的历史');
  report.checks.push('详情最近 60 点、53 段有效连线；未知和失败有断点、不完整点只展示已读小计，折叠状态跨刷新保留');

  // /state 只带最近 80 条，导出必须等待 GET 完成后再下载当前保留的全部 200 条。
  assert.equal(await page.locator('#detail-content .log-list .log').count(), 80);
  assert.equal(await page.locator('#detail-content .log-list').innerText().then(value => value.includes('合成日志001')), false);
  const downloadPromise = page.waitForEvent('download');
  const logRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/tasks/${primary.id}/logs`);
  await page.locator(`[data-export-logs="${primary.id}"]`).click();
  await logRequest;
  assert.equal(downloads, 0, '完整日志响应尚未到达，不能先导出可见 80 条');
  releaseExport();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null); assert.match(download.suggestedFilename(), /\.txt$/i);
  const text = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(text.includes(name)); assert.ok(text.includes('第二行完整保留'));
  for (const entry of primary.logs) assert.ok(text.includes(entry.message), '导出遗漏：' + entry.message);
  assert.equal((text.match(/合成日志\d{3}/g) || []).length, 200);
  assert.deepEqual(report.logRequests, [{ method: 'GET', path: `/api/tasks/${primary.id}/logs` }]);
  report.export = { filename: download.suggestedFilename(), visibleLogs: 80, downloadedLogs: 200, waitedForFullResponse: true };
  report.checks.push('完整日志 GET 后下载 txt，200 条全部保留；特殊字符与多行日志保持可读');
  await page.locator('#close-dialog').click();

  // 原实例曲线只有二值语义；未知状态作为断点，不能画成零张库存。
  app.store.patch(paused, { monitor: monitor([bootSample(now - 3000, false), bootSample(now - 2000, null), bootSample(now - 1000, true)]) });
  await page.evaluate(() => refresh());
  await page.waitForFunction(id => document.querySelector(`article[data-task-id="${id}"] [data-monitor-latest]`).textContent.includes('GPU 充足'), paused.id);
  await card(paused).locator('[data-detail]').click();
  const bootHistory = page.locator(`[data-monitor-history="${paused.id}"]`); await bootHistory.locator('summary').click();
  assert.match(await bootHistory.innerText(), /充足/); assert.match(await bootHistory.innerText(), /不足/);
  assert.equal(await bootHistory.locator('.task-sample-gap').count(), 1);
  assert.equal(await bootHistory.locator('.task-sample-line').count(), 0);
  assert.doesNotMatch(await bootHistory.innerText(), /[01]\s*张/);
  await page.locator('#close-dialog').click();
  await page.locator('#toast').waitFor({ state: 'hidden' });

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.locator('[data-view=dashboard]').click(); await page.evaluate(() => window.scrollTo(0, 0));
    const geometry = await page.evaluate(() => {
      const left = document.querySelector('.composer').getBoundingClientRect(), right = document.querySelector('.task-column').getBoundingClientRect();
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, bottomDifference: Math.abs(left.bottom - right.bottom),
        sameRow: Math.abs(left.top - right.top) <= 2, cards: [...document.querySelectorAll('article[data-task-id]')].map(node => ({ width: node.clientWidth, content: node.scrollWidth })) };
    });
    assert.ok(geometry.pageWidth <= width + 1, JSON.stringify(geometry));
    assert.ok(geometry.cards.every(item => item.content <= item.width + 1), JSON.stringify(geometry));
    if (width === 1440) { assert.equal(geometry.sameRow, true); assert.ok(geometry.bottomDifference <= 2, JSON.stringify(geometry)); }
    report.layouts.push({ page: 'dashboard', ...geometry });
    await card(primary).scrollIntoViewIfNeeded();
    if (width !== 320) {
      const screenshot = path.join(output, `task-monitor-queue-${width}.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' }); report.screenshots.push(screenshot);
    }
    await card(primary).locator('[data-detail]').click();
    const detailHistory = page.locator(`[data-monitor-history="${primary.id}"]`);
    if (!await detailHistory.evaluate(node => node.open)) await detailHistory.locator('summary').click();
    await detailHistory.scrollIntoViewIfNeeded();
    const detail = await page.locator('#task-dialog').evaluate(node => ({ width: innerWidth, dialogWidth: node.clientWidth, contentWidth: node.scrollWidth,
      chartWidth: node.querySelector('.task-sample-svg').getBoundingClientRect().width }));
    assert.ok(detail.contentWidth <= detail.dialogWidth + 1, JSON.stringify(detail));
    report.layouts.push({ page: 'detail', ...detail });
    if (width !== 320) {
      const screenshot = path.join(output, `task-monitor-detail-${width}.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' }); report.screenshots.push(screenshot);
    }
    await page.locator('#close-dialog').click();
  }
  assert.equal(app.store.tasks().length, initialTaskCount); assert.equal(app.store.tasks().every(task => task.operation === null), true);
  assert.equal(app.store.data.notifications.length, 0); assert.equal(report.taskPosts, 0); assert.equal(report.forbiddenCalls, 0);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, checks: report.checks, layouts: report.layouts, countdown: report.countdown,
    export: report.export, taskPosts: report.taskPosts, forbiddenCalls: report.forbiddenCalls, errors: report.errors }, null, 2));
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error); throw error;
} finally {
  releaseExport?.(); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'task-monitor-ui-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await app?.close();
  const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('autodl-task-monitor-ui-')); fs.rmSync(target, { recursive: true, force: true });
}
