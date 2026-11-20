import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';

// 只检验信息提示的呈现与键盘/触屏行为，后台使用独立临时数据且禁止云端操作。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-ui-help-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], screenshots: [], posts: [], externalRequests: [], browserErrors: [], forbiddenCalls: 0 };
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };
const forbidden = async () => { report.forbiddenCalls++; throw Error('信息提示验收禁止外部调用或云端操作'); };
let app, browser;

try {
  const adapter = Object.assign(new SyntheticAdapter(), {
    sessionStatus: () => ({ state: 'not_open', browserOpen: false, checkedAt: null, label: '尚未连接', message: '隔离界面验收' }),
    login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden,
    submit: forbidden, boot: forbidden, inspectBoot: forbidden,
  });
  app = createApplication({ runtimeDir, startEngine: false, fingerprint: () => 'synthetic-ui-help-build',
    updatesOptions: offlineUpdateOptions, adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(executablePath, '缺少可运行的 Chromium 浏览器');
  browser = await chromium.launch({ executablePath, headless: true });

  const openPage = async options => {
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block', ...options });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') report.posts.push(new URL(request.url()).pathname); });
    await page.goto(base + '#dashboard');
    await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      window.uiHelpTestSubmits = 0;
      document.addEventListener('submit', () => { window.uiHelpTestSubmits++; }, true);
    });
    return { context, page };
  };

  const assertTooltip = async (page, button) => {
    const tooltip = page.locator('#ui-help-tooltip');
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await tooltip.getAttribute('role'), 'tooltip');
    assert.equal(await tooltip.innerText(), await button.getAttribute('data-help'));
    assert.ok((await button.getAttribute('aria-describedby') || '').split(/\s+/).includes('ui-help-tooltip'), '读屏描述应关联当前提示');
    const geometry = await tooltip.evaluate(node => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        width: innerWidth, height: innerHeight, unobscured: hit === node || node.contains(hit) };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1
      && geometry.top >= 0 && geometry.bottom <= geometry.height + 1, '提示不得超出视口：' + JSON.stringify(geometry));
    assert.equal(geometry.unobscured, true, '提示应可见且不被模态层遮挡');
    return geometry;
  };
  const hidden = page => page.locator('#ui-help-tooltip').waitFor({ state: 'hidden' });
  const screenshot = async (page, name) => {
    const file = path.join(output, name + '.png');
    await page.screenshot({ path: file, animations: 'disabled' }); report.screenshots.push(file);
  };

  const { context: desktopContext, page } = await openPage({ viewport: { width: 1440, height: 1000 } });
  const button = page.locator('#dashboard .info-button[data-help]').first();
  await button.waitFor({ state: 'visible' });
  const invalidButtons = await page.locator('.info-button[data-help]').evaluateAll(buttons => buttons
    .filter(node => node.tagName !== 'BUTTON' || node.type !== 'button' || !node.getAttribute('aria-label')?.trim() || node.tabIndex < 0)
    .map(node => node.outerHTML));
  assert.deepEqual(invalidButtons, [], '所有信息入口必须是有名称且可键盘访问的非提交按钮');
  await hidden(page);
  pass('信息入口保留可访问名称、原生键盘焦点和非提交类型');

  await button.focus();
  await assertTooltip(page, button);
  await page.keyboard.press('Escape'); await hidden(page);
  assert.equal(await button.evaluate(node => node === document.activeElement), true, 'Escape 关闭提示后保留当前焦点');
  await page.keyboard.press('Enter'); await assertTooltip(page, button);
  await page.keyboard.press('Escape'); await hidden(page);
  pass('键盘聚焦可阅读提示，Escape 关闭且保留焦点，Enter 可再次打开');

  await page.locator('#dashboard h1').click();
  await button.hover(); await assertTooltip(page, button);
  await page.locator('#ui-help-tooltip').hover();
  await assertTooltip(page, button);
  await page.locator('#dashboard h1').hover(); await hidden(page);
  pass('悬停显示提示，移入提示本身仍可阅读，离开后关闭');

  await button.click(); await assertTooltip(page, button);
  await screenshot(page, 'ui-help-desktop');
  await button.click(); await hidden(page);
  await button.click(); await assertTooltip(page, button);
  await page.locator('#dashboard h1').click(); await hidden(page);
  pass('点击可切换提示，点击外部可关闭');

  await button.click(); await assertTooltip(page, button);
  // 使用真实滚动事件路径验证悬浮提示不会停在已离开的表单位置。
  await page.locator('.config-fields').evaluate(node => { node.scrollTop += 30; node.dispatchEvent(new Event('scroll')); });
  await hidden(page);
  pass('表单滚动后关闭提示');

  // 模态框属于浏览器顶层；注入单个同规格测试入口，验证动态提示不会被遮在框后。
  await page.evaluate(() => {
    const dialog = document.querySelector('#task-dialog');
    const entry = document.createElement('button');
    entry.type = 'button'; entry.id = 'synthetic-modal-help'; entry.className = 'info-button';
    entry.setAttribute('aria-label', '合成模态提示');
    entry.dataset.help = '合成模态信息，仅用于验证提示层级与关闭交互。';
    entry.textContent = 'i';
    dialog.querySelector('#detail-content').append(entry); dialog.showModal();
  });
  const modalButton = page.locator('#synthetic-modal-help');
  await modalButton.focus(); await assertTooltip(page, modalButton);
  await screenshot(page, 'ui-help-dialog');
  await page.keyboard.press('Escape'); await hidden(page);
  assert.equal(await page.locator('#task-dialog').isVisible(), true, '第一次 Escape 仅关闭提示，不应误关闭对话框');
  await page.locator('#close-dialog').click();
  await page.locator('#task-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.uiHelpTestSubmits), 0);
  await desktopContext.close();
  pass('动态模态提示显示于对话框上方，Escape 不误操作对话框');

  const { context: mobileContext, page: mobile } = await openPage({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const mobileButton = mobile.locator('#dashboard .info-button[data-help]').first();
  await mobileButton.tap(); await assertTooltip(mobile, mobileButton);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await screenshot(mobile, 'ui-help-mobile');
  await mobileButton.tap(); await hidden(mobile);
  await mobileButton.tap(); await assertTooltip(mobile, mobileButton);
  await mobile.locator('#dashboard h1').tap(); await hidden(mobile);
  assert.equal(await mobile.evaluate(() => window.uiHelpTestSubmits), 0);
  await mobileContext.close();
  pass('手机轻触可开关提示，320px 页面与提示不溢出');

  // 页面启动会自动检查更新；该端点使用离线夹具，不属于业务表单提交。
  assert.deepEqual(report.posts.filter(endpoint => endpoint !== '/api/updates/check'), [], '阅读帮助不能保存表单或创建任务');
  assert.equal(app.store.tasks().length, 0);
  assert.equal(report.forbiddenCalls, 0);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.browserErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); throw error;
} finally {
  await browser?.close(); await app?.close();
  fs.writeFileSync(path.join(output, 'ui-help-report.json'), JSON.stringify(report, null, 2) + '\n');
  const resolved = path.resolve(runtimeDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('autodl-ui-help-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
