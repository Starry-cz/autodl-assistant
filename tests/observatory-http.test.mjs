import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID } from './fixtures/observatory.mjs';

const routes = ['/api/observatory/overview', '/api/observatory/billing'];
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 使用临时运行目录与共享合成数据；不启动引擎，不连接浏览器或 AutoDL。
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-observatory-http-'));
  const adapter = createObservatoryFixtureAdapter();
  let session = { state: 'ready', browserOpen: true, label: '隔离合成会话', checkedAt: Date.now() };
  let reads = 0, forbiddenCalls = 0;
  for (const method of ['observatoryInstances', 'observatoryWallet', 'observatoryMonitor', 'observatoryBills']) {
    const original = adapter[method].bind(adapter);
    adapter[method] = async (...args) => { reads++; return original(...args); };
  }
  const forbidden = async () => { forbiddenCalls++; throw Error('监控只读测试禁止付费操作或外部请求'); };
  Object.assign(adapter, {
    sessionStatus: () => ({ ...session }),
    logout: async () => { session = { state: 'not_open', browserOpen: false }; return { message: '已退出合成会话' }; },
    login: forbidden, checkLogin: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden, boot: forbidden,
  });
  const app = createApplication({ runtimeDir: dir, startEngine: false, adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  t.after(async () => {
    await app.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-observatory-http-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, data, token = app.token) => fetch(base + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { 'X-Local-Token': token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { app, adapter, dir, request, setSession: value => { session = value; },
    get reads() { return reads; }, get forbiddenCalls() { return forbiddenCalls; } };
}

test('看板和账单 HTTP 读取都要求本地令牌及已核验的浏览器会话', async t => {
  const f = await fixture(t);
  for (const route of routes) {
    for (const token of [null, 'synthetic-wrong-local-token']) {
      const response = await f.request(route, {}, token);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'TOKEN');
    }
    for (const session of [{ state: 'not_open', browserOpen: false }, { state: 'expired', browserOpen: true }, { state: 'ready', browserOpen: false }]) {
      f.setSession(session);
      const response = await f.request(route, {});
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'LOGIN_CHECK_REQUIRED');
    }
  }
  assert.equal(f.reads, 0);
  assert.equal(f.forbiddenCalls, 0);
});

test('同步看板和账单仅更新内存缓存，不创建任务或保存账号快照', async t => {
  const f = await fixture(t);
  const overviewResponse = await f.request(routes[0], { targetId: OBSERVATORY_INSTANCE_ID });
  const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200, JSON.stringify(overview));
  assert.ok(overview.overview);
  assert.ok(JSON.stringify(overview.overview).includes(OBSERVATORY_INSTANCE_ID));
  const billingResponse = await f.request(routes[1], {});
  const billing = await billingResponse.json();
  assert.equal(billingResponse.status, 200, JSON.stringify(billing));
  assert.ok(billing.billing);
  const state = await (await f.request('/api/state')).json();
  assert.ok(state.observatory);
  assert.ok(JSON.stringify(state.observatory).includes(OBSERVATORY_INSTANCE_ID));
  assert.equal(f.app.store.tasks().length, 0);
  assert.equal(f.forbiddenCalls, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'state.json')), false);
});

test('正在进行页面操作时看板拒绝并发读取，不抢占已有操作锁', async t => {
  const f = await fixture(t);
  f.app.engine.busy = true;
  try {
    for (const route of routes) {
      const response = await f.request(route, {});
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'BUSY');
    }
    assert.equal(f.reads, 0);
    assert.equal(f.app.engine.busy, true);
  } finally { f.app.engine.busy = false; }

  const entered = gate(), release = gate();
  const original = f.adapter.observatoryInstances.bind(f.adapter);
  f.adapter.observatoryInstances = async options => { entered.resolve(); await release.promise; return original(options); };
  const pending = f.request(routes[0], { targetId: OBSERVATORY_INSTANCE_ID });
  await entered.promise;
  try {
    const concurrent = await f.request(routes[1], {});
    assert.equal(concurrent.status, 409);
    assert.equal((await concurrent.json()).error, 'BUSY');
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(f.app.engine.busy, false);
  assert.equal((await f.request(routes[1], {})).status, 200);
});

test('退出账号清除看板和账单缓存，重新登录不会展示前一次账户数据', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(routes[0], { targetId: OBSERVATORY_INSTANCE_ID })).status, 200);
  assert.equal((await f.request(routes[1], {})).status, 200);
  const reads = f.reads;
  assert.equal((await f.request('/api/browser/logout', {})).status, 200);
  const signedOut = await (await f.request('/api/state')).json();
  assert.equal(signedOut.observatory, null);
  assert.equal(JSON.stringify(f.app.observatory.publicState()).includes(OBSERVATORY_INSTANCE_ID), false);
  f.setSession({ state: 'ready', browserOpen: true });
  const signedIn = await (await f.request('/api/state')).json();
  assert.equal(JSON.stringify(signedIn.observatory).includes(OBSERVATORY_INSTANCE_ID), false);
  assert.equal(f.reads, reads);
  assert.equal(f.app.store.tasks().length, 0);
});

test('监控目标参数和请求方法在任何上游读取前验证', async t => {
  const f = await fixture(t);
  for (const targetId of [[], 3, 'x'.repeat(101)]) {
    const response = await f.request(routes[0], { targetId });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'TARGET');
  }
  for (const route of routes) assert.equal((await f.request(route)).status, 405);
  assert.equal(f.reads, 0);
});
