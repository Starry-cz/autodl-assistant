import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { testConfig } from '../tests/fixtures/config.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';
import { syntheticImageOptions } from '../tests/fixtures/images.mjs';

// 全部页面使用临时状态、合成账号和内存模型回复；不访问实际平台、模型或通知服务。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-design-ui-'));
const output = path.join(root, 'output', 'playwright');
// 额外覆盖常见笔记本高度，以及 1920×1080 在 125% 缩放时的等效 CSS 视口。
// 这里验证响应式布局，不把 deviceScaleFactor 当作浏览器页面缩放。
const viewports = [1920, 1440, 768, 390, 320].map(width => ({
  width, height: width <= 768 ? 844 : 1000, scenario: '常规视口', suffix: String(width),
})).concat([
  { width: 1366, height: 768, scenario: '1366×768 笔记本', suffix: '1366x768' },
  { width: 1536, height: 864, scenario: '1920×1080 @125% 等效 CSS 视口', suffix: '1536x864' },
]);
const views = ['dashboard', 'settings', 'notifications', 'ai'];
const fields = ['rememberCredentials', 'webhookEnabled', 'webhookToken', 'webhookUrl', 'wechatEnabled', 'wechatToken'];
const errors = [], blocked = [], posts = [], results = [], failures = [], modeTransitions = [];
let app, browser, forbiddenCalls = 0, modelCalls = 0;
const forbidden = async () => { forbiddenCalls++; throw Error('设计验收禁止实际平台或外部网络操作'); };
fs.mkdirSync(output, { recursive: true });

// 返回页面中真实文字的计算样式，同时检查占位文本及动态报告；禁用控件不属于可操作文字。
async function inspectView(page, view, viewport) {
  return page.evaluate(({ view, viewport }) => {
    const { width, height, scenario } = viewport;
    const rgba = color => {
      const values = color.match(/[\d.]+/g).map(Number);
      return [...values.slice(0, 3), values[3] ?? 1];
    };
    const blend = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
    const luminance = rgb => rgb.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
    const identify = element => element.id ? `#${element.id}` : element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).trim().replace(/\s+/g, '.') : '');
    const roots = [...document.querySelectorAll(`.sidebar, .topbar, #${view}, footer`)];
    const targets = new Map();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, element = node.parentElement;
        if (!node.textContent.trim() || !visible(element) || element.closest('button:disabled, :disabled, svg, option, textarea')) continue;
        const existing = targets.get(element) || '';
        targets.set(element, (existing + ' ' + node.textContent.trim()).trim());
      }
    }
    for (const element of document.querySelectorAll(`#${view} input:not(:disabled), #${view} select:not(:disabled), #${view} textarea:not(:disabled)`)) {
      if (!visible(element) || ['checkbox', 'file', 'hidden'].includes(element.type)) continue;
      const text = element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent : element.value || element.placeholder;
      if (text) targets.set(element, text);
    }
    const contrast = [];
    for (const [element, text] of targets) {
      const layers = [];
      let opacity = 1;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        layers.unshift(rgba(style.backgroundColor));
        opacity *= Number(style.opacity);
      }
      const background = layers.reduce((back, front) => blend(front, back), [255, 255, 255]);
      const placeholder = ['INPUT', 'TEXTAREA'].includes(element.tagName) && !element.value && element.placeholder;
      const style = getComputedStyle(element, placeholder ? '::placeholder' : null);
      const foreground = rgba(style.color); foreground[3] *= opacity;
      const actualText = blend(foreground, background), a = luminance(actualText), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      contrast.push({ selector: identify(element), text: text.slice(0, 90), ratio: Math.round(ratio * 100) / 100,
        passes: ratio >= 4.5, foreground: style.color, background: background.map(Math.round).join(',') });
    }
    // 字号按阅读用途检查，避免把时间戳和状态徽标当成正文，也不靠截图视觉猜测。
    const typographyRules = [
      { group: '正文', selector: 'body', minSize: 16, minLeading: 1.5 },
      // 页面标题采用克制的 24–28px 层级，正文和对比度要求保持不变。
      { group: '主标题', selector: `#${view} h1`, minSize: 24, maxSize: 28, minLeading: 1.25 },
      { group: '导航', selector: '.nav-item', minSize: 14, minLeading: 1.4 },
      { group: '表单输入', selector: `#${view} input:not([type=checkbox]):not([type=radio]):not([type=hidden]), #${view} select, #${view} textarea`, minSize: 16, minLeading: 1.4 },
      { group: '普通说明', selector: `#${view} p, #${view} .hint, #${view} .notice, #${view} .task-meta, #${view} .task-progress,
        #${view} .instance-row span, #${view} .notification-item small, #${view} .ai-result-section li,
        #${view} .ai-result-section small, #${view} .plan-table th, #${view} .plan-table td,
        #${view} .plan-table td small, #${view} .mode small, #${view} .form-footnote, .sidebar-bottom p`, minSize: 14, minLeading: 1.5 },
      { group: '辅助标记', selector: `footer, time, #clock, #${view} .badge, .brand small, .nav-label, .version, .breadcrumb`, minSize: 13, minLeading: 1.25 },
    ];
    const measurements = [];
    for (const rule of typographyRules) {
      for (const element of document.querySelectorAll(rule.selector)) {
        if (!visible(element)) continue;
        const style = getComputedStyle(element), fontSize = parseFloat(style.fontSize), lineHeight = parseFloat(style.lineHeight);
        const leading = lineHeight / fontSize, nativeSelect = element.tagName === 'SELECT', controlHeight = element.getBoundingClientRect().height;
        // Chromium 的原生下拉框行高返回 normal，改测真实控件高度，不捏造数值行高。
        const spacingPasses = nativeSelect ? controlHeight >= 44 : leading + .001 >= rule.minLeading;
        measurements.push({ group: rule.group, selector: identify(element), text: (element === document.body ? '页面正文' : element.textContent || element.placeholder || element.name || '').trim().slice(0, 70),
          fontSize, computedLineHeight: style.lineHeight, lineHeight, leading: Math.round(leading * 100) / 100, fontFamily: style.fontFamily,
          ...(nativeSelect ? { controlHeight } : {}),
          passes: fontSize >= rule.minSize && (!rule.maxSize || fontSize <= rule.maxSize) && spacingPasses,
          expected: `${rule.minSize}${rule.maxSize ? '–' + rule.maxSize : '+'}px，${nativeSelect ? '控件高度至少 44px' : '行高至少 ' + rule.minLeading}` });
      }
    }
    const typography = { measurements, violations: measurements.filter(row => !row.passes),
      minimumSizes: Object.fromEntries(typographyRules.map(rule => [rule.group, Math.min(...measurements.filter(row => row.group === rule.group).map(row => row.fontSize))]).filter(([, value]) => Number.isFinite(value))) };
    const overflow = document.documentElement.scrollWidth - innerWidth;
    const overflowElements = overflow > 1 ? [...document.querySelectorAll('body *')].filter(element => {
      if (!visible(element)) return false;
      const box = element.getBoundingClientRect(); return box.right > innerWidth + 1 && box.width > 0;
    }).slice(0, 12).map(element => ({ selector: identify(element), right: element.getBoundingClientRect().right })) : [];
    let settings = null;
    if (view === 'settings') {
      const rect = selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right };
      };
      const channels = [...document.querySelectorAll('.settings-channel')].map(element => {
        const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      const form = rect('#settings-form'), main = rect('main');
      settings = { channels, centerDelta: Math.abs(form.x + form.width / 2 - (main.x + main.width / 2)) };
    }
    return { view, width, height, scenario, overflow, overflowElements, textCount: contrast.length,
      minContrast: Math.min(...contrast.map(row => row.ratio)), lowContrast: contrast.filter(row => !row.passes), typography, settings };
  }, { view, viewport });
}

try {
  const autodl = Object.assign(new SyntheticAdapter(), {
    imageOptions: syntheticImageOptions,
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '合成账号', message: '仅本地界面验收', checkedAt: Date.now() }),
    instances: async () => [{ id: 'syntheticdesign-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
      stopped: true, running: false, cardless: false, starting: false, gpuAvailable: false }],
    login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden,
    inspectBoot: forbidden, boot: forbidden,
  });
  app = createApplication({ runtimeDir: dir, startEngine: false, fingerprint: () => 'synthetic-design-ui-build', adapters: { autodl }, walletOptions: { fetchImpl: forbidden },
    aiOptions: { fetchImpl: async () => {
      modelCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '合成报告：已读取依赖版本，仍需在目标实例核验。',
        findings: [{ message: '项目指定 PyTorch 版本。', evidence: 'torch==2.1.0' }, { message: '显存需要进一步测量。', evidence: '未提供显存测量结果' }],
        recommendations: [{ action: '核对实际运行环境', reason: '版本声明不能证明 GPU 已可用。', verification: '在目标实例执行最小 CUDA 测试。' }],
        questions: ['请补充模型规模和批量大小。'], warnings: ['合成数据，仅用于页面验收。'],
      }) } }], usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } }));
    } } });
  seedGpuCatalog(app.store);
  const task = app.store.create(testConfig({ name: 'RTX 4090 新租监测（合成示例）' }));
  app.store.patch(task, { state: 'paused', attempts: 12 });
  app.store.log(task, 'info', '合成示例：已暂停监测，尚未创建任何真实实例。');
  const bootTask = app.store.create(testConfig({ name: '原实例等待空卡（合成示例）', mode: 'boot', sourceId: 'syntheticdesign-source' }));
  app.store.patch(bootTask, { state: 'attention', lastError: '合成示例：请核对原实例状态后继续。' });
  app.store.enqueueNotification(task, 'found', '合成示例：北京 B 区发现 RTX 4090 空卡。观察任务只发送提醒，不租用资源。');
  app.store.enqueueNotification(bootTask, 'attention', '合成示例：原实例状态需要核对。打开任务详情可查看记录。');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { blocked.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/notifications/settings' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  // 默认进入监控室，旧来源列表现归属实例页，展开后仍使用原同步接口。
  await page.locator('[data-view=fleet]').click();
  await page.locator('#fleet-sources > summary').click();
  await page.locator('#sync-instances').click();
  await page.locator('#account-instances .instance-row').waitFor();
  await page.locator('[data-view=dashboard]').click();

  // 模式切换只重置配置区滚动位置，不能丢掉用户已填的名称与轮询间隔。
  const taskForm = page.locator('#task-form');
  await taskForm.locator('[name=name]').fill('新租监测（合成输入）');
  await taskForm.locator('[name=pollSeconds]').fill('17');
  for (const mode of ['boot', 'create']) {
    const geometry = await page.locator('.config-fields').evaluate(element => {
      const maxScroll = element.scrollHeight - element.clientHeight;
      element.scrollTop = element.scrollHeight;
      return { sourceMode: document.querySelector('.mode.active').dataset.mode, scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight, maxScroll, needsScroll: maxScroll > 1,
        overflowY: getComputedStyle(element).overflowY, scrolledTop: element.scrollTop };
    });
    modeTransitions.push({ ...geometry, targetMode: mode });
    // 等高面板可容纳短开机表单；只有内容确实超出时，才要求原生滚动到达底部。
    if (geometry.needsScroll) {
      assert.ok(['auto', 'scroll'].includes(geometry.overflowY), `长表单应允许滚动：${JSON.stringify(geometry)}`);
      assert.ok(geometry.scrolledTop > 0 && Math.abs(geometry.scrolledTop - geometry.maxScroll) <= 1,
        `长表单应能滚到底部：${JSON.stringify(geometry)}`);
    } else {
      assert.equal(geometry.scrolledTop, 0, `短表单不应产生多余滚动：${JSON.stringify(geometry)}`);
    }
    await page.locator(`[data-mode=${mode}]`).click();
    assert.equal(await page.locator('.config-fields').evaluate(element => element.scrollTop), 0);
    assert.equal(await taskForm.locator('[name=name]').inputValue(), '新租监测（合成输入）');
    assert.equal(await taskForm.locator('[name=pollSeconds]').inputValue(), '17');
  }
  // 至少有一次真实溢出的模式切换，防止回顶断言在所有表单均未滚动时空通过。
  assert.ok(modeTransitions.some(row => row.needsScroll && row.scrolledTop > 0), '必须覆盖长表单滚动后的切模式回顶');

  // 使用同一张原生表单保存两个通知渠道，核对旧接口的六个字段及布尔值未改变。
  await page.locator('[data-view=settings]').click();
  const form = page.locator('#settings-form'), field = name => form.locator(`[name=${name}]`);
  assert.deepEqual(await form.locator('[name]').evaluateAll(elements => elements.map(element => element.name).sort()), fields);
  const settings = { webhookEnabled: true, webhookUrl: 'https://notify.example.test/synthetic', webhookToken: 'synthetic-webhook-token',
    wechatEnabled: true, wechatToken: 'synthetic-wechat-token', rememberCredentials: false };
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') await field(name).setChecked(value);
    else await field(name).fill(value);
  }
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notifications/settings' && response.request().method() === 'POST');
  await form.locator('button[type=submit]').click();
  assert.equal((await saved).status(), 200);
  await page.waitForFunction(() => document.querySelector('#settings-form [name=webhookUrl]').value === '***');
  assert.deepEqual(posts, [settings]);
  for (const [name, value] of Object.entries(settings)) assert.equal(app.store.data.settings[name], value, `通知字段 ${name}`);

  // 生成规则规划和内存模型报告，覆盖旧动态结果里的辅助文本，而不只检查静态设置页。
  await page.locator('[data-view=ai]').click();
  await page.locator('#plan-form [name=projectText]').fill('合成示例\ntorch==2.1.0\nCUDA 12.1\nRequires 14GB of GPU memory.');
  await page.locator('#plan-submit').click();
  await page.locator('#plan-results').waitFor({ state: 'visible' });
  const aiSettings = page.locator('#ai-settings-form');
  await aiSettings.locator('[name=enabled]').check();
  await aiSettings.locator('[name=apiKey]').fill('sk-design-synthetic-not-real-123456');
  await aiSettings.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#ai-analyze').disabled);
  await page.locator('#ai-analysis-form [name=request]').fill('合成页面验收：核对项目依赖');
  await page.locator('#ai-analysis-form [name=projectText]').fill('torch==2.1.0');
  await page.locator('#ai-analysis-form [name=consent]').check();
  await page.locator('#ai-analyze').click();
  await page.locator('#ai-results').waitFor({ state: 'visible' });
  assert.equal(modelCalls, 1);
  await page.locator('#toast').waitFor({ state: 'hidden' });

  for (const viewport of viewports) {
    const { width, height } = viewport;
    await page.setViewportSize({ width, height });
    for (const view of views) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator(`[data-view=${view}]`).click();
      await page.locator(`#${view}`).waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => window.scrollY), 0, `${view} ${width}px 切页应回到顶部`);
      assert.deepEqual(await page.locator('.nav-item[aria-current=page]').evaluateAll(elements => elements.map(element => element.dataset.view)), [view]);
      await page.evaluate(async () => {
        // 等待有限的入场动画结束，避免截图和颜色读到过渡中的透明度。
        await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
      });
      const result = await inspectView(page, view, viewport);
      result.screenshot = path.join(output, `design-${view}-${viewport.suffix}.png`);
      await page.screenshot({ path: result.screenshot, fullPage: true, animations: 'disabled' });
      if (view === 'dashboard' && width > 1150) {
        // 两列随实际内容等高；不再为强行压进首屏而截短左侧表单。
        result.desktopForm = await page.evaluate(() => {
          const fields = document.querySelector('.config-fields'), button = document.querySelector('#submit-task');
          const buttonBox = button.getBoundingClientRect();
          fields.scrollTop = fields.scrollHeight;
          const scrolledTop = fields.scrollTop;
          fields.scrollTop = 0;
          const left = document.querySelector('.composer').getBoundingClientRect(), right = document.querySelector('.task-column').getBoundingClientRect();
          return { buttonTop: buttonBox.top, buttonBottom: buttonBox.bottom, viewportHeight: innerHeight, bottomDelta:Math.abs(left.bottom-right.bottom),
            scrollHeight: fields.scrollHeight, clientHeight: fields.clientHeight, maxScroll: fields.scrollHeight - fields.clientHeight,
            needsScroll: fields.scrollHeight - fields.clientHeight > 1, overflowY: getComputedStyle(fields).overflowY, scrolledTop };
        });
        const form = result.desktopForm;
        // 内容放得下时无须滚动；超出时必须允许滚动并到达底部，两列始终等高。
        const scrollPasses = form.needsScroll
          ? ['auto', 'scroll'].includes(form.overflowY) && form.scrolledTop > 0 && Math.abs(form.scrolledTop - form.maxScroll) <= 1
          : form.scrolledTop === 0;
        if (form.bottomDelta > 2 || form.clientHeight < 180 || !scrollPasses) {
          failures.push(`dashboard ${width}×${height} 两列对齐或配置滚动异常：${JSON.stringify(form)}`);
        }
      }
      if (view === 'dashboard' && width >= 1200 && height <= 900) {
        // 逐项点击证明输入不被操作栏覆盖，操作栏滚到后可用。
        result.firstScreenScreenshot = path.join(output, `design-dashboard-${viewport.suffix}-first.png`);
        await page.screenshot({ path: result.firstScreenScreenshot, animations: 'disabled' });
        result.lowHeightInputs = [];
        for (const name of ['name', 'action', 'pollSeconds']) {
          // 执行方式由可见选择卡承载交互；隐藏 select 仍是提交值来源。
          const input = page.locator(name === 'action' ? '[data-action-choice=execute]' : `#task-form [name=${name}]`);
          const before = await taskForm.locator(`[name=${name}]`).inputValue();
          await input.scrollIntoViewIfNeeded();
          await input.click();
          const evidence = await input.evaluate((element, name) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { name, scrollY, focused: document.activeElement === element,
              top: box.top, bottom: box.bottom, height: box.height, value: document.querySelector(`#task-form [name=${name}]`).value,
              unobscured: (hit === element || element.contains(hit)) && box.top >= 0 && box.bottom <= innerHeight };
          }, name);
          result.lowHeightInputs.push(evidence);
          if (!evidence.focused || !evidence.unobscured || evidence.value !== before) {
            failures.push(`dashboard ${width}×${height} 输入无法正常操作：${JSON.stringify(evidence)}`);
          }
        }
        await page.locator('.task-submit-bar').scrollIntoViewIfNeeded();
        result.taskBar = await page.evaluate(() => {
          const button = document.querySelector('#submit-task');
          const rect = element => {
            const box = element.getBoundingClientRect();
            return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
          };
          const barBox = rect(document.querySelector('.task-submit-bar')), buttonBox = rect(button);
          const buttonHit = document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2);
          return { scrollY, barBox,
            barVisible: barBox.top >= 0 && barBox.bottom <= innerHeight + 1,
            submitUnobscured: buttonHit === button || button.contains(buttonHit) };
        });
        result.taskBar.screenshot = path.join(output, `design-dashboard-${viewport.suffix}-form.png`);
        await page.screenshot({ path: result.taskBar.screenshot, animations: 'disabled' });
        if (!result.taskBar.barVisible || !result.taskBar.submitUnobscured) {
          failures.push(`dashboard ${width}×${height} 操作栏滚到后仍受遮挡：${JSON.stringify(result.taskBar)}`);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      results.push(result);
      if (result.overflow > 1) failures.push(`${view} ${width}px 横向溢出 ${result.overflow}px：${JSON.stringify(result.overflowElements)}`);
      if (result.lowContrast.length) failures.push(`${view} ${width}px 文字对比度不足：${JSON.stringify(result.lowContrast)}`);
      if (result.typography.violations.length) failures.push(`${view} ${width}×${height} 字号或行高不足：${JSON.stringify(result.typography.violations)}`);
      if (result.textCount < 20) failures.push(`${view} ${width}px 可测文字过少：${result.textCount}`);
      if (view === 'settings') {
        const { channels, centerDelta } = result.settings;
        if (centerDelta > 2) failures.push(`settings ${width}px 内容未居中：偏差 ${centerDelta}px`);
        if (width >= 1440 && !(Math.abs(channels[0].y - channels[1].y) <= 2 && channels[1].x >= channels[0].x + channels[0].width - 2)) failures.push(`settings ${width}px 两个通知渠道未并列`);
        if (width <= 390 && !(Math.abs(channels[0].x - channels[1].x) <= 2 && channels[1].y >= channels[0].y + channels[0].height - 2)) failures.push(`settings ${width}px 两个通知渠道未纵向排列`);
      }
    }
  }
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  const report = { source: '隔离临时服务与合成数据，非真实平台验证', checkedAt: new Date().toISOString(), settingsFields: fields,
    settingsSaved: true, modeScrollReset: true, modeTransitions, navigationScrollReset: true, modelCalls, externalCalls: blocked.length + forbiddenCalls, results, failures };
  fs.writeFileSync(path.join(output, 'design-report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const result of results) console.log(`${result.view} ${result.width}×${result.height}：${result.textCount} 处文字，最低对比度 ${result.minContrast}，横向溢出 ${result.overflow}px；最小字号 ${JSON.stringify(result.typography.minimumSizes)}`);
  assert.deepEqual(failures, [], '页面设计验收失败，详见 output/playwright/design-report.json');
  console.log(`设计验收通过：${views.length} 个视图 × ${viewports.length} 个视口，字号与行高、文字对比度、横向边界、通知双列与窄屏排列、六个原通知字段保存；${results.length} 张截图。缩放场景使用等效 CSS 视口；全部为合成数据，无实际平台操作。`);
} finally {
  await browser?.close();
  await app?.close();
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('autodl-design-ui-'));
  fs.rmSync(target, { recursive: true, force: true });
}
