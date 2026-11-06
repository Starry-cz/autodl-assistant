import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { allowsNotification, createExitController, desktopPaths, exitActivity, navigationKind } from '../desktop/lifecycle.mjs';

test('桌面数据与安装目录分离，测试目录与打包浏览器路径可独立选择', () => {
  const paths = desktopPaths({ appData: path.resolve('profile'), projectRoot: path.resolve('app'), packaged: false });
  assert.equal(paths.userData, path.resolve('profile', 'AutoDL Assistant Desktop'));
  assert.equal(paths.runtime, path.join(paths.userData, 'runtime'));
  assert.equal(paths.browsers, path.resolve('app', '.cache', 'desktop-browsers'));
  const packaged = desktopPaths({ appData: path.resolve('profile'), dataDir: path.resolve('isolated'), projectRoot: path.resolve('app'), packaged: true, resourcesPath: path.resolve('resources') });
  assert.equal(packaged.userData, path.resolve('isolated'));
  assert.equal(packaged.browsers, path.resolve('resources', 'browsers'));
});

test('窗口只能保留本地来源，外链仅允许普通网页，通知仅允许当前本地端口', () => {
  const origin = 'http://127.0.0.1:43210';
  assert.equal(navigationKind(origin + '/?view=overview', origin), 'local');
  assert.equal(navigationKind('https://www.autodl.com/console', origin), 'external');
  for (const url of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'autodl://open', 'not a URL', 'https://user:secret@example.com']) {
    assert.equal(navigationKind(url, origin), 'blocked');
  }
  assert.equal(allowsNotification('notifications', origin, origin), true);
  assert.equal(allowsNotification('notifications', 'http://127.0.0.1:8787', origin), false);
  assert.equal(allowsNotification('notifications', 'https://www.autodl.com', origin), false);
  assert.equal(allowsNotification('camera', origin, origin), false);
});

test('退出确认覆盖活跃任务、待核对任务和正在执行的页面操作', () => {
  const backend = { store: { tasks: () => [{ state: 'watching' }, { state: 'reconciling' }, { state: 'completed' }, { state: 'paused' }] }, engine: { busy: false } };
  assert.deepEqual(exitActivity(backend), { active: 2, busy: false, needsConfirmation: true });
  backend.store.tasks = () => [];
  backend.engine.busy = true;
  assert.deepEqual(exitActivity(backend), { active: 0, busy: true, needsConfirmation: true });
  assert.deepEqual(exitActivity(null), { active: 0, busy: false, needsConfirmation: false });
});

test('取消退出保留后台，后续确认退出等待 close 完成且合并重复请求', async () => {
  let allowExit = false, confirmations = 0, closeCalls = 0, finishClose;
  const events = [];
  const backend = { store: { tasks: () => [{ state: 'watching' }] }, engine: { busy: true }, close: () => {
    closeCalls++;
    return new Promise(resolve => { finishClose = resolve; });
  } };
  const controller = createExitController({
    getBackend: () => backend, confirm: async () => { confirmations++; return allowExit; },
    onStopping: () => events.push('stopping'), onClosed: () => events.push('closed'), onError: assert.ifError,
  });
  assert.equal(await controller.request(), false);
  assert.equal(closeCalls, 0);
  assert.equal(controller.stopping, false);
  allowExit = true;
  const first = controller.request();
  assert.equal(controller.request(), first);
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(controller.stopping, true);
  assert.equal(controller.finished, false);
  assert.deepEqual(events, ['stopping']);
  finishClose();
  assert.equal(await first, true);
  assert.equal(controller.finished, true);
  assert.deepEqual(events, ['stopping', 'closed']);
  assert.equal(await controller.request(), true);
  assert.equal(confirmations, 2);
  assert.equal(closeCalls, 1);
});

test('启动失败退出不弹任务确认，后台关闭失败不会标记为已退出', async () => {
  const failure = new Error('synthetic close failure');
  let reported;
  const backend = { store: { tasks: () => [{ state: 'verifying' }] }, engine: { busy: true }, close: async () => { throw failure; } };
  const controller = createExitController({
    getBackend: () => backend, confirm: () => { throw new Error('不应弹确认'); },
    onStopping: () => {}, onClosed: () => { throw new Error('不能提前退出'); }, onError: error => { reported = error; },
  });
  assert.equal(await controller.request({ prompt: false }), false);
  assert.equal(reported, failure);
  assert.equal(controller.finished, false);
  assert.equal(controller.stopping, false);
});
