import { syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { SESSION_DETAILS, readSessionSnapshot, classifySessionSnapshot } from '../src/adapters/autodl-session.mjs';

// 隔离的 UI/文档夹具：所有会话都是合成数据，浏览器禁止请求非本地地址。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 回归截图仅保留在被 Git 忽略的本机输出目录，不写入发布文档。
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-login-ui-isolated-'));
const errors = [], blocked = [];
let app, browser, opens = 0, checks = 0, nextState = 'login_required', releaseCheck;
let session = { state: 'not_open', ...SESSION_DETAILS.not_open, checkedAt: null, browserOpen: false };
function setSession(state, browserOpen = true) {
  session = { state, ...SESSION_DETAILS[state], message: '本地合成测试：' + SESSION_DETAILS[state].message,
    checkedAt: ['not_open','unchecked'].includes(state) ? null : Date.now(), browserOpen };
  return { ...session };
}
try {
  const autodl = Object.assign(new SyntheticAdapter(), {
    imageOptions: syntheticImageOptions,
    sessionStatus: () => ({ ...session }),
    login: async () => { opens++; const result = setSession('unchecked'); return { message: result.message, session: result }; },
    checkLogin: async () => {
      checks++; setSession('checking');
      if (releaseCheck) await releaseCheck.promise;
      const result = setSession(nextState);
      return { message: result.message, session: result };
    },
    probe: async () => { throw Error('isolated login UI must never start monitoring'); },
  });
  app = createApplication({ updatesOptions: offlineUpdateOptions, runtimeDir: dir, startEngine: false,
    adapters: { autodl },
    aiOptions: { fetchImpl: async () => { throw Error('login UI must not call model services'); } } });
  // 模拟上次“同步 AutoDL 型号”保存在本机的合成目录。
  seedGpuCatalog(app.store);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw Error('未找到浏览器，请安装Playwright Chromium或用AI_TEST_BROWSER指定测试浏览器路径');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  await page.locator('[data-view=dashboard]').click();
  await page.locator('#task-form [name=gpuModel]').selectOption('RTX 4090');
  assert.equal(await page.locator('#browser-session-badge').textContent(), '未打开登录');
  assert.equal(await page.locator('#check-browser').isDisabled(), true);
  assert.equal(checks, 0); assert.equal(opens, 0);
  // 默认“自动创建并开机”：未勾选费用授权时表单校验先拦截，不发请求。之后按本测试原意使用“只通知”。
  assert.equal(await page.locator('#task-form [name=action]').inputValue(), 'execute');
  assert.equal(await page.locator('#task-form').evaluate(form => form.checkValidity()), false);
  await page.locator('[data-action-choice=observe]').click();

  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('请先登录 AutoDL'));
  assert.equal(app.store.tasks().length, 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open-browser');
  await page.locator('#open-browser').click();
  await page.waitForFunction(() => document.querySelector('#browser-session-badge').textContent === '登录待检查');
  assert.equal(opens, 1);
  assert.equal(session.browserOpen, true);
  assert.equal(await page.locator('#check-browser').isEnabled(), true);
  assert.equal(await page.locator('#connection').textContent(), '已连接');

  async function checkState(state, label) {
    // 登录控件已移到账号页；5 秒自动检查可同时存在，按目标状态而非累计次数判定。
    await page.locator('[data-view=profile]').click();
    nextState = state; await page.locator('#check-browser').click();
    await page.waitForFunction(expected => document.querySelector('#browser-session-badge').textContent === expected, label);
    assert.equal(await page.locator('#connection').textContent(), '已连接');
    assert.equal(await page.locator('#check-browser').isEnabled(), true);
  }
  await checkState('login_required', '未登录');
  assert.equal(await page.locator('#open-browser').textContent(), '重新登录');
  await checkState('human_required', '待人工验证');
  assert.equal(await page.locator('#open-browser').textContent(), '处理人工验证');
  await checkState('network_blocked', '网络访问受限');
  assert.match(await page.locator('#browser-status').textContent(), /退出旧服务/);
  assert.equal(await page.locator('#open-browser').textContent(), '重试打开登录');
  assert.match(await page.locator('#browser-session-badge').getAttribute('class'), /warning/);
  await checkState('unknown', '无法确认');
  await checkState('error', '检查未完成');
  assert.match(await page.locator('#browser-status').textContent(), /不等于登录已失效/);

  let release; releaseCheck = { promise: new Promise(resolve => { release = resolve; }) }; releaseCheck.resolve = release; nextState = 'ready';
  await page.locator('#check-browser').click();
  await page.waitForFunction(() => document.querySelector('#check-browser').textContent === '正在检查…');
  assert.equal(await page.locator('#open-browser').isDisabled(), true);
  assert.equal(await page.locator('#check-browser').isDisabled(), true);
  assert.equal((await page.request.get(base + '/api/health')).status(), 200);
  release(); releaseCheck = null;
  await page.waitForFunction(() => document.querySelector('#browser-session-badge').textContent === '会话可用');
  assert.match(await page.locator('#browser-checked-at').textContent(), /最近核验/);
  // 已连接时可重新打开账号登录；正常读取留在后台完成。
  assert.equal(await page.locator('#open-browser').textContent(), '重新连接账号');
  await page.locator('[data-view=dashboard]').click();
  await selectSyntheticImage(page);
  await page.locator('#task-form [name=name]').fill('合成测试：登录核验后建立的仅监测任务');
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '1');
  assert.equal(app.store.tasks()[0].state, 'queued'); assert.equal(app.store.tasks()[0].attempts, 0);
  await checkState('expired', '登录已失效');
  await page.locator('[data-view=dashboard]').click();
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('请先登录 AutoDL'));
  assert.equal(app.store.tasks().length, 1);
  await checkState('ready', '会话可用');

  // 真实 Chromium DOM 检测也只读取本地合成 HTML，不访问官方页面或登录账号。
  const documentPage = await context.newPage();
  const table = '<h1>容器实例</h1><div class="el-table"><table><thead><tr><th>实例名称</th><th>配置</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table><span class="el-table__empty-text">暂无数据</span></div>';
  async function snapshot(html) {
    await documentPage.setContent('<!doctype html><html lang="zh-CN"><body><p>仅供隔离合成测试，未连接真实账号</p>' + html + '</body></html>');
    const result = await readSessionSnapshot(documentPage);
    return { ...result, url: 'https://www.autodl.com/console/instance/list' };
  }
  assert.equal(classifySessionSnapshot(await snapshot(table)), 'ready');
  assert.equal(classifySessionSnapshot(await snapshot(table + '<div style="display:none"><input type="password"><button>登录</button></div>')), 'ready');
  const sms = await snapshot('<h1>验证码登录</h1><input type="tel" placeholder="手机号"><input placeholder="验证码"><button>登录</button>');
  assert.equal(sms.humanRequired, false); assert.equal(classifySessionSnapshot(sms), 'login_required');
  assert.equal(classifySessionSnapshot(await snapshot(table + '<div role="dialog"><h2>安全验证</h2><p>请完成安全验证</p></div>')), 'human_required');
  assert.equal(classifySessionSnapshot(await snapshot(table + '<div class="el-loading-mask" style="position:fixed;inset:0">加载中</div>')), 'unknown');
  assert.equal(classifySessionSnapshot(await snapshot('<h1>容器实例</h1>')), 'unknown');
  // 真实DOM中的人工验证和已填合成输入必须跨多次检查保留。
  await snapshot('<h1>登录</h1><input type="password"><input placeholder="验证码"><button>登录</button><div role="dialog" id="synthetic-challenge"><p>请完成安全验证</p></div>');
  await documentPage.locator('input[type=password]').fill('synthetic-local-password');
  await documentPage.locator('input[placeholder=验证码]').fill('123456');
  const manualAdapter = new AutoDLBrowserAdapter(path.join(dir, 'unused-manual-profile'));
  manualAdapter.page = {
    isClosed: () => documentPage.isClosed(), url: () => 'https://www.autodl.com/login',
    evaluate: fn => documentPage.evaluate(fn), bringToFront: () => documentPage.bringToFront(),
    goto: async () => { throw Error('manual page must not reload'); },
  };
  manualAdapter.context = { newPage: async () => { throw Error('manual verification must not open another login page'); } };
  for (let i = 0; i < 3; i++) {
    const result = await manualAdapter.checkLogin();
    assert.equal(result.session.state, 'human_required');
    assert.equal(JSON.stringify(result).includes('synthetic-local-password'), false);
    assert.equal(await documentPage.locator('#synthetic-challenge').count(), 1);
    assert.equal(await documentPage.locator('input[type=password]').inputValue(), 'synthetic-local-password');
    assert.equal(await documentPage.locator('input[placeholder=验证码]').inputValue(), '123456');
  }
  await documentPage.locator('#synthetic-challenge').evaluate(node => node.remove());
  assert.equal((await manualAdapter.checkLogin()).session.state, 'login_required');
  assert.equal(await documentPage.locator('input[type=password]').inputValue(), 'synthetic-local-password');
  await documentPage.close();

  for (const width of [1440, 1280, 1024, 768, 760, 600, 520, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['dashboard','notifications','ai','settings']) {
      await page.locator(`[data-view=${view}]`).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `horizontal overflow: ${width}px ${view}`);
    }
  }
  await page.locator('[data-view=profile]').click();
  // 截图等待提示自然消失，不改变正常交互时的提示时长。
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.locator('#autodl-connection').screenshot({ path: path.join(output, 'autodl-login.png') });
  await page.locator('[data-view=dashboard]').click();
  await page.screenshot({ path: path.join(output, 'dashboard-light.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view=profile]').click();
  await page.locator('#autodl-connection').screenshot({ path: path.join(output, 'autodl-login-mobile.png') });
  await page.locator('[data-view=dashboard]').click();
  await page.screenshot({ path: path.join(output, 'dashboard-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log('登录页面回归通过：未打开/待检查/未登录/人工验证/无法确认/网络错误/可用/失效、重复点击防护、真实任务前置检查、空实例列表与隐藏登录DOM、人工验证与合成输入保留、36组响应式布局。所有会话及任务为合成数据，无AutoDL、模型或外部通知请求。');
} finally {
  releaseCheck?.resolve?.();
  await browser?.close(); await app?.close();
  const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('autodl-login-ui-isolated-')) throw Error('invalid isolated cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}

