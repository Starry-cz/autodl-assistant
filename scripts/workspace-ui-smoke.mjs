import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { normalizeAccountIdentity } from '../src/account-scope.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID } from '../tests/fixtures/observatory.mjs';

// 账号、目录、账单和实例均来自合成适配器；真实浏览器资料与云端操作不在此脚本范围内。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-workspace-ui-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running',
  dataSource: '共享合成 fixture 与固定合成账号；不代表真实账户、库存或账单',
  isolation: { temporaryRuntime: true, startEngine: false, headless: true, externalRequestsBlocked: true },
  widths: [1920, 1440, 1366, 768, 390, 320], pageChecks: [], screenshots: [], mobileAccountChecks: [],
  browserErrors: [], externalRequests: [], taskPosts: [], apiRequests: [], forbiddenCallCount: 0 };
let app, browser;
const forbidden = async () => { report.forbiddenCallCount++; throw Error('整合 UI 验收禁止执行云端操作或外部请求'); };

try {
  const adapter = createObservatoryFixtureAdapter();
  let currentAccount = { accountId: 'synthetic-workspace-account', subAccountId: null,
    displayName: '合成工作账号', kind: 'main' };
  let session = { state: 'not_open', browserOpen: false, checkedAt: null, label: '尚未连接', message: '合成登录流程，未打开真实浏览器' };
  adapter.sessionStatus = () => ({ ...session });
  adapter.login = async () => {
    session = { state: 'login_required', browserOpen: true, checkedAt: Date.now(), label: '等待登录', message: '合成浏览器已打开，请检查登录状态' };
    return { session: { ...session }, message: session.message };
  };
  adapter.checkLogin = async () => {
    session = { state: 'ready', browserOpen: true, checkedAt: Date.now(), readySince: Date.now(), label: '已核验', message: '合成账号登录已核验' };
    return { session: { ...session }, message: session.message };
  };
  adapter.readIdentity = async () => normalizeAccountIdentity(currentAccount, { now: Date.now() });
  adapter.marketHosts = async ({ model, region }) => ({ checkedAt: Date.now(), complete: true, rows: [
    { hostId: 'synthetic-workspace-host', hostNumber: '合成 922 机', model: 'RTX 4090', region: '北京B区', available: 2, total: 8,
      pricePerHour: 1.98, status: '可用', disabled: false },
    { hostId: 'synthetic-workspace-northwest', hostNumber: '合成西北主机', model: 'RTX 4090', region: '西北B区', available: 0, total: 16,
      pricePerHour: 2.08, status: '暂无空卡', disabled: false },
    { hostId: 'synthetic-workspace-l20', hostNumber: '合成 L20 主机', model: 'L20', region: '北京B区', available: 1, total: 8,
      pricePerHour: 1.28, status: '可用', disabled: false },
  ].filter(row => (!model || row.model === model) && (!region || row.region === region)) });
  adapter.logout = async () => {
    session = { state: 'not_open', browserOpen: false, checkedAt: Date.now(), label: '已退出', message: '合成账号已退出' };
    return { session: { ...session }, message: session.message };
  };
  Object.assign(adapter, { probe: forbidden, prepare: forbidden, submit: forbidden, boot: forbidden, inspectBoot: forbidden });
  // 隔离验收固定构建标识，不让其他协作者同时编辑文件触发无关的后台更新横幅。
  app = createApplication({ runtimeDir, startEngine: false, fingerprint: () => 'synthetic-workspace-ui-build', adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(executablePath, '未找到可用的 Chromium 浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    report.apiRequests.push(pathname);
    if (pathname === '/api/tasks') report.taskPosts.push(request.postDataJSON());
  });
  const settleView = async name => {
    await page.locator('#' + name).waitFor({ state: 'visible' });
    await page.locator('#' + name).evaluate(async node => {
      const animations = node.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime));
      await Promise.allSettled(animations.map(animation => animation.finished));
    });
  };
  const view = async name => { await page.locator('.nav-item[data-view="' + name + '"]').click(); await settleView(name); };
  const requestThrough = async (selector, pathname) => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === pathname && result.request().method() === 'POST');
    await page.locator(selector).click(); assert.equal((await response).status(), 200);
  };
  const screenshot = async (name, width, suffix = '') => {
    const imagePath = path.join(output, 'workspace-' + name + '-' + width + suffix + '.png');
    await page.screenshot({ path: imagePath, fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('#' + name).evaluate(node => Number(getComputedStyle(node).opacity)), 1);
    report.screenshots.push({ page: name, width, path: imagePath });
  };
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  assert.equal(await page.locator('#dashboard #account-instances').count(), 0);
  assert.equal(await page.locator('#dashboard #wallet-form').count(), 0);
  assert.equal(await page.locator('#dashboard #autodl-connection').count(), 0);
  await view('profile');
  assert.equal(await page.locator('#check-browser').isDisabled(), true);
  assert.match(await page.locator('#profile-status').innerText(), /未|尚/);
  await screenshot('profile', 1440, '-before-login');
  await requestThrough('#open-browser', '/api/browser/open');
  await page.waitForFunction(() => !document.querySelector('#check-browser').disabled);
  await requestThrough('#check-browser', '/api/browser/check');
  // 登录成功由产品自身串行同步，测试不直接塞入页面数据或调用各查询接口。
  await page.waitForFunction(() => appState.account?.identity?.displayName === '合成工作账号'
    && appState.observatory?.overview && appState.observatory?.billing && appState.market?.snapshot && !appState.browser.busy);
  assert.equal(await page.locator('#profile-name').innerText(), '合成工作账号');
  assert.equal(await page.locator('#account-name').innerText(), '合成工作账号');
  const autoPaths = report.apiRequests.filter(item => ['/api/observatory/overview', '/api/observatory/billing', '/api/autodl/gpus'].includes(item));
  assert.deepEqual(autoPaths, ['/api/observatory/overview', '/api/observatory/billing', '/api/autodl/gpus']);
  report.loginAutoSync = autoPaths;

  await view('overview');
  assert.equal(await page.locator('#market-total').innerText(), '96');
  assert.equal(await page.locator('#market-available').innerText(), '11');
  assert.equal(await page.locator('#market-model-count').innerText(), '6');
  assert.equal(await page.locator('#market-region-count').innerText(), '6 / 6');
  assert.equal(await page.locator('#market-models .market-bar-row').count(), 6);
  assert.equal(await page.locator('#market-regions .market-bar-row').count(), 6);
  assert.equal(await page.locator('#market-heatmap .market-heat-cell').count(), 36);
  assert.equal(await page.locator('#market-trend .market-trend-dot').count(), 1);
  // 上方两个条形图独立筛选，切换维度必须清掉前一维度。
  await requestThrough('#market-models [data-market-model="RTX 4090"]', '/api/market/hosts');
  await page.waitForFunction(() => document.querySelectorAll('.market-host-table tbody tr').length === 2);
  assert.equal(await page.locator('#market-host-region').inputValue(), '');
  assert.match(await page.locator('.market-host-table').innerText(), /西北B区/);
  await requestThrough('#market-regions [data-market-region="北京B区"]', '/api/market/hosts');
  await page.waitForFunction(() => document.querySelector('.market-host-table')?.textContent.includes('合成 L20 主机'));
  assert.equal(await page.locator('#market-host-model').inputValue(), '');
  assert.equal(await page.locator('#market-regions [data-market-region="北京B区"]').getAttribute('aria-pressed'), 'true');
  const selectedCell = page.locator('#market-heatmap [data-market-model="RTX 4090"][data-market-region="北京B区"]');
  assert.equal(await selectedCell.innerText(), '2 / 8');
  const hostsResponse = page.waitForResponse(result => new URL(result.url()).pathname === '/api/market/hosts');
  await selectedCell.click(); assert.equal((await hostsResponse).status(), 200);
  await page.locator('#market-host-list [data-market-use-model]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#overview').isVisible(), true, '热力格只筛选本页主机，不直接跳转任务配置');
  assert.equal(report.taskPosts.length, 0);
  await page.locator('#market-host-list [data-market-use-model]').click(); await settleView('dashboard');
  assert.equal(await page.locator('#task-form [name=gpuModel]').inputValue(), 'RTX 4090');
  assert.deepEqual(await page.locator('#task-form input[name=region]:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['北京B区']);
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);
  assert.equal(app.store.tasks().length, 0);

  // 执行方式切换只更新原字段，并清空费用授权，不代表点击了提交。
  await page.locator('[data-action-choice=execute]').click();
  await page.locator('#task-form [name=paidConsent]').check();
  await page.locator('[data-action-choice=observe]').click();
  assert.equal(await page.locator('#task-form [name=action]').inputValue(), 'observe');
  assert.equal(await page.locator('[data-action-choice=observe]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);
  await page.locator('[data-action-choice=execute]').click();
  assert.equal(await page.locator('#task-form [name=action]').inputValue(), 'execute');
  assert.equal(await page.locator('[data-action-choice=execute]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);

  await view('billing');
  assert.equal(await page.locator('#billing-budget-credentials').evaluate(node => node.open), false);
  await page.locator('#billing-budget-credentials > summary').click();
  await page.locator('#wallet-options > summary').click();
  assert.equal(await page.locator('#wallet-form').isVisible(), true);
  await page.locator('#billing-budget-credentials > summary').click();
  await view('fleet');
  assert.equal(await page.locator('#fleet-sources').evaluate(node => node.open), false);
  await page.locator('#fleet-sources > summary').click();
  await requestThrough('#sync-instances', '/api/autodl/instances');
  await page.waitForFunction(id => document.querySelector('#account-instances').textContent.includes(id), OBSERVATORY_INSTANCE_ID);
  await page.locator('#fleet-sources > summary').click();
  await page.locator('#toast').waitFor({ state: 'hidden' });

  // 完整覆盖新五页的六种宽度；图表内部滚动不应扩大整页宽度。
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1080 });
    for (const name of ['overview', 'fleet', 'billing', 'profile', 'dashboard']) {
      await view(name);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(geometry.document <= geometry.viewport + 1, name + ' ' + width + 'px 整页横向溢出：' + JSON.stringify(geometry));
      report.pageChecks.push({ page: name, width, ...geometry, passed: true });
      await screenshot(name, width);
    }
    if (width <= 390) {
      await page.locator('#account-entry').click(); await settleView('profile');
      const bounds = await page.locator('#account-entry').boundingBox();
      assert.ok(bounds && bounds.width >= 40 && bounds.height >= 40, '手机账号入口需要可点击尺寸');
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, '手机账号入口应处于屏幕内');
      assert.equal(await page.locator('#profile-name').innerText(), '合成工作账号');
      report.mobileAccountChecks.push({ viewportWidth: width, ...bounds, passed: true });
    }
  }
  // 通过真实设置表单保存 A 的通知，再从合成登录会话切到 B；不直接改前端状态或表单加载标记。
  await page.setViewportSize({ width: 1440, height: 1080 });
  await view('dashboard');
  await page.locator('#task-form [name=paidConsent]').check();
  await view('settings');
  await page.locator('#settings-form [name=webhookEnabled]').check();
  await page.locator('#settings-form [name=webhookUrl]').fill('https://synthetic.invalid/account-a');
  await page.locator('#settings-form [name=webhookToken]').fill('synthetic-account-a-webhook');
  await page.locator('#settings-form [name=wechatEnabled]').check();
  await page.locator('#settings-form [name=wechatToken]').fill('synthetic-account-a-wechat');
  await page.locator('#settings-form [name=rememberCredentials]').uncheck();
  await requestThrough('#settings-form button[type=submit]', '/api/notifications/settings');
  await page.waitForFunction(() => document.querySelector('#settings-form [name=wechatToken]').value === '***');
  assert.equal(await page.locator('#settings-form [name=webhookEnabled]').isChecked(), true);
  assert.equal(await page.locator('#settings-form [name=wechatEnabled]').isChecked(), true);
  currentAccount = { accountId: 'synthetic-workspace-account-b', subAccountId: null,
    displayName: '合成账号 B', kind: 'main' };
  await view('profile');
  await requestThrough('#check-browser', '/api/browser/check');
  await page.waitForFunction(() => appState.account?.identity?.displayName === '合成账号 B' && !window.workspaceSyncing);
  await view('settings');
  const displayedSettings = await page.locator('#settings-form').evaluate(form => ({
    webhookEnabled: form.elements.webhookEnabled.checked, wechatEnabled: form.elements.wechatEnabled.checked,
    webhookUrl: form.elements.webhookUrl.value, webhookToken: form.elements.webhookToken.value,
    wechatToken: form.elements.wechatToken.value, rememberCredentials: form.elements.rememberCredentials.checked,
  }));
  // 后端换号关闭通知、清微信 Token，但保留停用的 Webhook；UI 必须完整反映当前服务端设置。
  const expectedSettings = { webhookEnabled: false, wechatEnabled: false,
    webhookUrl: '***', webhookToken: '***', wechatToken: '', rememberCredentials: false };
  assert.deepEqual(app.store.publicState().settings, expectedSettings);
  assert.deepEqual(displayedSettings, expectedSettings, '换账号后通知表单不能保留旧账号的开关或已清除凭据掩码');
  assert.equal(await page.locator('#task-form [name=paidConsent]').isChecked(), false);
  await requestThrough('#settings-form button[type=submit]', '/api/notifications/settings');
  assert.equal(app.store.data.settings.webhookEnabled, false, '直接保存 B 的表单不能重新开启 A 的通知渠道');
  assert.equal(app.store.data.settings.wechatEnabled, false);
  report.accountSwitchSettings = { from: '合成工作账号', to: '合成账号 B', settingsMatchServer: true, consentCleared: true };
  assert.equal(report.taskPosts.length, 0);
  assert.equal(app.store.tasks().length, 0);
  assert.equal(report.forbiddenCallCount, 0);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.browserErrors, []);
  report.status = 'passed';
  report.checks = { loginAndIdentity: true, serialAutomaticSync: true, dashboardFocusedOnTasks: true,
    budgetCredentialsDisclosure: true, sourceInstancesDisclosure: true, actionChoiceClearsConsent: true, accountSwitchReloadsSettings: true,
    marketFixtureValues: { total: 96, available: 11, models: 6, regions: 6 }, marketSelectionOnlyFillsForm: true };
  console.log('整合工作台 UI 验收通过：合成账号登录、串行自动同步、五页六宽度、手机账号入口、市场图表填表、换号通知设置与费用授权，零任务提交。');
} catch (error) {
  report.status = 'failed'; report.failure = error.message; throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'workspace-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await app?.close();
  const resolved = path.resolve(runtimeDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('autodl-workspace-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
