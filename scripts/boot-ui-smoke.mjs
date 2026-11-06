import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

// 页面验收使用隔离合成账号，只有本机请求可以发出；引擎关闭，不租用或开机真实资源。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-boot-ui-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const errors = [], blocked = [], posts = [];
let app, browser, forbiddenCalls = 0;
const forbidden = async () => { forbiddenCalls++; throw Error('开机页面验收禁止外部操作'); };
try {
  const rows = [
    { id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
      stopped: true, running: false, cardless: false, starting: false, gpuAvailable: false },
    { id: 'synthetic-cardless', region: '西北B区', gpuModel: 'RTX 3090', gpuCount: 1,
      stopped: false, running: false, cardless: true, starting: false, gpuAvailable: null },
  ];
  const autodl = Object.assign(new SyntheticAdapter(), {
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '合成会话，仅本地测试', checkedAt: Date.now() }),
    instances: async () => rows,
    login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden,
    inspectBoot: forbidden, boot: forbidden,
  });
  app = createApplication({ updatesOptions: offlineUpdateOptions, runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-boot-ui-build', adapters: { autodl },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const executablePath = process.env.AI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { blocked.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/tasks' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  // 开机任务仍在抢卡控制台配置，来源可直接由该模式的同步按钮读取。
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-mode=boot]').click();
  await page.locator('#refresh-sources').click();
  const form = page.locator('#task-form'), field = name => form.locator(`[name=${name}]`);
  await field('sourceId').locator('option[value="synthetic-source"]').waitFor({ state: 'attached' });
  await field('sourceId').selectOption('synthetic-source');
  assert.equal(await field('sourceId').locator('option[value="synthetic-cardless"]').evaluate(option => option.disabled), true);
  assert.equal(await page.locator('#create-fields').isVisible(), false);
  assert.equal(await page.locator('#pricing-fields').isVisible(), false);
  assert.equal(await page.locator('#balance-fields').isVisible(), false);
  assert.equal(await field('pollSeconds').inputValue(), '10');
  assert.equal(await field('imagePath').inputValue(), '');
  await field('name').fill('原实例开机 · 界面验收（合成数据）');
  await page.locator('[data-action-choice=execute]').click();
  assert.equal(await field('action').inputValue(), 'execute');
  await field('paidConsent').check();
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'boot-desktop.png'), fullPage: true });
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '1');
  const task = app.store.tasks()[0];
  assert.equal(task.config.mode, 'boot');
  assert.equal(task.config.sourceId, 'synthetic-source');
  assert.equal(task.config.gpuModel, 'RTX 4090');
  assert.equal(task.config.gpuCount, 1);
  assert.equal(task.config.balanceGuard, false);
  assert.deepEqual(task.config.imagePath, []);
  assert.equal(task.state, 'queued');
  assert.equal(posts.length, 1);
  assert.match(await page.locator('#tasks').innerText(), /原实例开机/);
  // 已提交后停止仍可从页面继续核对原实例，不能解除回执后重新开机。
  const operation = { id: 'synthetic-operation', stage: 'accepted', at: Date.now(),
    receipt: { instanceId: task.config.sourceId, acceptedAt: Date.now() } };
  app.store.patch(task, { state: 'cancelled', operation });
  await page.evaluate(() => refresh());
  await page.getByRole('button', { name: '继续核对原实例', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#tasks').textContent.includes('确认有卡运行'));
  assert.equal(task.state, 'verifying');
  assert.equal(task.operation, operation);
  // 手机视口下仍能选择实例、读日志；宽屏截图用于交付页面预览。
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `页面横向溢出：${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'boot-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-mode=create]').click();
  assert.equal(await page.locator('#create-fields').isVisible(), true);
  assert.equal(await field('gpuModel').isDisabled(), false);
  await page.locator('[data-mode=clone]').click();
  assert.equal(await page.locator('#clone-options').isVisible(), true);
  await page.locator('[data-mode=boot]').click();
  assert.equal(await page.locator('#clone-options').isVisible(), false);

  // 用真实 Chromium DOM 验证官方开机确认框定位，仍只操作离线合成页面。
  const platformPage = await context.newPage();
  let marked = false, confirmed = false;
  await platformPage.exposeFunction('recordConfirmation', () => {
    assert.equal(marked, true, '应先记录提交，再点击确定'); confirmed = true;
  });
  await platformPage.setContent(`<!doctype html><html lang="zh-CN"><body>
    <div class="el-table instance-table"><div class="el-table__header-wrapper"><table><thead><tr><th>实例ID/名称</th><th>地区</th><th>配置</th><th>状态</th><th>操作</th></tr></thead></table></div>
    <div class="el-table__body-wrapper"><table><tbody><tr><td><div style="cursor:pointer">synthetic001-abcdef01</div><div><span>备注：target0001-abcdef01</span></div></td><td>北京B区</td><td>RTX 4090 * 1卡</td>
    <td id="platform-status">已关机</td><td><button id="power-on">开机</button><button>无卡模式开机</button></td></tr></tbody></table></div></div>
    <div class="el-message-box" style="display:none"><div class="el-message-box__message">确认开机吗？</div>
      <button id="confirm-on">确定</button><button>取消</button></div>
    <script>
      document.querySelector('#power-on').onclick = () => { document.querySelector('.el-message-box').style.display = 'block'; };
      document.querySelector('#confirm-on').onclick = async () => {
        await window.recordConfirmation();
        document.querySelector('.el-message-box').style.display = 'none';
        document.querySelector('#platform-status').textContent = '开机中';
      };
    </script></body></html>`);
  const platform = new AutoDLBrowserAdapter(dir);
  platform.page = platformPage;
  // 保留真实的行解析、按钮定位、弹框确认和结果读取，仅把导航限定在离线页面。
  platform.goto = async () => {};
  // 备注里的另一实例 ID 不能替代当前行主键，即使型号、地区完全相同。
  await assert.rejects(platform.findInstanceRow('target0001-abcdef01', 'RTX 4090'));
  assert.equal(marked, false);
  const result = await platform.boot({ config: { mode: 'boot', sourceId: 'synthetic001-abcdef01',
    regions: ['北京B区'], gpuModel: 'RTX 4090', gpuCount: 1 } }, () => { marked = true; });
  assert.deepEqual(result, {});
  assert.equal(confirmed, true);
  assert.equal(await platformPage.locator('#platform-status').textContent(), '开机中');
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log('原实例开机页面验收通过：同步并选择原实例、无卡实例不可选、不填镜像与报价即可建立任务、新建/克隆/开机切换、320px 与 390px 布局、离线官方确认框 DOM 定位与先记录后确定；没有真实平台操作。');
} finally {
  await browser?.close();
  await app?.close();
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('autodl-boot-ui-'));
  fs.rmSync(target, { recursive: true, force: true });
}
