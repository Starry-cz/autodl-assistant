import { syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { SYNTHETIC_GPU_CATALOG, syntheticGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { CHECKBOX_SCENARIOS, runCheckboxScenario, checkScenarioExpectation } from '../tests/fixtures/checkbox-pages.mjs';

// 本脚本只使用临时状态、停止的引擎和本地合成页面；不登录、不监测、不租卡。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-models-ui-isolated-'));
const errors = [], blocked = [], posts = [], fixtures = new Map();
const customModel = 'ExampleGPU [Mk2] (48GB)';
const longModel = 'ExampleGPU [Long Variant] 96GB PCIe ' + 'Revision-X'.repeat(4);
const sources = [
  { id: 'syntheticl20-source', gpuModel: 'L20' },
  { id: 'syntheticcustom-source', gpuModel: customModel },
  { id: 'syntheticlong-source', gpuModel: longModel },
].map(row => ({ ...row, gpuCount: 2, region: '北京B区', stopped: true, running: false }));
let app, browser, forbiddenCalls = 0, readySince = null, catalogSyncs = 0;
const forbidden = async () => { forbiddenCalls++; throw Error('型号 UI 测试不得调用登录、监测、提交或模型服务'); };
try {
  const autodl = Object.assign(new SyntheticAdapter(), {
    imageOptions: syntheticImageOptions,
    login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden,
    submit: forbidden, reconcile: forbidden,
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '会话可用', message: '仅内存合成会话', checkedAt: 1, ...(readySince ? { readySince } : {}) }),
    instances: async () => sources,
  });
  app = createApplication({ updatesOptions: offlineUpdateOptions, runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-models-ui-build',
    adapters: { autodl }, aiOptions: { fetchImpl: forbidden } });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw Error('未找到浏览器，请安装 Playwright Chromium 或用 AI_TEST_BROWSER 指定测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { blocked.push(url.href); return route.abort(); }
    if (fixtures.has(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtures.get(url.pathname) });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/tasks' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  await page.locator('[data-view=dashboard]').click();
  const form = page.locator('#task-form'), model = form.locator('[name=gpuModel]'), custom = form.locator('[name=customGpuModel]');
  assert.equal(await form.locator('[name=provider]').count(), 0);
  // 默认发现空卡后自动创建并开机，此时必须勾选费用授权；本脚本之后改为“只通知”，不需要余额 Token。
  const action = form.locator('[name=action]');
  assert.equal(await action.inputValue(), 'execute');
  assert.equal(await form.locator('[name=paidConsent]').evaluate(input => input.required && !input.checked), true);
  assert.equal(await page.locator('#consent-label').isVisible(), true);
  await page.locator('[data-action-choice=observe]').click();
  assert.equal(await form.locator('[name=paidConsent]').evaluate(input => input.required), false);
  const poll = form.locator('[name=pollSeconds]');
  assert.deepEqual(await poll.evaluate(input => ({ min: input.min, max: input.max, step: input.step, value: input.value })), { min: '10', max: '600', step: '1', value: '10' });
  for (const value of ['-1', '0', '0.5', '1', '9', '601', '20.5']) { await poll.fill(value); assert.equal(await poll.evaluate(input => input.validity.valid), false); }
  for (const value of ['10', '14', '600']) { await poll.fill(value); assert.equal(await poll.evaluate(input => input.validity.valid), true); }
  await poll.fill('10');
  // 扫描范围：新表单默认首页优先＋20秒完整翻页；切到每轮完整翻页时不提交间隔。
  await page.locator('#scan-options > summary').click();
  const scope = form.locator('[name=scanScope]'), fullScan = form.locator('[name=fullScanSeconds]');
  assert.equal(await scope.inputValue(), 'first-page'); assert.equal(await fullScan.inputValue(), '20'); assert.equal(await fullScan.isDisabled(), false);
  await scope.selectOption('full'); assert.equal(await fullScan.isDisabled(), true);
  await scope.selectOption('first-page'); assert.equal(await fullScan.isDisabled(), false);
  for (const value of ['9', '3601', '30.5']) { await fullScan.fill(value); assert.equal(await fullScan.evaluate(input => input.validity.valid), false); }
  await fullScan.fill('20');
  assert.equal(await model.inputValue(), '');
  assert.equal(await model.evaluate(input => input.validity.valueMissing), true);
  assert.equal(await custom.isDisabled(), true);
  assert.equal(await page.locator('#metric-gpu-model').textContent(), '尚未选择');
  // 同步前没有内置预设，只有提示项和“其他型号”。
  const optionValues = () => model.locator('option').evaluateAll(options => options.map(option => option.value).filter(value => value && value !== '__custom__'));
  const optionText = value => model.locator('option').evaluateAll((options, value) => options.find(option => option.value === value)?.textContent, value);
  const waitOptionText = (value, text) => page.waitForFunction(([value, text]) =>
    [...document.querySelector('#task-form [name=gpuModel]').options].find(option => option.value === value)?.textContent === text, [value, text]);
  assert.deepEqual(await optionValues(), []);
  assert.equal(await model.locator('option').first().textContent(), '请先点“同步 AutoDL 型号”');
  await page.locator('#submit-task').click();
  assert.equal(posts.length, 0); assert.equal(app.store.tasks().length, 0);

  // 同步后只列出所选地区（默认北京B区）的型号，括号内为同步时的空闲/总数；加选地区后列出合集并分地区标注。
  await page.locator('#sync-gpus').click();
  await waitOptionText('RTX 4090', 'RTX 4090（2/8）');
  assert.match(await page.locator('#gpu-model-hint').textContent(), /^同步于/);
  const beijing = SYNTHETIC_GPU_CATALOG.regions[0].models.map(row => row.model);
  assert.deepEqual(await optionValues(), beijing);
  assert.ok(app.store.data.gpuCatalog?.regions.length === 6);
  await form.locator('[name=region][value="西北B区"]').check();
  assert.deepEqual(await optionValues(), [...beijing, 'RTX 3090']);
  assert.equal(await optionText('RTX 4090'), 'RTX 4090（北京B区 2/8，西北B区 0/16）');
  // 多地区合集已在上方核验；常态提示仅需明确库存是同步快照，不绑定冗长教程文案。
  assert.match(await page.locator('#gpu-model-hint').textContent(), /同步于.*空闲 \/ 总数快照/);
  await form.locator('[name=region][value="西北B区"]').uncheck();
  assert.deepEqual(await optionValues(), beijing);

  // 新建可选型号；克隆必须使用同步源实例的精确型号、数量和地区。
  await selectSyntheticImage(page);
  await model.selectOption('A100'); await form.locator('[name=gpuCount]').selectOption('2');
  assert.equal(await page.locator('#metric-gpu-model').textContent(), 'A100');
  assert.match(await page.locator('#metric-gpu-detail').textContent(), /2 张.*新建实例/);
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '1');
  assert.equal(app.store.tasks()[0].config.gpuModel, 'A100');
  assert.equal(app.store.tasks()[0].config.gpuCount, 2);
  assert.equal(app.store.tasks()[0].config.pollSeconds, 10);
  assert.equal(app.store.tasks()[0].config.scanScope, 'first-page');
  assert.equal(app.store.tasks()[0].config.fullScanSeconds, 20);
  assert.equal(app.store.tasks()[0].config.action, 'observe');

  // 重新同步后型号从所选地区消失时，保留用户原来的型号并标明，不悄悄改成另一张卡。
  autodl.gpuCatalog = async regions => {
    const catalog = await syntheticGpuCatalog(regions);
    return { ...catalog, regions: catalog.regions.map(row => ({ ...row, models: row.models.filter(item => item.model !== 'A100') })) };
  };
  await page.locator('#sync-gpus').click();
  await waitOptionText('A100', 'A100（所选地区当前未列出）');
  assert.equal(await model.inputValue(), 'A100');
  assert.match(await page.locator('#gpu-model-hint').textContent(), /所选型号未列出.*核对地区.*重新同步/);
  assert.equal(await page.locator('#metric-gpu-model').textContent(), 'A100');
  autodl.gpuCatalog = syntheticGpuCatalog;
  await page.locator('#sync-gpus').click();
  await waitOptionText('A100', 'A100（2/8）');
  assert.equal(await model.inputValue(), 'A100');
  await page.locator('[data-view=fleet]').click();
  await page.locator('#fleet-sources > summary').click();
  await page.locator('#sync-instances').click();
  await page.waitForFunction(() => document.querySelectorAll('#account-instances .instance-row').length === 3);
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-mode=clone]').click();
  await form.locator('[name=sourceId]').selectOption('syntheticl20-source');
  assert.equal(await poll.inputValue(), '10');
  assert.equal(await model.inputValue(), 'L20');
  assert.equal(await model.isDisabled(), false); assert.equal(await form.locator('[name=gpuCount]').inputValue(), '2');
  assert.match(await page.locator('#gpu-model-title').textContent(), /目标 GPU 型号（可更换）/);
  assert.match(await page.locator('#metric-gpu-detail').textContent(), /同源型号克隆/);
  // 克隆到其他型号：L20 源实例 → RTX 4090 × 2；地区仍为源实例所在地区。
  await model.selectOption('RTX 4090');
  assert.match(await page.locator('#metric-gpu-detail').textContent(), /克隆到其他型号/);
  assert.match(await page.locator('#source-summary').textContent(), /已改为 RTX 4090 × 2/);
  assert.equal(await form.locator('[name=region]').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '2');
  const moved = app.store.tasks().find(task => task.config.mode === 'clone' && task.config.sourceId === 'syntheticl20-source');
  assert.equal(moved.config.gpuModel, 'RTX 4090'); assert.equal(moved.config.gpuCount, 2); assert.equal(moved.config.cuda, ''); assert.deepEqual(moved.config.regions, ['北京B区']);

  // 自定义名称的空值不能提交；显存、版本等后缀不得被截掉。
  await page.locator('[data-mode=create]').click();
  await model.selectOption('__custom__'); await custom.fill('');
  assert.equal(await custom.isVisible(), true); assert.equal(await custom.isEnabled(), true);
  assert.equal(await custom.evaluate(input => input.required && input.validity.valueMissing), true);
  await page.locator('#submit-task').click(); assert.equal(posts.length, 2);
  await custom.fill('   '); await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('请选择 GPU 精确型号'));
  assert.equal(posts.length, 2);
  await page.locator('[data-mode=create]').click(); await custom.fill('  A100 80GB  ');
  assert.equal(await page.locator('#metric-gpu-model').textContent(), 'A100 80GB');
  await page.evaluate(() => new Promise(resolve => window.addEventListener('appstatechange', resolve, { once: true })));
  assert.equal(await model.inputValue(), '__custom__'); assert.equal(await custom.inputValue(), '  A100 80GB  ');
  assert.equal(await custom.inputValue(), '  A100 80GB  ');
  await page.locator('[data-mode=clone]').click(); await page.locator('[data-mode=create]').click();
  assert.equal(await custom.inputValue(), '  A100 80GB  ');
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '3');
  assert.equal(app.store.tasks().find(task => task.config.gpuModel === 'A100 80GB').config.mode, 'create');
  await page.locator('[data-mode=clone]').click();
  await form.locator('[name=sourceId]').selectOption('syntheticcustom-source');
  // 源实例型号不在同步列表中时原样锁定在型号选项里，不改用“其他型号”或别的卡。
  assert.equal(await model.inputValue(), customModel); assert.equal(await optionText(customModel), customModel + '（源实例型号）');
  assert.equal(await model.isDisabled(), false); assert.equal(await custom.isDisabled(), true);
  // 克隆的提示只说明源型号不在该地区列表中，不建议改选“其他型号”。
  assert.match(await page.locator('#gpu-model-hint').textContent(), /源实例型号未列出.*重新同步核对/);
  assert.doesNotMatch(await page.locator('#gpu-model-hint').textContent(), /其他型号/);
  await page.locator('#submit-task').click();
  await page.waitForFunction(() => document.querySelector('#task-count').textContent === '4');
  assert.equal(app.store.tasks().find(task => task.config.gpuModel === customModel).config.mode, 'clone');
  assert.equal(app.store.tasks().find(task => task.config.gpuModel === customModel).config.gpuModel, customModel);
  assert.deepEqual(posts.map(post => post.gpuModel), ['A100', 'RTX 4090', 'A100 80GB', customModel]);
  assert.equal(posts.every(post => !Object.hasOwn(post, 'customGpuModel') && post.gpuModel !== '__custom__'), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.tasks.map(task => task.config.gpuModel), posts.map(post => post.gpuModel).reverse());
  assert.equal(posts.every(post => post.pollSeconds === '10'), true);
  assert.equal(saved.tasks.every(task => task.config.pollSeconds === 10), true);
  assert.equal(posts.every(post => post.scanScope === 'first-page' && post.fullScanSeconds === '20' && post.action === 'observe'), true);
  assert.equal(saved.tasks.every(task => task.config.scanScope === 'first-page' && task.config.fullScanSeconds === 20), true);
  assert.equal(app.store.tasks().every(task => task.state === 'queued' && !task.operation), true);

  // 长名称和窄屏仍可阅读，不引起整页横向滚动；两种模式均检查。
  await page.locator('[data-mode=create]').click(); await custom.fill(longModel);
  for (const mode of ['create', 'clone']) {
    await page.locator('[data-mode=' + mode + ']').click();
    if (mode === 'clone') await form.locator('[name=sourceId]').selectOption('syntheticlong-source');
    for (const width of [1920, 1440, 1280, 1024, 768, 520, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 1080 });
      const layout = await page.evaluate(() => {
        const metric = document.querySelector('#metric-gpu-model'), rect = metric.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          metricOverflow: metric.scrollWidth > metric.clientWidth + 1, right: rect.right, width: window.innerWidth };
      });
      assert.equal(layout.overflow, false, mode + ' page overflow at ' + width);
      assert.equal(layout.metricOverflow, false, mode + ' metric overflow at ' + width);
      assert.equal(layout.right <= layout.width + 1, true, mode + ' metric outside viewport at ' + width);
    }
  }
  await form.locator('[name=sourceId]').selectOption('syntheticcustom-source');
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 });
  await page.setViewportSize({ width: 1440, height: 1080 }); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'gpu-models.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'gpu-models-mobile.png'), fullPage: true });

  // 无账号身份的旧流程替身不能只凭 readySince 触发账号自动同步；手动同步仍可使用且不会反复读取。
  // 已确认身份后的 overview→billing→gpus 自动顺序由 workspace-ui-smoke 完整验收。
  const syncCatalog = autodl.gpuCatalog; autodl.gpuCatalog = async regions => { catalogSyncs++; return syncCatalog(regions); };
  await page.waitForTimeout(2300); assert.equal(catalogSyncs, 0);
  readySince = Date.now();
  await page.evaluate(() => refresh());
  await page.waitForTimeout(2300); assert.equal(catalogSyncs, 0);
  await page.locator('#sync-gpus').click();
  await page.waitForFunction(() => !document.querySelector('#sync-gpus').disabled);
  assert.equal(catalogSyncs, 1);
  await page.waitForFunction(() => !document.querySelector('#sync-gpus').disabled && /^同步于 .*快照/.test(document.querySelector('#gpu-model-hint').textContent));
  await page.waitForTimeout(4600); assert.equal(catalogSyncs, 1);
  assert.match(await page.locator('#gpu-model-hint').textContent(), /空闲 \/ 总数快照/);
  // 真实浏览器中的本地 DOM 夹具：不用真实 AutoDL 页面或会话。
  fixtures.set('/synthetic-host-dom', '<!doctype html><meta charset="utf-8"><body>' +
    '<label class="el-checkbox"><input type="checkbox" checked>全部</label>' +
    '<label class="el-checkbox"><input type="checkbox" checked>RTX 4090(2/8)</label>' +
    '<label class="el-checkbox"><input type="checkbox">RTX 4090D(1/8)</label>' +
    '<label class="el-checkbox"><input type="checkbox">RTX 4090(48GB)(1/8)</label>' +
    '<label class="el-checkbox"><input type="checkbox">A100 80GB(2/8)</label>' +
    '<label class="el-checkbox"><input type="checkbox">' + customModel + '(1/8)</label>' +
    '<table><tbody>' + ['A100 80GB', customModel].map((name, i) =>
      '<tr><td><input type="radio" value="synthetic-host-' + i + '"></td><td>H0' + i + '机</td><td>' + name +
      '<br>2 / 8</td><td>CPU：Synthetic Processor</td><td>驱动：535.0<br>CUDA：12.2</td><td>可扩容：500GB</td><td>¥2.50/时</td></tr>').join('') +
    '</tbody></table>');
  const domPage = await context.newPage(); domPage.on('pageerror', error => errors.push(error.message));
  await domPage.goto(base + '/synthetic-host-dom');
  const adapter = new AutoDLBrowserAdapter(dir); adapter.page = domPage; adapter.settle = async () => {};
  await adapter.selectModel('A100 80GB');
  assert.deepEqual(await domPage.locator('label.el-checkbox input').evaluateAll(inputs => inputs.map(input => input.checked)), [false, false, false, false, true, false]);
  await adapter.selectModel(customModel);
  assert.deepEqual(await domPage.locator('label.el-checkbox input').evaluateAll(inputs => inputs.map(input => input.checked)), [false, false, false, false, false, true]);
  await assert.rejects(adapter.selectModel('Unknown GPU 24GB'), error => error.code === 'MODEL_MISSING');
  assert.deepEqual(await domPage.locator('label.el-checkbox input').evaluateAll(inputs => inputs.map(input => input.checked)), [false, false, false, false, false, true]);
  const hosts = await adapter.readHosts('北京B区', customModel);
  assert.deepEqual(hosts.map(host => host.gpuModel), ['A100 80GB', customModel]);
  assert.equal(hosts.every(host => host.available === 2 && host.price === 2.5), true);
  // 用独立浏览器上下文把官网 origin 和所有 API 请求完整拦截为合成响应，验证真实 adapter 入口。
  // 不加载官网网页、不读取真实登录资料；任何未列出的请求都会被阻止并使回归失败。
  const inventoryContext = await browser.newContext({ serviceWorkers: 'block' });
  const inventoryRequests = []; let inventoryFailure = '';
  await inventoryContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/synthetic-inventory')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>合成库存 API</title><p>只读夹具</p>' });
    const endpoint = url.pathname.replace('/api/v1/sub_user/', '/api/v1/');
    if (url.origin !== 'https://www.autodl.com' || !['/api/v1/region/list', '/api/v1/machine/region/gpu_type',
      '/api/v1/user/machine/list', '/api/v1/user/member/detail'].includes(endpoint)) {
      blocked.push(url.href); return route.abort();
    }
    const params = request.method() === 'POST' ? request.postDataJSON() : null;
    inventoryRequests.push({ endpoint: url.pathname, method: request.method(), params });
    assert.equal(request.headers().authorization, 'synthetic-inventory-token');
    assert.equal(request.headers().appversion, 'synthetic-version');
    let data;
    if (endpoint === '/api/v1/region/list') data = [
      { data_center: 'synthetic-bj', region_name: '北京B区', region_sign: 'synthetic-bj-1' },
      { data_center: 'synthetic-bj', region_name: '北京B区', region_sign: 'synthetic-bj-2' },
      { data_center: 'synthetic-west', region_name: '西北B区', region_sign: 'synthetic-west' },
    ];
    else if (endpoint === '/api/v1/machine/region/gpu_type') {
      if (params.region_sign_list[0] === 'synthetic-bj-1') {
        assert.deepEqual(params.region_sign_list, ['synthetic-bj-1', 'synthetic-bj-2']);
        data = [{ 'RTX 4090': { idle_gpu_num: 2, total_gpu_num: 8 } }, { 'A100 80GB': { idle_gpu_num: 1, total_gpu_num: 4 } }];
      } else data = [{ 'RTX 3090': { idle_gpu_num: 5, total_gpu_num: 8 } }, { 'RTX 4090': { idle_gpu_num: 0, total_gpu_num: 16 } }];
    } else if (endpoint === '/api/v1/user/member/detail') data = { member_level: 'member_user' };
    else {
      assert.equal(params.page_index, 1); assert.equal(params.page_size, 90); assert.equal(params.gpu_idle_num, 0);
      assert.deepEqual(params.gpu_type_name, ['RTX 4090']);
      data = { result_total: 1, max_page: 1, list: [{ machine_id: 'synthetic-api-host', machine_alias: '合成 API 机', gpu_name: 'RTX 4090',
        gpu_number: 8, gpu_idle_num: 2, region_sign: 'synthetic-bj-1', region_name: '北京B区', on_line: 2,
        max_instance_num: 80, binding_instance_num: 70,
        machine_sku_info: [{ type: 'payg', current_price: 2290, level_config: [{ level_name: 'member_user', discount: 95 }] }] }] };
    }
    const code = inventoryFailure === 'auth' ? 'AuthorizeFailed'
      : inventoryFailure === 'west' && params?.region_sign_list[0] === 'synthetic-west' ? 'SyntheticUnavailable' : 'Success';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code, data }) });
  });
  const inventoryPage = await inventoryContext.newPage();
  inventoryPage.on('pageerror', error => errors.push(error.message));
  await inventoryPage.goto('https://www.autodl.com/synthetic-inventory');
  await inventoryPage.evaluate(() => {
    localStorage.setItem('token', 'synthetic-inventory-token'); localStorage.setItem('user', '{}');
    localStorage.setItem('app_version', '{"version":"synthetic-version"}');
  });
  const catalogAdapter = new AutoDLBrowserAdapter(dir), prepared = { synthetic: true }, probed = { synthetic: true };
  Object.assign(catalogAdapter, { context: inventoryContext, page: inventoryPage, prepared, probed,
    browser: forbidden, goto: forbidden, submit: forbidden }); catalogAdapter.setSession('ready');
  const pagesBefore = inventoryContext.pages().length;
  const catalog = await catalogAdapter.gpuCatalog(['北京B区', '西北B区', '内蒙B区']);
  assert.deepEqual(catalog.regions, [
    { region: '北京B区', models: [{ model: 'RTX 4090', available: 2, total: 8, disabled: false }, { model: 'A100 80GB', available: 1, total: 4, disabled: false }] },
    { region: '西北B区', models: [{ model: 'RTX 3090', available: 5, total: 8, disabled: false }, { model: 'RTX 4090', available: 0, total: 16, disabled: false }] },
    { region: '内蒙B区', models: [], missing: true }]);
  assert.equal(inventoryRequests.length, 3);
  const apiHosts = await catalogAdapter.marketHosts({ model: 'RTX 4090', region: '北京B区' });
  assert.equal(apiHosts.complete, true); assert.equal(apiHosts.rows[0].pricePerHour, 2.18); assert.equal(apiHosts.rows[0].available, 2);
  assert.equal(inventoryContext.pages().length, pagesBefore); assert.equal(catalogAdapter.page, inventoryPage);
  assert.equal(catalogAdapter.prepared, prepared); assert.equal(catalogAdapter.probed, probed);
  assert.equal(domPage.url(), base + '/synthetic-host-dom');
  inventoryFailure = 'west';
  const partial = await catalogAdapter.gpuCatalog(['北京B区', '西北B区']);
  assert.equal(partial.regions[0].models.length, 2); assert.match(partial.regions[1].error, /读取失败/);
  inventoryFailure = '';
  await inventoryPage.evaluate(() => localStorage.setItem('user', '{"sub_name":"synthetic-sub"}'));
  await catalogAdapter.gpuCatalog(['北京B区']);
  assert.equal(inventoryRequests.at(-1).endpoint, '/api/v1/sub_user/machine/region/gpu_type');
  inventoryFailure = 'auth';
  await assert.rejects(catalogAdapter.gpuCatalog(['北京B区']), error => error.code === 'INVENTORY_AUTH');
  assert.equal(catalogAdapter.session.state, 'expired'); assert.equal(inventoryContext.pages().length, pagesBefore);
  await inventoryContext.close();
  fixtures.set('/synthetic-instance-dom', '<!doctype html><meta charset="utf-8"><div class="el-table instance-table"><div class="el-table__header-wrapper"><table><thead><tr><th>实例ID/名称</th><th>地区</th><th>配置</th><th>主机</th><th>状态</th></tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody>' +
    '<tr><td><div style="cursor:pointer">sourceabc123-source123</div><div><span>合成源实例</span></div></td><td>北京B区</td><td>' + customModel + ' × 2</td><td>H01机</td><td>已关机</td></tr>' +
    '<tr><td><div style="cursor:pointer">targetabc123-target123</div><div><span>合成目标实例</span></div></td><td>北京B区</td><td>' + customModel + ' × 2</td><td>H02机</td><td>运行中</td></tr></tbody></table></div></div>');
  await domPage.goto(base + '/synthetic-instance-dom');
  const instances = await adapter.readInstancePage(customModel);
  assert.equal(instances.texts.every(text => text.includes('\t')), true);
  assert.equal(instances.instances.every(instance => instance.gpuModel === customModel && instance.gpuCount === 2), true);
  assert.equal(instances.instances[0].stopped, true); assert.equal(instances.instances[1].running, true);
  // 合成 Element 风格复选框：延迟生效、重排、“全部”规则、撤销、静默拒绝与禁用，均在本地页面中用真实浏览器点击。
  const checkboxResults = [];
  for (const scenario of CHECKBOX_SCENARIOS) {
    const result = await runCheckboxScenario(AutoDLBrowserAdapter, scenario, async (html, id) => {
      fixtures.set('/synthetic-checkbox-' + id, html);
      const fixturePage = await context.newPage(); fixturePage.on('pageerror', error => errors.push(error.message));
      await fixturePage.goto(base + '/synthetic-checkbox-' + id); return fixturePage;
    });
    const problems = checkScenarioExpectation(scenario, result);
    assert.deepEqual(problems, [], scenario.id + ': ' + JSON.stringify(result));
    checkboxResults.push(result);
  }
  assert.equal(checkboxResults.filter(result => result.outcome === 'wrong-pass').length, 0);
  assert.equal(forbiddenCalls, 0); assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  console.log('型号页面回归通过：默认自动创建并要求费用授权、10秒检查与20秒完整翻页默认值；按地区同步官方型号（只列所选地区、加选地区合集、重新同步后保留原选择）、新建/克隆型号与自定义、必选校验、轮询/扫描范围/模式切换保留、实际请求与落盘、18种模式/宽度布局，以及本地浏览器型号筛选、按地区读取型号目录和表格解析；' + checkboxResults.length + '个合成复选框场景（' + checkboxResults.filter(result => result.outcome === 'pass').length + '个按要求生效，' + checkboxResults.filter(result => result.outcome === 'fail').length + '个按预期安全停止，0个误报成功）。临时目录、引擎未启动，无真实登录、监测、租卡、通知或模型调用。');
} finally {
  await browser?.close(); await app?.close();
  const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('autodl-models-ui-isolated-')) throw Error('invalid isolated cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}

