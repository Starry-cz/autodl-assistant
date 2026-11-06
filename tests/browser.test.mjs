import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBrowserLaunchOptions } from '../src/browser.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

const chromium = { executablePath: () => 'C:\\Synthetic Cache\\chromium\\chrome.exe' };
const env = { ProgramFiles: 'C:\\Synthetic Program Files', 'ProgramFiles(x86)': 'C:\\Synthetic Program Files (x86)', LOCALAPPDATA: 'C:\\Synthetic User\\本机应用' };
const missing = () => { throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' }); };
const accessFor = files => async file => { if (!files.includes(file)) missing(); };

// 仅模拟安装位置，不读取真实用户会话或打开 AutoDL。
test('显式浏览器通道优先，且不改用其他已安装浏览器', async () => {
  const result = await resolveBrowserLaunchOptions(chromium, { env: { ...env, AUTODL_BROWSER_CHANNEL: 'chrome' }, platform: 'win32', access: () => { throw Error('不应探测其他安装'); } });
  assert.deepEqual(result, { channel: 'chrome' });
});

test('已有 Playwright 完整 Chromium 时优先使用同一通道', async () => {
  const result = await resolveBrowserLaunchOptions(chromium, { env, platform: 'win32', access: accessFor([chromium.executablePath()]) });
  assert.deepEqual(result, { channel: 'chromium' });
});

for (const [label, relative] of [['Edge', ['Microsoft', 'Edge', 'Application', 'msedge.exe']], ['Chrome', ['Google', 'Chrome', 'Application', 'chrome.exe']]]) {
  for (const root of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    test('没有缓存时发现 ' + label + ' 的 ' + root + ' 安装位置', async () => {
      const executablePath = path.win32.join(env[root], ...relative);
      const result = await resolveBrowserLaunchOptions(chromium, { env, platform: 'win32', access: accessFor([executablePath]) });
      assert.deepEqual(result, { executablePath });
    });
  }
}

test('未安装浏览器时给出可用于首次安装的明确错误', async () => {
  await assert.rejects(resolveBrowserLaunchOptions(chromium, { env, platform: 'win32', access: missing }), error => error.code === 'BROWSER_MISSING' && error.message.includes('npm.cmd run browser:install'));
});

test('非 Windows 平台不探测 Windows 安装位置', async () => {
  const checked = [];
  await assert.rejects(resolveBrowserLaunchOptions(chromium, { env, platform: 'linux', access: file => { checked.push(file); missing(); } }), { code: 'BROWSER_MISSING' });
  assert.deepEqual(checked, [chromium.executablePath()]);
});

test('安装位置访问异常不冒充未安装', async () => {
  await assert.rejects(resolveBrowserLaunchOptions(chromium, { env, platform: 'win32', access: () => { throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' }); } }), { code: 'EACCES' });
});

test('账号浏览器保留预检的安装指引', async () => {
  const adapter = new AutoDLBrowserAdapter('synthetic-browser-missing');
  adapter.launchContext = () => resolveBrowserLaunchOptions(chromium, { env, platform: 'win32', access: missing });
  await assert.rejects(adapter.browser(), error => error.code === 'BROWSER_MISSING' && error.message.includes('browser:install'));
  assert.equal(adapter.sessionStatus().state, 'error');
});
