import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

const LIST = 'https://www.autodl.com/console/instance/list';
const ready = { consoleReady: true, loginForm: false, humanRequired: false, loading: false };

// 生命周期单测只模拟页面事件，不启动可见窗口，不读取任何真实浏览器资料。
function fixture() {
  const adapter = new AutoDLBrowserAdapter('unused-isolated-worker-profile');
  const launches = [], contexts = [];
  let signal = ready, ownerId = 'synthetic-owner-a', failure = false;
  const makePage = context => {
    const page = new EventEmitter();
    let closed = false, url = 'about:blank';
    Object.assign(page, {
      isClosed: () => closed, url: () => url,
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      goto: async target => { url = target; page.navigations++; return { status: () => 200 }; },
      waitForLoadState: async () => {}, evaluate: async () => signal,
      bringToFront: async () => { page.fronts++; }, navigations: 0, fronts: 0,
      close: async () => { closed = true; page.emit('close'); },
    });
    context.tabs.push(page);
    return page;
  };
  adapter.launchContext = async mode => {
    if (failure) throw Error('synthetic launch failure');
    // 同一资料目录必须先关闭旧进程；测试会拒绝并存的两个 context。
    assert.ok(contexts.every(context => context.closed));
    launches.push(mode);
    const context = new EventEmitter();
    Object.assign(context, { tabs: [], closed: false, pages: () => context.tabs,
      newPage: async () => makePage(context),
      close: async () => {
        for (const page of context.tabs) await page.close();
        context.closed = true;
        context.emit('close');
      } });
    contexts.push(context);
    return context;
  };
  adapter.readIdentity = async () => ({ ownerId });
  return { adapter, launches, contexts, setSignal: value => { signal = value; },
    setOwner: value => { ownerId = value; }, failLaunch: () => { failure = true; } };
}

test('登录核验成功后同 profile 顺序关闭登录窗口并移交后台，重复检查不重启', async () => {
  const f = fixture(), a = f.adapter;
  await a.browser('login');
  await a.page.goto(LIST);
  const oldContext = a.context;
  a.prepared = { synthetic: true }; a.probed = { synthetic: true }; a.cloneCache = { synthetic: true };
  const result = await a.checkLogin();
  assert.deepEqual(f.launches, ['login', 'background']);
  assert.equal(oldContext.closed, true);
  assert.notEqual(a.context, oldContext);
  assert.equal(result.session.state, 'ready');
  assert.equal(result.session.browserOpen, true);
  assert.equal(result.session.background, true);
  assert.equal(result.session.loginWindowOpen, false);
  assert.equal(a.prepared, null); assert.equal(a.probed, null); assert.equal(a.cloneCache, null);
  const worker = a.context;
  await a.checkLogin();
  assert.equal(a.context, worker);
  assert.deepEqual(f.launches, ['login', 'background']);
  assert.ok(worker.tabs.every(page => page.fronts === 0));
  // 延迟到达的旧 context 事件不能清掉新工作浏览器。
  oldContext.emit('close');
  assert.equal(a.context, worker);
  assert.equal(a.sessionStatus().state, 'ready');
  await a.close();
  assert.equal(a.sessionStatus().browserOpen, false);
  assert.equal(a.sessionStatus().background, false);
});

test('人工验证保留原登录页，后台过期不会自行弹窗，用户打开登录才切回可见模式', async () => {
  const f = fixture(), a = f.adapter;
  await a.browser('login'); await a.page.goto(LIST);
  f.setSignal({ ...ready, humanRequired: true });
  const loginPage = a.page, navigationCount = loginPage.navigations;
  for (let i = 0; i < 2; i++) assert.equal((await a.checkLogin()).session.state, 'human_required');
  assert.deepEqual(f.launches, ['login']);
  assert.equal(a.page, loginPage);
  assert.equal(loginPage.navigations, navigationCount);
  f.setSignal(ready);
  await a.checkLogin();
  const worker = a.context;
  f.setSignal({ ...ready, loginForm: true });
  const expired = await a.checkLogin();
  assert.equal(expired.session.state, 'expired');
  assert.equal(expired.session.background, true);
  assert.deepEqual(f.launches, ['login', 'background']);
  await a.login();
  assert.equal(worker.closed, true);
  assert.equal(a.sessionStatus().loginWindowOpen, true);
  assert.equal(a.sessionStatus().background, false);
  assert.deepEqual(f.launches, ['login', 'background', 'login']);
  await a.close();
});

test('移交后账号变化、登录证据消失或工作浏览器启动失败均不能保持 ready', async () => {
  for (const failure of ['owner', 'session', 'launch']) {
    const f = fixture(), a = f.adapter;
    await a.browser('login'); await a.page.goto(LIST);
    const originalClose = a.context.close;
    a.context.close = async () => {
      await originalClose();
      if (failure === 'owner') f.setOwner('synthetic-owner-b');
      if (failure === 'session') f.setSignal({ ...ready, loginForm: true });
      if (failure === 'launch') f.failLaunch();
    };
    const result = await a.checkLogin();
    assert.notEqual(result.session.state, 'ready', failure);
    assert.equal(result.session.loginWindowOpen, false);
    assert.match(result.message, /账号入口/);
    if (failure !== 'session') assert.match(result.message, /后台连接未完成/);
    if (failure === 'launch') assert.equal(result.session.browserOpen, false);
    await a.close();
  }
});

test('有效的已保存会话直接在后台连接，不创建可见登录窗口', async () => {
  const f = fixture();
  assert.equal((await f.adapter.login()).session.state, 'ready');
  assert.deepEqual(f.launches, ['background']);
  assert.equal(f.adapter.sessionStatus().background, true);
  await f.adapter.login();
  assert.deepEqual(f.launches, ['background']);
  await f.adapter.close();
});

test('真实隔离持久 context 保存合成登录，移交与服务重启后仍可只在后台核验', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autodl-worker-browser-'));
  const adapters = [], launches = [];
  const html = `<!doctype html><meta charset="UTF-8"><body><script>
    document.body.innerHTML = localStorage.getItem('token') === 'synthetic-worker-token'
      ? '<h1>容器实例</h1><table><thead><tr><th>实例 ID</th><th>状态</th></tr></thead></table><div class="el-table__empty-text">暂无实例</div>'
      : '<h1>账号登录</h1><input type="password"><button>登录</button>';
  </script></body>`;
  const createAdapter = () => {
    const adapter = new AutoDLBrowserAdapter(dir);
    adapters.push(adapter);
    adapter.launchContext = async mode => {
      launches.push(mode);
      // 验收本身不显示任何系统窗口；记录产品请求的模式，实际两端都用隔离 headless 浏览器。
      const context = await AutoDLBrowserAdapter.prototype.launchContext.call(adapter, 'background');
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'https://www.autodl.com') return route.abort();
        if (url.pathname === '/api/v1/user/detail') return route.fulfill({ contentType: 'application/json',
          body: JSON.stringify({ code: 'Success', data: { uuid: 'synthetic-worker-account', username: '合成后台账号' } }) });
        if (url.pathname === '/console/instance/list') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        return route.abort();
      });
      return context;
    };
    return adapter;
  };
  t.after(async () => {
    for (const adapter of adapters) await adapter.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-worker-browser-'));
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const adapter = createAdapter();
  const initial = await adapter.login();
  assert.equal(initial.session.loginWindowOpen, true);
  const loginContext = adapter.context;
  // 只写预先定义的合成认证到临时资料目录；不会读取或复制用户现有凭据。
  await adapter.page.evaluate(() => {
    localStorage.setItem('token', 'synthetic-worker-token');
    localStorage.setItem('user', '{}');
  });
  await adapter.page.reload();
  const result = await adapter.checkLogin();
  assert.equal(result.session.state, 'ready');
  assert.equal(result.session.background, true);
  assert.equal(result.session.loginWindowOpen, false);
  assert.ok(loginContext.pages().length === 0 || loginContext.pages().every(page => page.isClosed()));
  assert.equal((await adapter.readIdentity()).accountId, 'synthetic-worker-account');
  const worker = adapter.context;
  await adapter.checkLogin();
  assert.equal(adapter.context, worker);
  assert.deepEqual(launches, ['background', 'login', 'background']);
  await adapter.close();
  const restarted = createAdapter();
  const restored = await restarted.login();
  assert.equal(restored.session.state, 'ready');
  assert.equal(restored.session.background, true);
  assert.equal((await restarted.readIdentity()).accountId, 'synthetic-worker-account');
  assert.deepEqual(launches, ['background', 'login', 'background', 'background']);
  await restarted.logout();
  assert.equal(restarted.sessionStatus().browserOpen, false);
  await assert.rejects(fs.access(restarted.profileDir), error => error.code === 'ENOENT');
});
