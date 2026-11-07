import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { createApplication } from '../src/server.mjs';
import { normalizeAccountIdentity } from '../src/account-scope.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { testConfig } from './fixtures/config.mjs';
import { offlineUpdateOptions } from './fixtures/updates.mjs';
import { gate } from './helpers.mjs';

const owner = id => normalizeAccountIdentity({ accountId: id, kind: 'main', displayName: '升级隔离账号' });
const A = owner('upgrade-synthetic-A'), B = owner('upgrade-synthetic-B');

// 仅使用临时状态与合成会话，任何付费或交互登录调用都使验收失败。
async function setup(t, { restoredOwner = A, sessionState = 'ready', blocked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-upgrade-session-'));
  const disk = new Store(dir);
  disk.data.accountOwnerId = A.ownerId;
  const waiting = disk.create(testConfig({ action: 'observe' }), { ownerId: A.ownerId });
  const paused = disk.create(testConfig({ action: 'observe' }), { ownerId: A.ownerId });
  disk.patch(paused, { state: 'paused' });
  const gateReady = gate();
  if (!blocked) gateReady.resolve();
  let session = 'not_open', probes = 0, opens = 0;
  const adapter = new SyntheticAdapter({ availableAfter: 9999 });
  const probe = adapter.probe.bind(adapter);
  Object.assign(adapter, {
    browser: async mode => { assert.equal(mode, 'background'); opens++; return {}; },
    checkLogin: async () => { await gateReady.promise; session = sessionState; return { session: adapter.sessionStatus() }; },
    restoreSession: async () => { await adapter.browser('background'); return adapter.checkLogin(); },
    sessionStatus: () => ({ state: session, browserOpen: session !== 'not_open' }),
    readIdentity: async () => restoredOwner,
    probe: async task => { probes++; return probe(task); },
    login: async () => { throw Error('升级恢复不得弹出交互登录'); },
    submit: async () => { throw Error('升级验收禁止付费'); },
    boot: async () => { throw Error('升级验收禁止开机'); },
  });
  const app = createApplication({ runtimeDir: dir, restoreSession: true, adapters: { autodl: adapter },
    updatesOptions: offlineUpdateOptions, fingerprint: () => 'upgrade-session-fixture' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    gateReady.resolve();
    await app.ready;
    await app.close();
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('autodl-upgrade-session-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { app, disk, waiting, paused, base, gateReady, get probes() { return probes; }, get opens() { return opens; } };
}

test('升级交接先恢复同账号会话，再启动监测；不改暂停状态和原截止时间', async t => {
  const f = await setup(t, { blocked: true });
  const before = await (await fetch(f.base + '/api/health')).json();
  assert.equal(before.ready, false);
  const reconnect = await fetch(f.base + '/api/browser/open', { method: 'POST', headers: { 'X-Local-Token': f.app.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reconnect.status, 409, '会话恢复期间不能同时打开另一份浏览器连接');
  assert.equal((await reconnect.json()).error, 'BUSY');
  // 超过一个引擎tick周期，身份仍未恢复时不能开始监测或自动把等待任务暂停。
  await delay(600);
  assert.equal(f.probes, 0);
  assert.equal(f.app.store.get(f.waiting.id).state, 'watching');
  f.gateReady.resolve();
  await f.app.ready;
  assert.equal((await (await fetch(f.base + '/api/health')).json()).ready, true);
  await f.app.engine.tick();
  assert.ok(f.probes > 0);
  assert.equal(f.opens, 1);
  assert.equal(f.app.store.get(f.waiting.id).state, 'watching');
  assert.equal(f.app.store.get(f.waiting.id).deadlineAt, f.waiting.deadlineAt);
  assert.equal(f.app.store.get(f.paused.id).state, 'paused');
});

test('升级恢复发现另一个账号时暂停原任务，不继续检查库存或自动下单', async t => {
  const f = await setup(t, { restoredOwner: B });
  await f.app.ready;
  await f.app.engine.tick();
  assert.equal(f.probes, 0);
  assert.equal(f.app.store.get(f.waiting.id).state, 'paused');
  assert.equal(f.app.store.get(f.paused.id).state, 'paused');
  assert.equal(f.app.store.data.accountOwnerId, A.ownerId);
});

test('升级恢复遇会话失效时保留数据并暂停等待任务，不弹登录窗口', async t => {
  const f = await setup(t, { sessionState: 'expired' });
  await f.app.ready;
  await f.app.engine.tick();
  assert.equal(f.probes, 0);
  assert.equal(f.app.store.get(f.waiting.id).state, 'paused');
  assert.equal(f.app.store.get(f.waiting.id).ownerId, A.ownerId);
  assert.equal(f.app.store.get(f.waiting.id).deadlineAt, f.waiting.deadlineAt);
  assert.equal(f.app.store.get(f.paused.id).state, 'paused');
});

test('再次更新准备失败时显示本次失败，不被上次更新成功记录覆盖', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-upgrade-session-'));
  fs.writeFileSync(path.join(dir, 'upgrade-status.json'), JSON.stringify({ status: 'complete', targetVersion: '1.0.0', message: '上一次成功' }));
  const repository = 'https://github.com/Starry-cz/autodl-assistant';
  const release = { tag_name: 'v99.0.0', html_url: repository + '/releases/tag/v99.0.0', draft: false, prerelease: false,
    assets: [{ name: 'autodl-assistant-v99.0.0.zip', state: 'uploaded', browser_download_url: repository + '/releases/download/v99.0.0/autodl-assistant-v99.0.0.zip' }] };
  const app = createApplication({ runtimeDir: dir, startEngine: false, adapters: { autodl: new SyntheticAdapter() },
    updatesOptions: { fetchImpl: async () => new Response(JSON.stringify(release)) },
    onInstallUpdate: async () => { throw Error('本次合成下载失败'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('autodl-upgrade-session-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  await app.updates.check();
  const started = await fetch(base + '/api/updates/install', { method: 'POST', headers: { 'X-Local-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.installation.status, 'error');
  assert.equal(health.installation.targetVersion, '99.0.0');
  assert.match(health.installation.message, /本次合成下载失败/);
});

test('磁盘页面更新后旧后台仍提供原资源，切换后台后才提供新版资源', async t => {
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-upgrade-session-'));
  // 拷贝最小项目到临时目录，绝不改动正在运行的工作区页面。
  for (const name of ['src', 'public']) fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const copied = await import(pathToFileURL(path.join(dir, 'src/server.mjs')).href);
  let app;
  const start = async () => {
    app = copied.createApplication({ runtimeDir: path.join(dir, '.runtime'), startEngine: false,
      adapters: { autodl: new SyntheticAdapter() }, updatesOptions: offlineUpdateOptions });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + app.server.address().port;
  };
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('autodl-upgrade-session-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const before = await start();
  const original = await (await fetch(before + '/app.js')).text();
  const appended = '\n// synthetic-new-version-resource\n';
  fs.appendFileSync(path.join(dir, 'public/app.js'), appended);
  assert.equal(await (await fetch(before + '/app.js')).text(), original);
  assert.equal((await (await fetch(before + '/api/health')).json()).codeChanged, true);
  await app.close();
  const after = await start();
  assert.equal(await (await fetch(after + '/app.js')).text(), original + appended);
});

test('下载期间产生待核对提交时取消交接并恢复旧引擎，不丢失提交记录', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-upgrade-session-'));
  const download = gate(), handoff = gate();
  let switched = false;
  const repository = 'https://github.com/Starry-cz/autodl-assistant';
  const release = { tag_name: 'v99.0.0', html_url: repository + '/releases/tag/v99.0.0', draft: false, prerelease: false,
    assets: [{ name: 'autodl-assistant-v99.0.0.zip', state: 'uploaded', browser_download_url: repository + '/releases/download/v99.0.0/autodl-assistant-v99.0.0.zip' }] };
  const app = createApplication({ runtimeDir: dir, adapters: { autodl: new SyntheticAdapter() },
    updatesOptions: { fetchImpl: async () => new Response(JSON.stringify(release)) },
    onInstallUpdate: async ({ quiesce }) => {
      try { await download.promise; await quiesce(); switched = true; }
      finally { handoff.resolve(); }
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    download.resolve(); await handoff.promise; await app.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('autodl-upgrade-session-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  await app.updates.check();
  const started = await fetch(base + '/api/updates/install', { method: 'POST', headers: { 'X-Local-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  // 模拟原任务在下载结束前已提交，但平台结果仍待核对；下一次检查尚未到期。
  const task = app.store.create(testConfig({ action: 'observe' }), { ownerId: B.ownerId });
  const operation = { stage: 'click_started', clickedAt: Date.now() };
  app.store.patch(task, { state: 'verifying', operation, nextCheckAt: Date.now() + 60000 });
  download.resolve(); await handoff.promise;
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(switched, false);
  assert.equal(health.installation.status, 'error');
  assert.match(health.installation.message, /提交或结果核对/);
  assert.equal(app.engine.stopping, false, '交接取消后必须继续使用原后台引擎');
  assert.ok(app.engine.timer);
  assert.deepEqual(app.store.get(task.id).operation, operation);
  assert.equal(app.store.get(task.id).state, 'verifying');
});
