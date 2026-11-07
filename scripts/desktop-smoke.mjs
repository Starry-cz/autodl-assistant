import { goView } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { _electron as electron, chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与当前源码版本一致，升级补丁版时同样校验安装包，避免测试固定在旧版本。
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const require = createRequire(import.meta.url);
const packaged = Boolean(process.argv[2]);
const sourceExecutable = packaged ? path.resolve(process.argv[2]) : require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-desktop-check-'));
// Playwright 启动内置浏览器会写依赖验证标记；打包验收必须运行独立副本，不改发布构建目录。
const packagedCopy = path.join(dataDir, 'application');
if (packaged) fs.cpSync(path.dirname(sourceExecutable), packagedCopy, { recursive: true });
const executablePath = packaged ? path.join(packagedCopy, path.basename(sourceExecutable)) : sourceExecutable;
const args = packaged ? [] : [root];
const loader = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib', 'server', 'electron', 'loader.js');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
// 测试使用全新账号目录，并移除全局 Node 与浏览器路径；不接触真实 8787 或 AutoDL 账号。
fs.writeFileSync(path.join(dataDir, 'tray-hint-shown'), '');
const env = { ...process.env, AUTODL_DESKTOP_DATA_DIR: dataDir, AUTODL_BROWSER_CHANNEL: 'not-a-real-channel', PLAYWRIGHT_BROWSERS_PATH: path.join(dataDir, 'missing-browser-cache') };
for (const key of Object.keys(env)) if (/^path$/i.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
env.Path = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
const report = { packaged, sourceExecutable, executablePath, dataDir, checks: [], passed: false };
let desktop, nativeDesktop, nativeBase;
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };

async function start() {
  // 显式 EXE 路径会跳过 Playwright 的默认 loader；测试恢复同一 ready 握手，避免窗口早于调试连接创建。
  const instance = await electron.launch({ executablePath, args: ['-r', loader, ...args], cwd: root, env, timeout: 60000, chromiumSandbox: true });
  const page = await instance.firstWindow();
  await page.locator('[data-view="overview"]').first().waitFor();
  return { instance, page };
}
async function quit(instance) {
  const closed = instance.waitForEvent('close', { timeout: 60000 });
  // 调试连接关闭可能早于 Electron 退出；等系统进程结束后再启动，确保单实例锁已释放。
  const exited = once(instance.process(), 'exit');
  await instance.evaluate(({ Menu }) => { setTimeout(() => Menu.getApplicationMenu().getMenuItemById('desktop-quit').click(), 0); });
  await closed;
  await exited;
}
async function restartNative() {
  const logFile = path.join(dataDir, 'desktop.log');
  const logOffset = fs.readFileSync(logFile, 'utf8').length;
  let watcher, timer;
  // 桌面启动日志写在 loadURL 与 showWindow 完成之后；等待这条实际事件，不猜测启动时长。
  const ready = new Promise((resolve, reject) => {
    watcher = fs.watch(logFile, () => {
      const added = fs.readFileSync(logFile, 'utf8').slice(logOffset);
      if (added.includes('桌面版已启动')) resolve();
    });
    watcher.once('error', reject);
  });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('原生桌面启动未完成，请查看本次临时目录中的 desktop.log')), 60000);
  });
  // 只连接 Chromium 读取页面持久化数据，不再注入 Electron loader 或启动 Node 调试握手。
  nativeDesktop = spawn(executablePath, ['--remote-debugging-port=0', ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const debugging = new Promise(resolve => {
    let output = '';
    nativeDesktop.stderr.setEncoding('utf8');
    nativeDesktop.stderr.on('data', chunk => {
      output += chunk;
      const endpoint = output.match(/DevTools listening on (ws:\/\/[^\r\n]+)/)?.[1];
      if (endpoint) resolve(endpoint);
    });
  });
  const exitedBeforeReady = once(nativeDesktop, 'exit').then(([code]) => { throw new Error('原生桌面启动提前退出：' + code); });
  try {
    const [, endpoint] = await Promise.race([Promise.all([ready, debugging]), exitedBeforeReady, deadline]);
    return endpoint;
  }
  finally { watcher.close(); clearTimeout(timer); }
}
async function nativeRequest(pathname, data) {
  const health = await (await fetch(nativeBase + '/api/health')).json();
  assert.equal(health.pid, nativeDesktop.pid);
  assert.equal(health.runtimeDir, path.join(dataDir, 'runtime'));
  const html = await (await fetch(nativeBase + '/')).text();
  const token = html.match(/name="local-token" content="([0-9a-f]+)"/)?.[1];
  assert.ok(token, '原生桌面页面缺少本地访问令牌');
  return fetch(nativeBase + pathname, { method: data ? 'POST' : 'GET',
    headers: { 'X-Local-Token': token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000) });
}
async function quitNative() {
  const exited = once(nativeDesktop, 'exit', { signal: AbortSignal.timeout(60000) });
  const response = await nativeRequest('/api/server/stop', { confirm: true });
  assert.equal(response.status, 202);
  const [code] = await exited;
  assert.equal(code, 0);
  nativeDesktop = null;
}

try {
  let started = await start(); desktop = started.instance; let page = started.page;
  const info = await desktop.evaluate(({ app }) => ({ userData: app.getPath('userData'), appPath: app.getAppPath(), version: app.getVersion(), node: process.versions.node, electron: process.versions.electron, packaged: app.isPackaged }));
  assert.equal(info.userData, dataDir); assert.equal(info.version, expectedVersion); assert.equal(info.packaged, packaged);
  report.runtime = info;
  const base = new URL(page.url()).origin;
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.runtimeDir, path.join(dataDir, 'runtime')); assert.notEqual(new URL(base).port, '8787');
  pass('内置 Node 启动独立本地服务');
  // 同一界面在桌面包内必须选择桌面下载渠道，不能误导用户下载网页版源码。
  const updateInfo = await page.evaluate(async () => (await api('/api/state')).updates);
  assert.equal(updateInfo.channel, 'desktop'); assert.equal(updateInfo.currentVersion, expectedVersion);
  pass('桌面版本检查识别当前版本与桌面下载渠道');

  const browserInfo = await desktop.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const path = process.getBuiltinModule('node:path');
    const require = createRequire(path.join(app.getAppPath(), 'package.json'));
    const { chromium } = require('playwright');
    const executable = chromium.executablePath();
    // 只打开空白内容，验证随包 Chrome 可以独立运行，不访问 AutoDL。
    const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
    try {
      const blank = await browser.newPage(); await blank.setContent('<title>desktop-bundle-check</title>');
      return { executable, title: await blank.title(), version: browser.version() };
    } finally { await browser.close(); }
  });
  assert.equal(browserInfo.title, 'desktop-bundle-check');
  assert.ok(browserInfo.executable.includes(packaged ? path.join('resources', 'browsers') : path.join('.cache', 'desktop-browsers')));
  report.browser = browserInfo; pass('内置 Chromium 实际启动');

  const credentialsWork = await desktop.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const path = process.getBuiltinModule('node:path');
    const require = createRequire(path.join(app.getAppPath(), 'package.json'));
    const { systemSecretProtector } = require('./src/credentials.mjs');
    // 只对合成文本验证系统凭据存储，确认内置 Node 可调用当前用户的 Windows DPAPI。
    const protector = systemSecretProtector();
    const fixture = 'desktop-smoke-synthetic-value';
    return protector.unprotect(protector.protect(fixture)) === fixture;
  });
  assert.equal(credentialsWork, true); pass('内置运行时可保存与读取系统保护的凭据');

  for (const view of ['overview', 'dashboard', 'fleet', 'billing', 'notifications', 'ai', 'settings', 'profile', 'updates']) {
    await goView(page, view);
    await page.waitForFunction(view => document.querySelector('[data-view="' + view + '"]').classList.contains('active'), view);
  }
  await goView(page, 'overview');
  await page.screenshot({ path: path.join(output, 'desktop-' + (packaged ? 'packaged' : 'dev') + '.png'), animations: 'disabled' });
  await page.evaluate(() => localStorage.setItem('desktop-smoke-persistence', 'saved'));
  // 通过产品接口保存关闭发送的合成通知凭据，重启后验证真实数据恢复与 DPAPI 解密。
  await page.evaluate(() => api('/api/notifications/settings', { webhookEnabled: false,
    webhookUrl: 'https://synthetic.invalid/desktop-smoke', webhookToken: 'desktop-smoke-synthetic-token',
    wechatEnabled: false, wechatToken: '', rememberCredentials: true }));
  pass('所有页面可打开，现有界面保持不变');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await (await fetch(base + '/api/health')).json()).pid, health.pid);
  pass('关闭窗口隐藏到托盘，后台继续运行');

  // 第二次启动真实 EXE，应激活现有窗口并退出新进程。
  const secondExit = await new Promise((resolve, reject) => {
    const second = spawn(executablePath, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    second.once('error', reject); second.once('exit', resolve);
  });
  assert.equal(secondExit, 0);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  assert.equal((await (await fetch(base + '/api/health')).json()).pid, health.pid);
  pass('重复打开仅激活同一窗口和后台');
  await quit(desktop); desktop = null;
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'server.lock')), false);
  await assert.rejects(fetch(base + '/api/health'));
  pass('菜单退出等待后台关闭并释放运行锁');

  const savedState = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'state.json'), 'utf8'));
  assert.equal(savedState.protectedSecrets.method, 'windows-dpapi-current-user');
  assert.equal(savedState.settings.webhookToken, undefined);
  nativeBase = base;
  const endpoint = await restartNative();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'local-port.json'), 'utf8')).port, Number(new URL(base).port));
  const restartedHealth = await (await fetch(nativeBase + '/api/health')).json();
  assert.equal(restartedHealth.pid, nativeDesktop.pid);
  assert.equal(restartedHealth.ready, true);
  assert.equal(restartedHealth.version, expectedVersion);
  const restartedBrowser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  try {
    const restoredPage = restartedBrowser.contexts()[0].pages().find(candidate => new URL(candidate.url()).origin === base);
    assert.ok(restoredPage, '原生重启需要恢复同一来源的桌面页面');
    assert.equal(await restoredPage.evaluate(() => localStorage.getItem('desktop-smoke-persistence')), 'saved');
  } finally { await restartedBrowser.close(); }
  const restoredState = await (await nativeRequest('/api/state')).json();
  assert.equal(restoredState.settings.rememberCredentials, true);
  assert.equal(restoredState.settings.webhookEnabled, false);
  assert.equal(restoredState.settings.webhookUrl, '***');
  assert.equal(restoredState.settings.webhookToken, '***');
  assert.deepEqual(restoredState.tasks, []);
  pass('原生重启：版本与端口一致，localStorage 与 DPAPI 加密设置恢复，未创建任务');
  await quitNative();
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'server.lock')), false);
  await assert.rejects(fetch(base + '/api/health'));
  pass('原生重启后正常停止桌面进程与后台');
  report.passed = true;
} finally {
  if (desktop) await quit(desktop).catch(() => {});
  if (nativeDesktop && nativeDesktop.exitCode === null) await quitNative().catch(error => console.error('原生测试进程收尾失败：' + error.message));
  fs.writeFileSync(path.join(output, 'desktop-' + (packaged ? 'packaged' : 'dev') + '-report.json'), JSON.stringify(report, null, 2));
}
