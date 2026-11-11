import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { goView } from './ui-navigation.mjs';

// 使用真实页面、本机 HTTP 与合成回执；测试令牌仅存在临时服务，不向外发送消息。
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-notification-ui-'));
const output = path.resolve('output/playwright');
fs.mkdirSync(output, { recursive: true });
const secrets = { webhook: 'synthetic-hook-ui-not-a-real-token', wechat: 'synthetic-wechat-ui-not-a-real-token' };
const report = { checks: [], requests: [], browserErrors: [], externalRequests: [], screenshots: [] };
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };
let app, browser, releaseResponse, now = Date.now(), responseMode = 'held-webhook';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const entered = gate(), released = gate();
releaseResponse = released.resolve;
try {
  app = createApplication({ runtimeDir, startEngine: false, updatesOptions: offlineUpdateOptions,
    fingerprint: () => 'isolated-notification-buttons', adapters: { autodl: Object.assign(new SyntheticAdapter(), {
      sessionStatus: () => ({ state: 'ready', browserOpen: true, checkedAt: 1, label: '合成会话', message: '仅测试' }),
    }) } });
  app.engine.notifier.clock = () => now;
  app.engine.notifier.fetch = async (url, options) => {
    const channel = url.includes('isolated.example.test') ? 'webhook' : 'wechat';
    report.requests.push({ channel, method: options.method, body: JSON.parse(options.body) });
    assert.equal(options.headers.Authorization, channel === 'webhook' ? 'Bearer ' + secrets.webhook : secrets.wechat);
    assert.equal(options.method, 'POST');
    if (responseMode === 'held-webhook') { entered.resolve(); await released.promise; return new Response(null, { status: 204 }); }
    if (responseMode === 'http-401') return new Response(null, { status: 401 });
    if (responseMode === 'timeout') throw new DOMException('synthetic response body timeout', 'TimeoutError');
    if (responseMode === 'business-failure') return Response.json({ code: 'Unauthorized', message: 'synthetic rejection ' + secrets.wechat + ' <img src=x onerror=alert(1)>' });
    return Response.json({ code: 'Success' });
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const executablePath = candidates.find(file => fs.existsSync(file));
  assert.ok(executablePath, '缺少可运行的 Chromium 浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const testPosts = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/notifications/test' && request.method() === 'POST') testPosts.push(request.postDataJSON());
  });
  // 首次读取尚未完成时，不允许用空表单覆盖已保存凭据。
  const initialState = gate();
  await page.route(base + '/api/state', async route => { await initialState.promise; return route.continue(); });
  await page.goto(base);
  await page.waitForFunction(() => !!window.notificationSettings);
  assert.equal(await page.locator('#settings-form button[type=submit]').isDisabled(), true);
  assert.equal(await page.locator('#settings-form [name=wechatToken]').isDisabled(), true);
  initialState.resolve();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  await page.unroute(base + '/api/state');
  pass('首次读取配置完成前，禁用保存与输入，不能用空表单覆盖原配置');
  await goView(page, 'settings');
  const form = page.locator('#settings-form'), field = name => form.locator('[name=' + name + ']');
  const button = channel => page.locator('#test-' + channel), status = channel => page.locator('#' + channel + '-test-status');
  const save = form.locator('button[type=submit]');
  const saveSettings = async () => {
    const [response] = await Promise.all([page.waitForResponse(response => response.url() === base + '/api/notifications/settings' && response.request().method() === 'POST'), save.click()]);
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => document.querySelector('#settings-form [name=webhookUrl]').value === '***');
    await page.waitForFunction(() => !document.querySelector('#test-webhook').disabled && !document.querySelector('#test-wechat').disabled);
  };
  const clickTest = async (channel, expectedStatus = 200, keyboard = false) => {
    const pending = page.waitForResponse(response => response.url() === base + '/api/notifications/test' && response.request().method() === 'POST');
    if (keyboard) { await button(channel).focus(); await page.keyboard.press('Enter'); } else await button(channel).click();
    const response = await pending;
    assert.equal(response.status(), expectedStatus);
    await page.waitForFunction(channel => !document.querySelector('#test-' + channel).textContent.includes('发送中'), channel);
    return response.json();
  };

  for (const channel of ['webhook', 'wechat']) {
    assert.equal(await button(channel).isDisabled(), true);
    assert.equal(await button(channel).getAttribute('type'), 'button');
    assert.equal(await status(channel).getAttribute('role'), 'status');
  }
  await field('webhookEnabled').check();
  await field('webhookUrl').fill('https://isolated.example.test/notify');
  await field('webhookToken').fill(secrets.webhook);
  await field('wechatEnabled').check();
  await field('wechatToken').fill(secrets.wechat);
  await field('rememberCredentials').uncheck();
  for (const channel of ['webhook', 'wechat']) assert.equal(await button(channel).isDisabled(), true);
  assert.match(await status('wechat').textContent(), /保存/);
  assert.equal(report.requests.length, 0);
  pass('未保存或未启用时不能发送，填写配置不触发网络发送');
  await saveSettings();
  assert.equal(await field('wechatToken').inputValue(), '***');
  pass('保存后凭据掩码回填，两个渠道可分别测试');

  const heldResponse = page.waitForResponse(response => response.url() === base + '/api/notifications/test' && response.request().method() === 'POST');
  // 断言失败时仍由 finally 关闭浏览器，不能让未完成的回执等待掩盖原始错误。
  heldResponse.catch(() => {});
  await button('webhook').click(); await entered.promise;
  assert.match(await button('webhook').textContent(), /发送中/);
  assert.equal(await button('webhook').isDisabled(), true);
  assert.equal(await button('wechat').isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(report.requests.length, 1);
  // 心跳会依次刷新通知表单与账号模块；后者不能重新解锁尚在发送的凭据选项。
  await page.evaluate(() => refresh());
  assert.equal(await field('rememberCredentials').isDisabled(), true, '发送期间心跳不能解锁记住凭据选项');
  released.resolve();
  assert.equal((await heldResponse).status(), 200);
  await page.waitForFunction(() => /成功|已接受/.test(document.querySelector('#webhook-test-status').textContent));
  pass('发送中阻止重复点击及保存，Webhook 204 显示成功');

  responseMode = 'success'; now += 20000;
  const wechatReply = await clickTest('wechat', 200, true);
  assert.equal(wechatReply.test.success, true);
  assert.match(await status('wechat').textContent(), /成功|已接受/);
  assert.deepEqual(testPosts, [{ channel: 'webhook', expectedRevision:1 }, { channel: 'wechat', expectedRevision:1 }]);
  pass('键盘可发送微信测试，浏览器只传渠道与配置版本，不上传未保存凭据');
  const sentBeforeRateLimit = report.requests.length;
  await clickTest('wechat', 429);
  assert.equal(report.requests.length, sentBeforeRateLimit);
  assert.match(await status('wechat').textContent(), /秒|稍后|限/);
  pass('微信共享发送限速，过快点击显示等待原因且没有外发');

  responseMode = 'http-401'; now += 20000;
  const failed = await clickTest('webhook');
  assert.equal(failed.test.success, false);
  assert.match(await status('webhook').textContent(), /401|凭据|Token/);
  const sentAfterFailure = report.requests.length;
  await page.waitForTimeout(2200);
  assert.equal(report.requests.length, sentAfterFailure, '测试失败不能自动重发');
  pass('HTTP 401 显示可理解原因，测试失败不自动重发');
  responseMode = 'timeout'; now += 20000;
  assert.equal((await clickTest('webhook')).test.success, false);
  assert.match(await status('webhook').textContent(), /超时|未收到完整回执/);
  pass('响应超时以失败提示展示，按钮恢复可用');
  responseMode = 'business-failure'; now += 20000;
  assert.equal((await clickTest('wechat')).test.success, false);
  assert.match(await status('wechat').textContent(), /失败|拒绝|成功回执/);
  assert.equal((await form.innerText()).includes(secrets.wechat), false);
  assert.equal(await status('wechat').locator('img,script').count(), 0);
  pass('业务失败不伪装成功，错误不泄露 Token 或执行 HTML');

  await field('webhookUrl').fill('https://changed.example.test/new');
  assert.equal(await button('webhook').isDisabled(), true);
  assert.equal(await button('wechat').isDisabled(), true);
  assert.match(await status('webhook').textContent(), /保存/);
  // 恢复已保存掩码，确认仅修改表单不会改变后台配置。
  await field('webhookUrl').fill('***');
  assert.equal(app.store.data.settings.webhookUrl, 'https://isolated.example.test/notify');
  pass('修改配置后要求先保存，不会误用尚未保存的新地址');

  const remoteSave = async patch => {
    const response = await page.request.post(base + '/api/notifications/settings', {
      headers: { 'X-Local-Token': app.token },
      data: { ...app.store.data.settings, ...patch, expectedRevision:app.store.data.notificationSettingsRevision },
    });
    assert.equal(response.status(), 200); return response.json();
  };
  await remoteSave({ wechatEnabled:false });
  await page.waitForFunction(() => !document.querySelector('#settings-form [name=wechatEnabled]').checked);
  assert.equal(await button('wechat').isDisabled(), true);
  assert.doesNotMatch(await status('wechat').innerText(), /synthetic rejection/);
  pass('其他窗口保存后，干净表单同步新配置并清除过期测试结果');

  await field('webhookUrl').fill('https://draft.example.test/preserve');
  const requestsBeforeConflict = report.requests.length;
  await remoteSave({ wechatEnabled:true, webhookUrl:'https://isolated.example.test/changed' });
  await page.locator('#reload-notification-settings').waitFor({state:'visible'});
  assert.equal(await field('webhookUrl').inputValue(),'https://draft.example.test/preserve');
  assert.equal(await save.isDisabled(),true);
  assert.equal(await button('wechat').isDisabled(),true);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:width===390?844:1080});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true);
    const imagePath=path.join(output,'notification-conflict-'+width+'.png');
    await page.screenshot({path:imagePath,fullPage:true,animations:'disabled'});report.screenshots.push(imagePath);
  }
  await page.setViewportSize({width:1440,height:1080});
  await page.locator('#reload-notification-settings').click();
  await page.waitForFunction(() => !document.querySelector('#test-wechat').disabled);
  assert.equal(await field('webhookUrl').inputValue(),'***');
  assert.equal(report.requests.length,requestsBeforeConflict);
  pass('多窗口配置变化保留未保存草稿，明确载入最新配置后才允许保存或测试');

  // 在下一次心跳前配置已被其他窗口替换，也必须由服务器拦截旧版本测试。
  const blockedPoll = gate();
  await page.route(base + '/api/state', route => { blockedPoll.resolve(); return route.abort(); });
  await blockedPoll.promise;
  await remoteSave({ webhookUrl:'https://isolated.example.test/latest' });
  now += 20000;
  await clickTest('webhook',409);
  assert.equal(report.requests.length,requestsBeforeConflict);
  assert.match(await page.locator('#notification-save-status').innerText(),/其他页面|最新配置/);
  assert.equal(await save.isDisabled(),true);
  await page.unroute(base + '/api/state');
  await page.locator('#reload-notification-settings').click();
  await page.waitForFunction(() => !document.querySelector('#test-webhook').disabled);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  pass('心跳尚未同步时，旧配置测试被拦截，不向已更换的接收端外发');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.locator('#settings').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, width + 'px 横向溢出');
    const imagePath = path.join(output, 'notification-tests-' + width + '.png');
    await page.screenshot({ path: imagePath, fullPage: true, animations: 'disabled' });
    report.screenshots.push(imagePath);
  }
  assert.equal(app.store.tasks().length, 0);
  assert.equal(app.store.data.notifications.length, 0);
  const stored = fs.readFileSync(path.join(runtimeDir, 'state.json'), 'utf8');
  for (const secret of Object.values(secrets)) assert.equal(stored.includes(secret), false);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.browserErrors, []);
  pass('桌面与窄屏无溢出，未生成任务/通知队列，未保存明文凭据或外部调用');

  // 模拟没有系统加密存储的环境；编辑其他字段也不能重新启用不支持的记住选项。
  await page.route(base + '/api/state', async route => {
    const response = await route.fetch(), state = await response.json();
    state.credentialStorage.available = false;
    state.settings.rememberCredentials = true;
    await route.fulfill({ response, json: state });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '已连接');
  await goView(page, 'settings');
  await field('webhookUrl').fill('https://draft.example.test/unavailable-storage');
  assert.equal(await field('rememberCredentials').isDisabled(), true, '加密存储不可用时不能记住凭据');
  assert.equal(await field('rememberCredentials').isChecked(), false);
  pass('加密存储不可用时，编辑表单仍保持记住凭据选项关闭且禁用');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); throw error;
} finally {
  releaseResponse?.();
  await browser?.close(); await app?.close();
  fs.writeFileSync(path.join(output, 'notification-test-ui-report.json'), JSON.stringify(report, null, 2));
  const resolved = path.resolve(runtimeDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('autodl-notification-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
