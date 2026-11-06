import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packaged = Boolean(process.argv[2]);
const executablePath = packaged ? path.resolve(process.argv[2]) : require('electron');
const args = packaged ? [] : [root];
const loader = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib', 'server', 'electron', 'loader.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-desktop-check-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
// 测试使用全新账号目录，并移除全局 Node 与浏览器路径；不接触真实 8787 或 AutoDL 账号。
fs.writeFileSync(path.join(dataDir, 'tray-hint-shown'), '');
const env = { ...process.env, AUTODL_DESKTOP_DATA_DIR: dataDir, AUTODL_BROWSER_CHANNEL: 'not-a-real-channel', PLAYWRIGHT_BROWSERS_PATH: path.join(dataDir, 'missing-browser-cache') };
for (const key of Object.keys(env)) if (/^path$/i.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
env.Path = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
const report = { packaged, executablePath, dataDir, checks: [], passed: false };
let desktop;
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
  await instance.evaluate(({ Menu }) => { setTimeout(() => Menu.getApplicationMenu().getMenuItemById('desktop-quit').click(), 0); });
  await closed;
}

try {
  let started = await start(); desktop = started.instance; let page = started.page;
  const info = await desktop.evaluate(({ app }) => ({ userData: app.getPath('userData'), appPath: app.getAppPath(), version: app.getVersion(), node: process.versions.node, electron: process.versions.electron, packaged: app.isPackaged }));
  assert.equal(info.userData, dataDir); assert.equal(info.version, '1.1.0'); assert.equal(info.packaged, packaged);
  report.runtime = info;
  const base = new URL(page.url()).origin;
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.runtimeDir, path.join(dataDir, 'runtime')); assert.notEqual(new URL(base).port, '8787');
  pass('内置 Node 启动独立本地服务');

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

  for (const view of ['overview', 'dashboard', 'fleet', 'billing', 'notifications', 'ai', 'settings', 'profile']) {
    await page.locator('[data-view="' + view + '"]').first().click();
    await page.waitForFunction(view => document.querySelector('[data-view="' + view + '"]').classList.contains('active'), view);
  }
  await page.locator('[data-view="overview"]').first().click();
  await page.screenshot({ path: path.join(output, 'desktop-' + (packaged ? 'packaged' : 'dev') + '.png'), animations: 'disabled' });
  await page.evaluate(() => localStorage.setItem('desktop-smoke-persistence', 'saved'));
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

  started = await start(); desktop = started.instance; page = started.page;
  assert.equal(await page.evaluate(() => localStorage.getItem('desktop-smoke-persistence')), 'saved');
  pass('再次打开保留桌面用户数据');
  await quit(desktop); desktop = null;
  report.passed = true;
} finally {
  if (desktop) await quit(desktop).catch(() => {});
  fs.writeFileSync(path.join(output, 'desktop-' + (packaged ? 'packaged' : 'dev') + '-report.json'), JSON.stringify(report, null, 2));
}
