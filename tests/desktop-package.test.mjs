import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../desktop/build-config.cjs';
import { desktopBrowserPreparation, prepareDesktop } from '../scripts/prepare-desktop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('桌面构建采用匹配 Playwright 的完整 Chromium，缓存与账号资料隔离', () => {
  const env = { PATH: 'test-path', PLAYWRIGHT_BROWSERS_PATH: 'user-browser-cache' };
  const prep = desktopBrowserPreparation({ projectRoot: root, platform: 'win32', arch: 'x64', env, execPath: 'test-node' });
  assert.equal(prep.command, 'test-node');
  assert.equal(prep.installArgs[0], path.join(root, 'node_modules', 'playwright', 'cli.js'));
  assert.deepEqual(prep.installArgs.slice(1), ['install', 'chromium', '--no-shell']);
  assert.equal(prep.options.env.PLAYWRIGHT_BROWSERS_PATH, path.join(root, '.cache', 'desktop-browsers'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, 'user-browser-cache');
});

test('未验证的平台在下载前明确停止', async () => {
  for (const target of [{ platform: 'linux', arch: 'x64' }, { platform: 'win32', arch: 'arm64' }, { platform: 'win32', arch: 'ia32' }]) {
    let invoked = false;
    await assert.rejects(prepareDesktop({ ...target, run: async () => { invoked = true; }, log() {} }), /Windows x64/);
    assert.equal(invoked, false);
  }
});

test('下载失败不会继续验证或报告准备成功', async () => {
  const messages = [];
  let runs = 0;
  await assert.rejects(prepareDesktop({ platform: 'win32', arch: 'x64', log: value => messages.push(value),
    run: async () => { runs++; throw new Error('download unavailable'); } }), /download unavailable/);
  assert.equal(runs, 1);
  assert.equal(messages.some(value => value.includes('准备完成')), false);
});

test('浏览器缺失时不把已有空缓存误报成构建成功', async () => {
  let runs = 0;
  const messages = [];
  await assert.rejects(prepareDesktop({ platform: 'win32', arch: 'x64', log: value => messages.push(value),
    run: async () => { if (++runs === 2) throw new Error('Chrome executable missing'); } }), /Chrome executable missing/);
  assert.equal(runs, 2);
  assert.equal(messages.some(value => value.includes('准备完成')), false);
});

test('安装器为不提权的完整离线包，快捷方式与发布选项明确', () => {
  assert.equal(config.appId, 'com.starrycz.autodlassistant');
  assert.equal(config.asar, false);
  assert.equal(config.publish, null);
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }]);
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.packElevateHelper, false);
  assert.equal(config.nsis.differentialPackage, false);
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.shortcutName, 'AutoDL助手桌面版');
});

test('包内容只包含应用代码与专用浏览器缓存，不包含本机运行资料', () => {
  assert.deepEqual(config.files, ['src/**/*', 'public/**/*', 'desktop/*.mjs', 'desktop/assets/icon.png', 'package.json', 'LICENSE']);
  assert.equal(config.extraResources.length, 1);
  assert.equal(config.extraResources[0].from, '.cache/desktop-browsers');
  assert.equal(config.extraResources[0].to, 'browsers');
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.directories.output, 'output/desktop');
});
