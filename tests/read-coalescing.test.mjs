import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { normalizeAccountIdentity } from '../src/account-scope.mjs';
import { AppError } from '../src/errors.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID, OBSERVATORY_RUNNING_ID } from './fixtures/observatory.mjs';
import { SYNTHETIC_GPU_CATALOG } from './fixtures/gpu-catalog.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const account = letter => normalizeAccountIdentity({ accountId: 'synthetic-coalescing-' + letter,
  subAccountId: null, kind: 'main', displayName: '合成账号 ' + letter });
const ACCOUNT_A = account('A'), ACCOUNT_B = account('B');
const GPU_ROUTE = '/api/autodl/gpus', HOST_ROUTE = '/api/market/hosts';

// 真实本地 HTTP + 内存适配器：不启动引擎或浏览器，所有付费方法和外部请求均禁止执行。
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-coalescing-'));
  const adapter = createObservatoryFixtureAdapter(), counts = {}, blocks = new Map();
  let current = ACCOUNT_A, session = { state: 'ready', browserOpen: true }, forbiddenCalls = 0, stamp = Date.now();
  const forbidden = async () => { forbiddenCalls++; throw Error('合成合并测试禁止浏览器、付费及外部请求'); };
  Object.assign(adapter, {
    sessionStatus: () => ({ ...session }),
    readIdentity: async () => ({ ...current }),
    checkLogin: async () => { session = { state: 'ready', browserOpen: true }; return { session: { ...session } }; },
    logout: async () => { session = { state: 'not_open', browserOpen: false }; return { message: '合成账号已退出' }; },
    gpuCatalog: async () => ({ ...structuredClone(SYNTHETIC_GPU_CATALOG), checkedAt: ++stamp }),
    marketHosts: async query => ({ checkedAt: ++stamp, complete: true, rows: [{ hostId: 'synthetic-host', ...query }] }),
    imageOptions: async prefix => ({ prefix, options: ['合成镜像'], checkedAt: ++stamp }),
    browser: forbidden, login: forbidden, probe: forbidden, prepare: forbidden, submit: forbidden, boot: forbidden,
  });
  for (const method of ['readIdentity', 'checkLogin', 'logout', 'gpuCatalog', 'marketHosts', 'imageOptions',
    'observatoryInstances', 'observatoryWallet', 'observatoryMonitor', 'observatoryBills']) {
    const original = adapter[method].bind(adapter);
    counts[method] = 0;
    adapter[method] = async (...args) => {
      counts[method]++;
      const block = blocks.get(method);
      if (block) { block.entered.resolve(); await block.release.promise; if (block.error) throw block.error; }
      return original(...args);
    };
  }
  const app = createApplication({ runtimeDir: dir, startEngine: false, adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden }, imageBusyWaitMs: 2000 });
  t.after(async () => {
    for (const block of blocks.values()) block.release.resolve();
    await app.close();
    assert.equal(forbiddenCalls, 0);
    assert.equal(app.store.tasks().length, 0);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('autodl-coalescing-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body = {}, localToken = app.token) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(localToken ? { 'X-Local-Token': localToken } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const connect = async (next = current) => {
    current = next;
    const result = await request('/api/browser/check');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.account.ownerId, next.ownerId);
  };
  const hold = (method, error = null) => {
    const block = { entered: gate(), release: gate(), error }; blocks.set(method, block);
    return { entered: block.entered.promise, release() { blocks.delete(method); block.release.resolve(); } };
  };
  // 用请求体读完的事件屏障保证五个请求确实同时在途，不依赖网络快慢或任意睡眠。
  const batch = async (route, bodies, block) => {
    let received = 0; const arrived = gate();
    const listener = req => { if (req.url === route) req.once('end', () => { if (++received === bodies.length) arrived.resolve(); }); };
    app.server.on('request', listener);
    const pending = bodies.map(body => request(route, body));
    await Promise.all([arrived.promise, block.entered]); await turn();
    app.server.off('request', listener);
    return { pending, finish: async () => { block.release(); return Promise.all(pending); } };
  };
  await connect();
  let saves = 0, samples = 0, gaps = 0;
  const save = app.store.save.bind(app.store), record = app.market.record.bind(app.market), recordGap = app.market.recordGap.bind(app.market);
  app.store.save = (...args) => { saves++; return save(...args); };
  app.market.record = (...args) => { samples++; return record(...args); };
  app.market.recordGap = (...args) => { gaps++; return recordGap(...args); };
  return { app, adapter, counts, request, connect, hold, batch, setAccount: value => { current = value; },
    get saves() { return saves; }, get samples() { return samples; }, get gaps() { return gaps; } };
}

const cases = [
  { name: 'GPU 目录', route: GPU_ROUTE, method: 'gpuCatalog', bodies: [{}, {}, {}, {}, {}] },
  { name: '主机明细', route: HOST_ROUTE, method: 'marketHosts', bodies: Array.from({ length: 5 }, (_, i) => ({ model: i % 2 ? ' RTX 4090 ' : 'RTX 4090', region: '北京B区' })) },
  { name: '镜像菜单', route: '/api/autodl/images', method: 'imageOptions', bodies: Array.from({ length: 5 }, (_, i) => ({ prefix: [i % 2 ? ' PyTorch ' : 'PyTorch'] })) },
  { name: '实例看板', route: '/api/observatory/overview', method: 'observatoryInstances', bodies: Array.from({ length: 5 }, () => ({ targetId: OBSERVATORY_INSTANCE_ID })) },
  { name: '账单', route: '/api/observatory/billing', method: 'observatoryBills', bodies: [{}, {}, {}, {}, {}] },
];
for (const item of cases) test(item.name + '五个同查询共享一次读取，完成后不复用旧结果', async t => {
  const f = await fixture(t), beforeIdentity = f.counts.readIdentity;
  const block = f.hold(item.method), batch = await f.batch(item.route, item.bodies, block);
  assert.equal(f.counts[item.method], 1);
  assert.equal(f.app.engine.busy, true);
  const results = await batch.finish();
  for (const result of results) { assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result, results[0]); }
  assert.equal(f.counts[item.method], 1);
  assert.equal(f.counts.readIdentity - beforeIdentity, 2, '共享工作仍完成读取前后两次身份核验');
  assert.equal(f.app.engine.busy, false);
  if (item.route === GPU_ROUTE) {
    assert.equal(f.saves, 1); assert.equal(f.samples, 1); assert.equal(f.gaps, 0);
    assert.equal(f.app.market.history.length, 1);
  }
  assert.equal((await f.request(item.route, item.bodies[0])).status, 200);
  assert.equal(f.counts[item.method], 2, '没有 TTL 缓存，下一次请求必须重新读取');
  if (item.route === GPU_ROUTE) { assert.equal(f.saves, 2); assert.equal(f.samples, 2); assert.equal(f.app.market.history.length, 2); }
});

test('同一失败只记录一个库存缺口，失败结算后下一次可重新读取', async t => {
  const f = await fixture(t), block = f.hold('gpuCatalog', new AppError('SYNTHETIC_READ', '合成目录读取失败', { status: 502 }));
  const batch = await f.batch(GPU_ROUTE, Array.from({ length: 5 }, () => ({})), block);
  const results = await batch.finish();
  assert.ok(results.every(result => result.status === 502 && result.body.error === 'SYNTHETIC_READ'));
  assert.equal(f.counts.gpuCatalog, 1); assert.equal(f.saves, 0); assert.equal(f.samples, 0); assert.equal(f.gaps, 1);
  assert.equal(f.app.market.history.length, 1); assert.equal(f.app.market.history[0].complete, false);
  assert.equal((await f.request(GPU_ROUTE)).status, 200);
  assert.equal(f.counts.gpuCatalog, 2); assert.equal(f.samples, 1); assert.equal(f.gaps, 1);
});

test('不同主机条件、看板目标及读取路由不合并，也不越过原页面锁', async t => {
  const f = await fixture(t);
  for (const item of [
    { route: HOST_ROUTE, method: 'marketHosts', first: { model: 'RTX 4090', region: '北京B区' }, other: { model: 'RTX 3090', region: '北京B区' } },
    { route: HOST_ROUTE, method: 'marketHosts', first: { model: 'RTX 4090' }, other: { model: 'RTX 4090', region: '北京B区' } },
    { route: '/api/observatory/overview', method: 'observatoryInstances', first: { targetId: OBSERVATORY_INSTANCE_ID }, other: { targetId: OBSERVATORY_RUNNING_ID } },
  ]) {
    const block = f.hold(item.method), pending = f.request(item.route, item.first); await block.entered;
    const different = await f.request(item.route, item.other), otherRoute = await f.request('/api/observatory/billing');
    assert.equal(different.status, 409); assert.equal(different.body.error, 'BUSY');
    assert.equal(otherRoute.status, 409); assert.equal(otherRoute.body.error, 'BUSY');
    block.release(); assert.equal((await pending).status, 200);
    assert.equal((await f.request(item.route, item.other)).status, 200);
  }
});

test('不同镜像前缀独立等待页面锁，返回各自的查询结果', async t => {
  const f = await fixture(t), block = f.hold('imageOptions');
  const first = f.request('/api/autodl/images', { prefix: ['PyTorch'] }); await block.entered;
  const second = f.request('/api/autodl/images', { prefix: ['TensorFlow'] });
  block.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(f.counts.imageOptions, 2);
  assert.deepEqual(a.body.prefix, ['PyTorch']); assert.deepEqual(b.body.prefix, ['TensorFlow']);
});

test('连续到期任务之间让已排队的用户读取先执行，释放后继续监测', async t => {
  const f = await fixture(t), firstEntered = gate(), firstRelease = gate(), secondEntered = gate(), events = [];
  const originalTasks = f.app.store.tasks.bind(f.app.store), originalImage = f.adapter.imageOptions;
  const jobs = [0, 1].map(id => ({ id, config: { provider: 'autodl' }, state: 'watching', nextCheckAt: Date.now() }));
  // 调度测试只替换任务读取，不写入任何租用任务；HTTP 镜像读取仍走服务端真实页面锁。
  f.app.store.tasks = () => jobs;
  f.adapter.imageOptions = async (...args) => { events.push('image'); return originalImage(...args); };
  f.app.engine.step = async task => {
    events.push('task-' + task.id);
    if (task.id === 0) { firstEntered.resolve(); await firstRelease.promise; }
    else secondEntered.resolve();
    task.state = 'found';
  };
  try {
    f.app.engine.start(); await firstEntered.promise;
    const arrived = gate();
    const listener = req => { if (req.url === '/api/autodl/images') req.once('end', arrived.resolve); };
    f.app.server.on('request', listener);
    const reading = f.request('/api/autodl/images', { prefix: ['PyTorch'] });
    await arrived.promise; await turn(); f.app.server.off('request', listener);
    assert.equal(f.app.engine.browserWaiters, 1);
    firstRelease.resolve();
    assert.equal((await reading).status, 200);
    await secondEntered.promise;
    assert.deepEqual(events, ['task-0', 'image', 'task-1']);
  } finally {
    firstRelease.resolve(); await f.app.engine.stop(); f.app.store.tasks = originalTasks;
  }
});

test('共享结果仍受本地令牌保护，读取中切账号不会发布或保存旧结果', async t => {
  const f = await fixture(t), block = f.hold('gpuCatalog');
  const batch = await f.batch(GPU_ROUTE, Array.from({ length: 5 }, () => ({})), block);
  assert.equal((await f.request(GPU_ROUTE, {}, 'synthetic-wrong-token')).status, 403);
  f.setAccount(ACCOUNT_B);
  const results = await batch.finish();
  assert.ok(results.every(result => result.status === 409 && result.body.error === 'LOGIN_CHECK_REQUIRED'));
  assert.equal(f.samples, 0); assert.equal(f.gaps, 0); assert.equal(Object.hasOwn(f.app.store.data, 'gpuCatalog'), false);
  await f.connect(ACCOUNT_B);
  assert.equal((await f.request(GPU_ROUTE)).status, 200);
  assert.equal(f.counts.gpuCatalog, 2); assert.equal(f.app.store.data.gpuCatalogOwnerId, ACCOUNT_B.ownerId);
  assert.equal(f.app.market.history.length, 1);
});

test('等待页面锁期间切换账号，原账号排队的目录请求不会读取新账号', async t => {
  const f = await fixture(t), loginBlock = f.hold('checkLogin');
  const login = f.request('/api/browser/check'); await loginBlock.entered;
  // 确认目录请求已到服务端且开始等待，再完成另一个账号的连接。
  const received = gate();
  const listener = req => { if (req.url === GPU_ROUTE) req.once('end', received.resolve); };
  f.app.server.on('request', listener);
  const oldRead = f.request(GPU_ROUTE); await received.promise; await turn();
  f.app.server.off('request', listener);
  f.setAccount(ACCOUNT_B); loginBlock.release();
  assert.equal((await login).status, 200);
  const old = await oldRead;
  assert.equal(old.status, 409); assert.equal(old.body.error, 'LOGIN_CHECK_REQUIRED'); assert.equal(f.counts.gpuCatalog, 0);
  assert.equal((await f.request(GPU_ROUTE)).status, 200); assert.equal(f.counts.gpuCatalog, 1);
});

test('连接检查和退出仍是独立控制操作，不共享成功响应', async t => {
  const f = await fixture(t);
  for (const [route, method] of [['/api/browser/check', 'checkLogin'], ['/api/browser/logout', 'logout']]) {
    const before = f.counts[method], block = f.hold(method);
    const batch = await f.batch(route, Array.from({ length: 5 }, () => ({})), block);
    const results = await batch.finish();
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.equal(results.filter(result => result.status === 409 && result.body.error === 'BUSY').length, 4);
    assert.equal(f.counts[method] - before, 1);
  }
});
