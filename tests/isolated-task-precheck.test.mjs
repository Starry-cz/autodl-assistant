import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { routeReadonlyPrecheck } from '../src/adapters/autodl-precheck.mjs';
import { accountOwnerId } from '../src/account-scope.mjs';
import { testConfig } from './fixtures/config.mjs';
import { gate } from './helpers.mjs';

const owner = accountOwnerId('synthetic-account');
const task = (id = 'task-a', config = {}) => ({ id, ownerId: owner, config: testConfig(config), operation: null });
const zero = [{ 'RTX 4090': { idle_gpu_num: 0, total_gpu_num: 8 } }];
const source = { uuid: 'synthetic-source', status: 'shutdown', region_name: '北京B区', gpu_type_name: 'RTX 4090',
  req_gpu_amount: 1, machine_id: 'synthetic-host', gpu_idle_num: 0, gpu_all_num: 8 };
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => ({ code: 'Success', data }) });

// VM 执行实际页面查询函数；每个读页拥有独立全局对象，共享合成 localStorage，所有网络由本地函数提供。
function fixture({ handle = null, stock = zero, instance = source, identity = 'synthetic-account' } = {}) {
  const storage = { token: 'synthetic-private-token', user: '{}' }, pages = [], calls = [];
  let active = 0, peak = 0;
  const defaultData = (url, body) => {
    if (url.pathname.endsWith('/user/detail')) return { uuid: identity, username: '合成用户' };
    if (url.pathname.endsWith('/region/list')) return ['北京B区', '西北B区'].map((region, i) => ({ data_center: String(i), region_name: region, region_sign: String(i) }));
    if (url.pathname.endsWith('/gpu_type')) return stock;
    if (url.pathname.endsWith('/instance')) return { list: [instance], result_total: 1 };
    throw Error('未授权的合成请求 ' + url.pathname);
  };
  const context = { async newPage() {
    const closed = new AbortController();
    const page = { closed: false, address: 'about:blank', routes: [], on() {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      url() { return this.address; }, isClosed() { return this.closed; },
      async route(pattern, fn) { this.routes.push({ pattern, fn }); },
      async goto(url) { this.address = url; },
      async close() { this.closed = true; closed.abort(); },
      async evaluate(fn, input) {
        if (this.closed) throw Error('closed');
        sandbox.input = input;
        const value = await vm.runInContext(`(${fn.toString()})(input)`, sandbox);
        if (this.closed) throw Error('closed');
        return value == null ? value : JSON.parse(JSON.stringify(value));
      } };
    const sandbox = vm.createContext({ URL, AbortSignal, AbortController, location: { origin: 'https://www.autodl.com' },
      localStorage: { getItem: key => storage[key] ?? null },
      fetch: async (input, options) => {
        const url = new URL(input, 'https://www.autodl.com'), body = options.body ? JSON.parse(options.body) : null;
        const signal = AbortSignal.any([closed.signal, options.signal]);
        const call = { page, url, body, signal }; calls.push(call); active++; peak = Math.max(peak, active);
        let abort;
        const aborted = new Promise((_, reject) => { abort = () => reject(Error('aborted')); signal.addEventListener('abort', abort, { once: true }); });
        try { return await Promise.race([Promise.resolve(handle?.(call)).then(value => value ?? response(defaultData(url, body))), aborted]); }
        finally { active--; signal.removeEventListener('abort', abort); }
      } });
    pages.push(page); return page;
  }, pages: () => pages, async close() { await Promise.all(pages.map(page => page.close())); } };
  const adapter = new AutoDLBrowserAdapter('synthetic-unused-runtime');
  adapter.context = context; adapter.session = { state: 'ready' };
  adapter.page = { url: () => 'https://www.autodl.com/create', isClosed: () => false };
  const prepared = adapter.prepared = { sentinel: 'prepared' }, probed = adapter.probed = { sentinel: 'probed' };
  return { adapter, context, storage, pages, calls, prepared, probed, active: () => active, peak: () => peak };
}

test('两个任务独立读页同时查询；慢首任务不阻挡快任务命中，主表单和缓存保持不变', async () => {
  const entered = gate(), first = gate(), second = gate(); let reads = 0;
  const f = fixture({ handle: async call => {
    if (!call.url.pathname.endsWith('/gpu_type')) return;
    if (++reads === 2) entered.resolve();
    return (reads === 1 ? first : second).promise;
  } });
  const a = f.adapter.isolatedPrecheck(task('a')), bTask = task('b'), b = f.adapter.isolatedPrecheck(bTask);
  await entered.promise; assert.equal(f.peak(), 2); assert.equal(f.pages.length, 2);
  second.resolve(response([{ 'RTX 4090': { idle_gpu_num: 1, total_gpu_num: 8 } }]));
  const found = await b;
  assert.equal(found.verdict, 'candidate'); assert.equal(f.active(), 1); assert.equal(f.pages[1].closed, true);
  assert.equal(f.adapter.readonlyPrechecks.canReuseCatalog(bTask, found), true);
  assert.equal(f.adapter.readonlyPrechecks.canReuseCatalog(task('a'), found), false);
  assert.equal(f.adapter.readonlyPrechecks.canReuseCatalog(task('b', { gpuCount: 2 }), found), false);
  first.resolve(response(zero)); const empty = await a;
  assert.equal(empty.verdict, 'empty'); assert.equal(empty.observation.catalogTotal, 8);
  assert.equal(empty.ownerId, owner); assert.equal(f.adapter.prepared, f.prepared); assert.equal(f.adapter.probed, f.probed);
  assert.equal(f.adapter.page.url(), 'https://www.autodl.com/create'); assert.equal(f.adapter.session.state, 'ready');
  assert.doesNotMatch(JSON.stringify([found, empty]), /synthetic-private-token/);
  assert.equal(f.adapter.readonlyPrechecks.active.size, 0); assert.ok(f.pages.every(page => page.closed));
});

for (const limit of [2,3]) test(`跨任务最多 ${limit} 路，任务内两地区仍依次读取`, async () => {
  const entered = gate(), release = gate(); let reads = 0;
  const f = fixture({ handle: async call => {
    if (!call.url.pathname.endsWith('/gpu_type')) return;
    if (++reads === limit) entered.resolve(); await release.promise; return response(zero);
  } });
  const options = limit === 2 ? {} : {maxParallel:limit};
  const pending = ['a', 'b', 'c'].slice(0,limit).map(id =>
    f.adapter.isolatedPrecheck(task(id, { regions: ['北京B区', '西北B区'] }), options));
  await entered.promise;
  await assert.rejects(f.adapter.isolatedPrecheck(task('extra'), options), { code: 'PRECHECK_BUSY' });
  await assert.rejects(f.adapter.isolatedPrecheck(task('extra'), {maxParallel:4}), { code: 'CONFIG' });
  assert.equal(reads, limit); release.resolve();
  assert.ok((await Promise.all(pending)).every(result => result.verdict === 'empty'));
  assert.equal(reads, 2*limit); assert.equal(f.peak(), limit);
});

test('取消只关闭本任务读页，不终止另一任务；所有在途请求先收尾', async () => {
  const entered = gate(), release = gate(); let reads = 0;
  const f = fixture({ handle: async call => { if (call.url.pathname.endsWith('/gpu_type')) { if (++reads === 2) entered.resolve(); return release.promise; } } });
  const controller = new AbortController();
  const a = f.adapter.isolatedPrecheck(task('a'), { signal: controller.signal });
  const b = f.adapter.isolatedPrecheck(task('b'));
  await entered.promise; controller.abort();
  await assert.rejects(a, { code: 'PRECHECK_CANCELLED' });
  assert.equal(f.pages[0].closed, true); assert.equal(f.pages[1].closed, false); assert.equal(f.active(), 1);
  release.resolve(response(zero)); assert.equal((await b).verdict, 'empty'); assert.equal(f.active(), 0);
});

test('adapter.close 取消所有只读页并收齐请求；主 context 关闭后不能返回库存成功', async () => {
  const entered = gate(); let reads = 0;
  const f = fixture({ handle: async call => { if (call.url.pathname.endsWith('/gpu_type')) { if (++reads === 2) entered.resolve(); return new Promise(() => {}); } } });
  const pending = Promise.allSettled(['a', 'b'].map(id => f.adapter.isolatedPrecheck(task(id))));
  await entered.promise; await f.adapter.close();
  const results = await pending; assert.ok(results.every(row => row.status === 'rejected' && row.reason.code === 'PRECHECK_CANCELLED'));
  assert.equal(f.active(), 0); assert.equal(f.adapter.readonlyPrechecks.active.size, 0);
});

test('同一批次账号 Token 或 context 改变后，旧响应不能作为空库存证据', async () => {
  for (const mutate of [f => { f.storage.token = 'synthetic-replaced-token'; }, f => { f.adapter.context = {}; }]) {
    const entered = gate(), release = gate();
    const f = fixture({ handle: async call => { if (call.url.pathname.endsWith('/gpu_type')) { entered.resolve(); return release.promise; } } });
    const pending = f.adapter.isolatedPrecheck(task()); await entered.promise; mutate(f); release.resolve(response(zero));
    await assert.rejects(pending, { code: 'LOGIN_CHECK_REQUIRED' }); assert.ok(f.pages.every(page => page.closed));
  }
  const f = fixture({ identity: 'synthetic-other' });
  await assert.rejects(f.adapter.isolatedPrecheck(task()), { code: 'LOGIN_CHECK_REQUIRED' });
  assert.equal(f.calls.length, 1);
});

test('目录缺项、重复型号、无效库存不能被解释为0', async () => {
  for (const stock of [[], [...zero, ...zero], [{ 'RTX 4090': { idle_gpu_num: 0 } }], [{ 'RTX 4090': { idle_gpu_num: -1, total_gpu_num: 8 } }]]) {
    const f = fixture({ stock }); const result = await f.adapter.isolatedPrecheck(task());
    assert.equal(result.verdict, 'unknown'); assert.equal(result.observation, undefined); assert.equal(result.catalogChecked, true);
  }
});

test('慢目录或实例分页的负证据保留读取起点，不把返回时刻当成新鲜库存', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  for (const mode of ['create', 'boot', 'clone']) {
    now = 1000;
    const f = fixture({ handle: call => {
      if (call.url.pathname.endsWith('/gpu_type') || call.url.pathname.endsWith('/instance')) now += 6000;
    } });
    const input = task('slow', { mode });
    // 调度只读配置，不需要复制历史日志/结果等任务附属对象。
    input.unrelatedHistory = { omitted: () => {} };
    const result = await f.adapter.isolatedPrecheck(input);
    assert.equal(result.verdict, 'empty'); assert.equal(result.checkedAt, 1000);
    assert.equal(f.adapter.readonlyPrechecks.canReuseCatalog(input, result), false);
  }
});

test('开机预检仅凭精确且完整的源实例0库存跳过；其他情况交还DOM核验', async () => {
  const f = fixture(), result = await f.adapter.isolatedPrecheck(task('boot', { mode: 'boot' }));
  assert.equal(result.verdict, 'empty'); assert.equal(result.kind, 'boot'); assert.equal(result.instance.gpuAvailable, false);
  for (const patch of [{ gpu_idle_num: undefined }, { gpu_all_num: undefined }, { machine_id: '' }, { status: 'running' },
    { uuid: 'another-source' }, { gpu_type_name: 'RTX 4090D' }, { region_name: '西北B区' }, { req_gpu_amount: 2 }, { status: 'shutdown_by_running_error' }]) {
    const g = fixture({ instance: { ...source, ...patch } });
    assert.equal((await g.adapter.isolatedPrecheck(task('boot', { mode: 'boot' }))).verdict, 'unknown');
  }
});

test('克隆先核验源同区；仅全零返回市场empty，不覆盖完整源环境；组合只返回boot证据', async () => {
  const f = fixture(), cloned = await f.adapter.isolatedPrecheck(task('clone', { mode: 'clone' }));
  assert.equal(cloned.verdict, 'empty'); assert.equal(cloned.kind, 'market'); assert.equal(cloned.observation.source, null);
  const wrong = fixture({ instance: { ...source, region_name: '西北B区' } });
  assert.equal((await wrong.adapter.isolatedPrecheck(task('clone', { mode: 'clone' }))).verdict, 'unknown');
  assert.equal(wrong.calls.some(call => call.url.pathname.endsWith('/gpu_type')), false);
  const race = fixture(), combined = await race.adapter.isolatedPrecheck(task('race', { mode: 'clone', raceBoot: true,
    pricePolicy: 'official', maxGpuHourly: null, maxTotalHourly: null, maxStorageDaily: null }));
  assert.equal(combined.verdict, 'empty'); assert.equal(combined.kind, 'boot'); assert.equal(combined.observation, undefined);
  assert.equal(race.calls.some(call => call.url.pathname.endsWith('/gpu_type')), false);
});

test('429与服务器故障抛出可退避错误，不把失败返回unknown再立刻导航请求', async () => {
  for (const suffix of ['/user/detail', '/gpu_type', '/instance']) for (const status of [429, 503]) {
    const f = fixture({ handle: call => call.url.pathname.endsWith(suffix) ? response(null, status) : null });
    await assert.rejects(f.adapter.isolatedPrecheck(task('a', { mode: suffix === '/instance' ? 'boot' : 'create' })), error => error.retryable === true);
    assert.ok(f.pages.every(page => page.closed));
  }
  const f = fixture({ handle: call => call.url.pathname.endsWith('/instance')
    ? call.body.page_index === 1 ? response({ list: [source], result_total: 2 }) : response(null, 429) : null });
  await assert.rejects(f.adapter.isolatedPrecheck(task('boot', { mode: 'boot' })), error => error.retryable === true);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/instance')).length, 2);
});

test('只读路由允许最小查询集合，拒绝创建、开机、第三方和其他导航', async () => {
  for (const [path, method, navigation, expected] of [
    ['/__autodl_helper_readonly__', 'GET', true, 'fulfill'], ['/api/v1/user/detail', 'GET', false, 'fallback'],
    ['/api/v1/instance', 'POST', false, 'fallback'], ['/api/v1/sub_user/region/list', 'GET', false, 'fallback'],
    ['/api/v1/sub_user/machine/region/gpu_type', 'POST', false, 'fallback'],
    ['/api/v1/instance/create', 'POST', false, 'abort'], ['/api/v1/instance/start', 'POST', false, 'abort'],
    ['/create', 'GET', true, 'abort'], ['https://example.invalid/api/v1/user/detail', 'GET', false, 'abort'],
  ]) {
    let result;
    await routeReadonlyPrecheck({ request: () => ({ url: () => new URL(path, 'https://www.autodl.com').href,
      method: () => method, isNavigationRequest: () => navigation }),
      fulfill: () => { result = 'fulfill'; }, fallback: () => { result = 'fallback'; }, abort: () => { result = 'abort'; } });
    assert.equal(result, expected);
  }
});
