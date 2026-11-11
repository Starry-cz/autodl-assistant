// 环境与选卡规划页面回归：临时状态目录、合成会话与型号目录、合成镜像菜单、内存替身模型。不连接 AutoDL 或任何模型服务。
import { syntheticImageOptions } from '../tests/fixtures/images.mjs';
import { seedGpuCatalog, SYNTHETIC_GPU_CATALOG } from '../tests/fixtures/gpu-catalog.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-plan-ui-isolated-'));
const PROJECT = 'pip install torch==2.1.0+cu121\nVicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.';
const reply = { items: [{ field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB of GPU memory.' }, { field: 'cuda', value: '==11.8', evidence: '需要 CUDA 11.8' }], summary: '按 13B 推理' };
const KEY = 'sk-plan-ui-synthetic-not-real-123456';
let calls = 0, app, browser;
const errors = [];
try {
  app = createApplication({ updatesOptions: offlineUpdateOptions, runtimeDir: dir, startEngine: false,
    adapters: { autodl: Object.assign(new SyntheticAdapter(), { imageOptions: syntheticImageOptions,
      sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '会话可用', message: '仅内存合成会话', checkedAt: 1 }) }) },
    aiOptions: { fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer ' + KEY);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 600, completion_tokens: 60, total_tokens: 660 } })); } } });
  seedGpuCatalog(app.store, { ...structuredClone(SYNTHETIC_GPU_CATALOG), checkedAt: Date.now() - 20 * 60000 });
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
  await page.locator('[data-view=ai]').click();
  // 结果容器显示不代表渲染成功；等本次请求和提交收尾，再核验页面完成状态，捕获被界面处理的渲染错误。
  const submitPlan = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === base + '/api/plan' && response.request().method() === 'POST'),
      page.locator('#plan-submit').click(),
    ]);
    assert.equal(response.ok(), true);
    await page.waitForFunction(() => !document.querySelector('#plan-submit').disabled);
    assert.match(await page.locator('#plan-status').textContent(), /分析完成/);
  };
  // 1) 只用规则：不调用模型
  assert.equal(await page.locator('#plan-form [name=useModel]').isDisabled(), true);
  await page.locator('#plan-form [name=projectText]').fill(PROJECT);
  await submitPlan(); await page.locator('#plan-results').waitFor({ state: 'visible' });
  const text = await page.locator('#plan-results').textContent();
  assert.match(text, /读出的条件/); assert.match(text, /==2\.1\.0/); assert.match(text, /待确认/); assert.match(text, /RTX 4090/);
  assert.match(text, /最大的 28GB/); assert.match(text, /不满足条件的型号/); assert.equal(calls, 0);
  // 2) 填入新建任务：型号、地区与官方镜像（逐级读取合成菜单）
  await page.locator('[data-plan-pick="L20"]').click();
  await page.waitForFunction(() => document.querySelector('#task-form [name=imagePath]').value.includes('12.1'));
  assert.equal(await page.locator('#task-form [name=gpuModel]').inputValue(), 'L20');
  assert.equal(await page.locator('#task-form [name=imagePath]').inputValue(), 'PyTorch / 2.1.0 / 3.10(ubuntu22.04) / 12.1');
  assert.equal(await page.locator('#task-form [name=cuda]').inputValue(), '12.1');
  assert.equal(await page.locator('#dashboard').isHidden(), false); assert.equal(app.store.tasks().length, 0);
  // 3) 填写自己的 API Key 启用模型后，由模型按需求补充显存；引用不在原文中的条目被丢弃
  await page.locator('[data-view=ai]').click();
  const settings = page.locator('#ai-settings-form');
  assert.deepEqual(await settings.locator('[name=provider] option').evaluateAll(o => o.map(x => x.value)), ['deepseek', 'dashscope', 'custom']);
  await settings.locator('[name=provider]').selectOption('deepseek');
  await settings.locator('[name=apiKey]').fill(KEY);
  await settings.locator('[name=enabled]').check(); await settings.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#plan-form [name=useModel]').disabled);
  await page.locator('#plan-form [name=request]').fill('推理 Vicuna-13B');
  await page.locator('#plan-form [name=useModel]').check(); await page.locator('#plan-form [name=consent]').check();
  await submitPlan();
  const modelText = await page.locator('#plan-results').textContent();
  assert.match(modelText, /模型补充 1 条/); assert.match(modelText, /≥ 28GB/); assert.match(modelText, /引用不是输入资料中的原文/); assert.equal(calls, 1);
  assert.match(modelText, /不满足条件的型号（3）/); assert.match(modelText, /单卡显存 24GB，低于所需 28GB/);
  assert.equal(await page.locator('[data-plan-pick="RTX 4090"]').count(), 0);
  // 可选：PLAN_UI_SHOT=<目录> 时保存规划结果截图（合成数据），供文档使用
  if (process.env.PLAN_UI_SHOT) {
    fs.mkdirSync(process.env.PLAN_UI_SHOT, { recursive: true });
    await page.evaluate(() => document.querySelector('#toast').classList.add('hidden'));
    await page.locator('#plan-results').screenshot({ path: path.join(process.env.PLAN_UI_SHOT, 'plan-results.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.deepEqual(errors, []);
  assert.equal((await page.content()).includes(KEY), false); assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(KEY), false);
  console.log('规划页面回归通过：规则规划不调用模型、填入型号地区与官方镜像、用自己的 API Key 补充与引用核对、Key 不回显不落盘、窄屏布局。模型为内存替身，无外部调用。');
} finally {
  await browser?.close(); await app?.close();
  const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('autodl-plan-ui-isolated-')) throw Error('invalid isolated cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}

