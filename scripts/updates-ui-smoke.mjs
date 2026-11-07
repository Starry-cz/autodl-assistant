import { goView, openAccountMenu } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { createObservatoryFixtureAdapter } from '../tests/fixtures/observatory.mjs';

// 检查真实页面与本机接口；发布信息、账号和下载均隔离，不执行安装或云端操作。
const root = fileURLToPath(new URL('../', import.meta.url));
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repository = 'https://github.com/Starry-cz/autodl-assistant';
const output = path.join(root, 'output/playwright');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], screenshots: [], errors: [], passed: false };
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };
const browserPath = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .filter(Boolean).find(value => fs.existsSync(value));
assert.ok(browserPath, '需要可用 Chromium 浏览器');
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

function release(version) {
  const names = [`autodl-assistant-desktop-${version}-setup-x64.exe`, `autodl-assistant-desktop-${version}-win-x64.zip`,
    `autodl-assistant-v${version}.zip`, 'autodl-assistant-setup.cmd'];
  return { tag_name: 'v' + version, html_url: repository + '/releases/tag/v' + version, draft: false, prerelease: false,
    body: '合成更新说明\n<img src=x onerror="window.injected=true">\n- 更新提示功能', published_at: new Date().toISOString(),
    assets: names.map(name => ({ name, state: 'uploaded', browser_download_url: `${repository}/releases/download/v${version}/${name}` })) };
}

try {
  for (const channel of ['web', 'desktop']) {
    let now = Date.now(), mode = 'new', requests = 0, unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-updates-ui-'));
    const adapter = createObservatoryFixtureAdapter();
    const forbidden = async () => { throw Error('更新验收不允许云端操作'); };
    Object.assign(adapter, { login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden, boot: forbidden });
    const app = createApplication({ runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-updates-ui', adapters: { autodl: adapter },
      updatesOptions: { channel, clock: () => now, fetchImpl: async () => {
        requests++;
        if (requests === 1) await gate;
        if (mode === 'offline') throw new TypeError('synthetic offline');
        return new Response(JSON.stringify(release(mode === 'current' ? current : '99.0.0')));
      } }, aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + app.server.address().port;
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(base);
      await openAccountMenu(page); await page.locator('#account-menu-updates').click();
      await page.locator('#updates').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#profile #version-updates').count(), 0);
      await page.locator('#version-updates').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#update-check').disabled);
      assert.match(await page.locator('#update-status').innerText(), /检查/);
      // 网络等待不应卡住界面切页，也不能更改后台任务。
      await goView(page, 'dashboard');
      await page.locator('#dashboard').waitFor({ state: 'visible' });
      assert.equal(app.store.tasks().length, 0);
      unblock();
      await openAccountMenu(page); await page.locator('#account-menu-updates').click();
      await page.waitForFunction(() => document.querySelector('#update-latest-version').textContent.includes('99.0.0'));
      assert.match(await page.locator('#update-current-version').innerText(), new RegExp(current.replaceAll('.', '\\.')));
      assert.equal(await page.locator('#account-update-badge').isVisible(), true);
      assert.match(await page.locator('#account-entry').getAttribute('aria-label'), /新版本/);
      const expected = channel === 'desktop' ? 'autodl-assistant-desktop-99.0.0-setup-x64.exe' : 'autodl-assistant-v99.0.0.zip';
      assert.ok((await page.locator('#update-main-download').getAttribute('href')).endsWith('/' + expected));
      assert.equal(await page.locator('#update-main-download').getAttribute('target'), '_blank');
      assert.match(await page.locator('#update-main-download').getAttribute('rel'), /noopener/);
      assert.equal(await page.locator('#update-portable-download').isVisible(), channel === 'desktop');
      assert.match(await page.locator('#update-guidance').innerText(), /退出/);
      await page.locator('#update-notes summary').click();
      assert.match(await page.locator('#update-release-notes').innerText(), /<img/);
      assert.equal(await page.locator('#update-release-notes img').count(), 0);
      await page.locator('#update-notes summary').click();
      pass(channel + '：启动自动检查、等待反馈、版本标记、匹配下载入口、更新说明纯文本');

      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1050 });
        await page.locator('#version-updates').scrollIntoViewIfNeeded();
        const layout = await page.locator('#version-updates').evaluate(node => ({
          pageWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
          width: node.clientWidth, content: node.scrollWidth,
          checkWidth: document.querySelector('#update-check').getBoundingClientRect().width,
        }));
        assert.ok(layout.pageWidth <= layout.viewport + 1, channel + ' 页面横向溢出 ' + width);
        assert.ok(layout.content <= layout.width + 1, channel + ' 更新卡片横向溢出 ' + width);
        assert.ok(layout.checkWidth >= 44, '检查按钮点击范围不足');
        const file = path.join(output, `updates-${channel}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
        report.screenshots.push(file);
      }
      pass(channel + '：1440/768/390/320 宽度布局与操作可用');
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.locator('#update-check').click();
      await page.waitForFunction(() => !document.querySelector('#update-check').disabled);
      assert.equal(requests, 1, '一分钟内手动检查应复用结果');
      // 保留一次检查前的状态响应，模拟较慢轮询在检查失败之后才到达。
      let releasePoll, pollCaptured;
      const pollGate = new Promise(resolve => { releasePoll = resolve; });
      const captured = new Promise(resolve => { pollCaptured = resolve; });
      await page.route(base + '/api/state', async route => {
        const response = await route.fetch(); pollCaptured(); await pollGate; await route.fulfill({ response });
      }, { times: 1 });
      const oldRefresh = page.evaluate(() => refresh());
      await captured;
      mode = 'offline'; now += 61000;
      await page.locator('#update-check').click();
      await page.waitForFunction(() => /失败|无法/.test(document.querySelector('#update-status').textContent));
      releasePoll(); await oldRefresh;
      assert.match(await page.locator('#update-status').innerText(), /失败|无法/, '迟到轮询不能覆盖新检查的失败状态');
      assert.equal(await page.locator('#account-update-badge').isVisible(), true);
      assert.equal(await page.locator('#update-main-download').isVisible(), true);
      assert.equal(requests, 2);
      pass(channel + '：手动检查限频，离线失败保留新版，迟到轮询不覆盖新结果');
      mode = 'current'; now += 61000;
      await page.locator('#update-check').click();
      await page.waitForFunction(() => /最新/.test(document.querySelector('#update-status').textContent));
      assert.equal(await page.locator('#account-update-badge').isVisible(), false);
      assert.equal(await page.locator('#update-main-download').isVisible(), false);
      assert.equal(await page.locator('#update-guidance').isVisible(), false);
      assert.equal(app.store.tasks().length, 0);
      pass(channel + '：已是最新版时收起下载提醒，无任务和账号副作用');
      // 模拟安装交接的网络边界，不下载、不安装也不停止真实后台。
      mode = 'new'; now += 61000;
      await page.locator('#update-check').click();
      await page.waitForFunction(() => !document.querySelector('#update-install').hidden);
      let installCalls = 0;
      let installation = {status:'idle'};
      await page.route(base + '/api/updates/install', async route => {
        installCalls++;
        installation = {status:'preparing',phase:'download',targetVersion:'99.0.0',message:'正在下载新版，原数据保留'};
        await route.fulfill({status:202,json:{installation}});
      });
      await page.route(base + '/api/state', async route => {
        const response = await route.fetch(), state = await response.json();
        state.updates.installation = installation;
        await route.fulfill({response,json:state});
      });
      let switched = false;
      await page.route(base + '/api/health', route => route.fulfill({json:{app:'autodl-assistant',
        version:switched?'99.0.0':current,ready:true,codeChanged:false,installation}}));
      await page.locator('#update-install').click();
      await page.waitForFunction(() => document.querySelector('#update-install').disabled);
      assert.equal(installCalls,1);
      installation = {status:'error',targetVersion:'99.0.0',message:'合成下载失败，旧后台继续运行'};
      await page.waitForFunction(() => /失败/.test(document.querySelector('#update-installation').textContent));
      assert.equal(await page.locator('#update-install').isEnabled(),true);
      const retryResponse = page.waitForResponse(response => response.url() === base + '/api/updates/install' && response.request().method() === 'POST');
      await page.locator('#update-install').click();
      await retryResponse;
      // 等本次重试的准备状态进入页面缓存，避免沿用上次失败状态后才推进时间。
      await page.evaluate(() => refresh());
      await page.waitForFunction(() => appState.updates.installation.status === 'preparing');
      // 时间推进只作用于测试页面，验证超时提示不会被普通状态刷新覆盖。
      await page.waitForFunction(() => document.querySelector('#update-install').disabled);
      await page.evaluate(() => { window.originalDateNow = Date.now; Date.now = () => window.originalDateNow() + 21 * 60 * 1000; });
      await page.waitForFunction(() => /尚未确认新版启动/.test(document.querySelector('#update-installation').textContent));
      await page.evaluate(() => { renderUpdates(appState.updates); Date.now = window.originalDateNow; });
      assert.match(await page.locator('#update-installation').textContent(), /尚未确认新版启动/);
      installation = {status:'error',targetVersion:'99.0.0',message:'合成交接失败'};
      await page.waitForFunction(() => !document.querySelector('#update-install').disabled);
      await page.locator('#update-install').click();
      const reload = page.waitForEvent('framenavigated', {predicate: frame => frame === page.mainFrame()});
      switched = true;
      await reload;
      assert.equal(installCalls,3);
      assert.equal(app.store.tasks().length,0);
      pass(channel + '：更新按钮防重复、失败可重试、超时提示保留、新后台就绪后重载');
    } finally {
      unblock();
      await context.close();
      await app.close();
      // 仅删除本次 mkdtemp 创建的直属临时目录。
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('autodl-updates-ui-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'updates-ui-report.json'), JSON.stringify(report, null, 2));
}
