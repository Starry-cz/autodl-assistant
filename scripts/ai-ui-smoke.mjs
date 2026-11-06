import { syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 回归截图仅保留在被 Git 忽略的本机输出目录，不写入发布文档。
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-ai-ui-isolated-'));
const secret = 'sk-ui-synthetic-not-real-123456789';
let calls = 0, behavior = 'success', app, browser;
const errors = [];
try {
  app = createApplication({ runtimeDir: dir, startEngine: false,
    adapters: { autodl: Object.assign(new SyntheticAdapter(), {
    imageOptions: syntheticImageOptions,
      sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '会话可用', message: '仅内存合成会话', checkedAt: 1 }),
      instances: async () => [{ id: 'syntheticai-source', gpuModel: 'RTX 4090', gpuCount: 1, region: '北京B区', stopped: true, running: false }],
    }) },
    aiOptions: { fetchImpl: async (_url, options) => {
      calls++;
      if (behavior === 'pending') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
      if (behavior === 'failure') return new Response('synthetic auth failure ' + secret, { status: 401 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '合成测试结果：请核对环境，尚未运行任何GPU测试。',
        findings: [{ message: '<img src=x onerror=alert(1)>', evidence: 'torch==2.1.0' }, { message: '未证实的假设', evidence: '输入中没有这句话' }],
        recommendations: [{ action: '核对依赖版本', reason: '资料尚不完整', verification: '在目标实例上运行最小测试' }],
        questions: ['请补充Python要求'], warnings: ['AI建议不代表数据已完整复制'],
      }) } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    } } });
  // 模拟上次“同步 AutoDL 型号”保存在本机的合成目录。
  seedGpuCatalog(app.store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw Error('未找到浏览器，请安装Playwright Chromium或用AI_TEST_BROWSER指定测试用浏览器路径');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  // 默认进入监控室；任务表单现在由抢卡控制台导航进入。
  await page.locator('[data-view=dashboard]').click();
  await selectSyntheticImage(page);
  await page.locator('#task-form [name=gpuModel]').selectOption('RTX 4090');
  await page.locator('[data-action-choice=observe]').click();
  await page.locator('#task-form input[name=name]').fill('无Key仍可建立的任务'); await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '1');
  assert.equal(calls, 0);
  await page.locator('[data-view=ai]').click(); assert.equal(await page.locator('#ai-analyze').isDisabled(), true);
  const settings = page.locator('#ai-settings-form');
  await settings.locator('[name=enabled]').check(); await settings.locator('[name=apiKey]').fill(secret);
  await settings.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('已配置'));
  assert.equal(await settings.locator('[name=apiKey]').inputValue(), ''); assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(secret), false);
  const analysis = page.locator('#ai-analysis-form');
  await analysis.locator('[name=request]').fill('只用4090，请核对依赖，预算不变');
  await analysis.locator('[name=projectText]').fill('torch==2.1.0'); await analysis.locator('[name=consent]').check();
  await page.locator('#ai-analyze').click(); await page.locator('#ai-results').waitFor({ state: 'visible' });
  assert.equal(calls, 1); assert.equal(app.store.tasks().length, 1);
  assert.equal(await page.locator('#ai-results img').count(), 0); assert.match(await page.locator('#ai-results').innerText(), /<img src=x/);
  assert.match(await page.locator('#ai-results').innerText(), /输入原文匹配/); assert.match(await page.locator('#ai-results').innerText(), /未验证依据/);
  await page.screenshot({ path: path.join(output, 'ai-assistant.png'), fullPage: true });
  behavior = 'failure'; await analysis.locator('[name=consent]').check(); await page.locator('#ai-analyze').click();
  await page.waitForFunction(() => document.querySelector('#ai-analysis-status').textContent.includes('鉴权失败'));
  assert.equal(await page.locator('body').innerText().then(value => value.includes(secret)), false);
  await page.locator('[data-view=fleet]').click();
  await page.locator('#fleet-sources > summary').click();
  await page.locator('#sync-instances').click();
  await page.waitForFunction(() => document.querySelectorAll('#account-instances .instance-row').length === 1);
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-mode=clone]').click();
  await page.locator('#task-form [name=sourceId]').selectOption('syntheticai-source');
  await page.locator('#task-form input[name=name]').fill('AI失败后仍可建立的克隆任务'); await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '2');
  await page.locator('[data-view=ai]').click(); behavior = 'pending'; await analysis.locator('[name=consent]').check(); await page.locator('#ai-analyze').click();
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent === '分析中');
  await page.locator('#ai-cancel').click(); await page.waitForFunction(() => document.querySelector('#ai-analysis-status').textContent.includes('取消'));
  await page.waitForFunction(() => !document.querySelector('#ai-analyze').disabled);
  await settings.locator('[name=provider]').selectOption('custom'); await settings.locator('[name=baseUrl]').fill('https://models.example.test/v1');
  await settings.locator('[name=model]').fill('synthetic-model'); await settings.locator('[name=apiKey]').fill(secret); await settings.locator('[name=rememberKey]').check();
  await settings.locator('button[type=submit]').click(); await page.waitForFunction(() => document.querySelector('#ai-key-status').textContent.includes('已记住'));
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(secret), false);
  await page.locator('#ai-clear-key').click(); await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('未启用'));
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(secret), false); assert.equal(calls, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log('AI页面回归通过：无Key核心任务、配置、建议、转义、失败隔离、取消、切换接口、记住/清除Key及窄屏布局。所有模型请求为内存替身，无外部调用。');
} finally {
  await browser?.close(); await app?.close();
  const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('autodl-ai-ui-isolated-')) throw Error('invalid isolated cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}

