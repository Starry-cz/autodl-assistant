import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { REGIONS } from '../src/config.mjs';
import { readInventoryInPage, readAutodlInventory, inventoryRegions, readGpuCatalogApi,
  inventoryHostQuery, inventoryHourlyPrice, normalizeInventoryHost, readMarketHostsApi } from '../src/adapters/autodl-inventory.mjs';
import { fixture as engineFixture } from './helpers.mjs';

// 全部测试使用内存页面和合成响应；没有真实浏览器资料、账号或外部请求。
function pageFixture({ origin = 'https://www.autodl.com', storage = {}, data = [], code = 'Success', status = 200,
  failFetch = false, changeAccount = false } = {}) {
  const values = { token: 'synthetic-token', user: '{}', app_version: '{"version":"synthetic-version"}', ...storage }, calls = [];
  return { calls, async run(kind, params = {}) {
    const result = await vm.runInNewContext(`(${readInventoryInPage.toString()})(input)`, {
      URL, AbortSignal, location: { origin }, input: { kind, params },
      localStorage: { getItem: key => values[key] ?? null },
      fetch: async (url, options) => {
        calls.push({ url, ...options, signal: undefined });
        if (failFetch) throw Error('synthetic-secret-in-error');
        if (changeAccount) values.token = 'synthetic-other-account';
        return new Response(JSON.stringify({ code, msg: 'synthetic-private-message', data }), { status });
      },
    });
    return JSON.parse(JSON.stringify(result));
  } };
}

const regionRows = [
  { data_center: 'synthetic-bj', region_name: '北京B区', region_sign: 'synthetic-bj-1', used_for: 'all', visible: 'all' },
  { data_center: 'synthetic-west', region_name: '西北B区', region_sign: 'synthetic-west-1', used_for: 'all', visible: 'all' },
  { data_center: 'synthetic-bj', region_name: '北京B区', region_sign: 'synthetic-bj-2', used_for: 'all', visible: 'all' },
];
const gpuRows = [{ 'RTX 4090': { idle_gpu_num: 2, total_gpu_num: 8 } }, { 'RTX 4090D': { idle_gpu_num: 0, total_gpu_num: 16 } }];
const sku = price => [{ type: 'payg', current_price: price, level_config: [
  { level_name: 'normal_user', discount: 100 }, { level_name: 'member_user', discount: 95 },
] }];
const host = (id, extra = {}) => ({ machine_id: id, machine_alias: '合成 ' + id, gpu_name: 'RTX 4090', gpu_number: 8,
  gpu_idle_num: 2, region_name: '北京B区', region_sign: 'synthetic-bj-1', on_line: 2, max_instance_num: 80,
  binding_instance_num: 70, machine_sku_info: sku(2290), ...extra });

function adapterFixture({ regions = regionRows, gpus = gpuRows, membership = { member_level: 'normal_user' },
  hosts = () => ({ list: [host('synthetic-host')], result_total: 1 }) } = {}) {
  const calls = [];
  const adapter = { session: { state: 'ready' }, setSession(state) { this.session.state = state; },
    page: { isClosed: () => false, url: () => 'https://www.autodl.com/create', evaluate: async (fn, input) => {
      assert.equal(fn, readInventoryInPage); calls.push(input);
      const value = { regions, gpus, membership, hosts }[input.kind];
      const data = typeof value === 'function' ? await value(input.params) : value;
      return data?.error ? data : { data };
    } },
    browser() { throw Error('查询不能打开浏览器'); }, goto() { throw Error('查询不能导航主页面'); },
  };
  return { adapter, calls };
}

test('官网主账号库存与会员接口路径、方法、请求头及body精确匹配', async () => {
  const cases = [
    ['regions', '/region/list', 'GET', []], ['gpus', '/machine/region/gpu_type', 'POST', gpuRows],
    ['hosts', '/user/machine/list', 'POST', { list: [], result_total: 0 }],
    ['membership', '/user/member/detail', 'GET', { member_level: 'normal_user' }],
  ];
  for (const [kind, suffix, method, data] of cases) {
    const fixture = pageFixture({ data }), params = kind === 'gpus' ? { region_sign_list: ['synthetic-bj-1'] } : { page_index: 2 };
    await fixture.run(kind, params);
    const call = fixture.calls[0];
    assert.equal(call.url, 'https://www.autodl.com/api/v1' + suffix);
    assert.equal(call.method, method); assert.equal(call.credentials, 'include'); assert.equal(call.redirect, 'error');
    assert.equal(call.headers.Authorization, 'synthetic-token'); assert.equal(call.headers.AppVersion, 'synthetic-version');
    assert.equal(call.body, method === 'POST' ? JSON.stringify(params) : undefined);
  }
});

test('四种查询均按官网拦截器使用子账号前缀，包括user/machine/list', async () => {
  for (const [kind, suffix, data] of [['regions', '/region/list', []], ['gpus', '/machine/region/gpu_type', []],
    ['hosts', '/user/machine/list', { list: [] }], ['membership', '/user/member/detail', {}]]) {
    const fixture = pageFixture({ storage: { user: '{"sub_name":"synthetic-sub"}' }, data });
    await fixture.run(kind);
    assert.equal(new URL(fixture.calls[0].url).pathname, '/api/v1/sub_user' + suffix);
  }
});

test('页面仅传出地区、库存、主机SKU和会员档位白名单，不带出额外资料', async () => {
  const regions = await pageFixture({ data: [{ ...regionRows[0], token: 'private', setting: { password: 'private' } }] }).run('regions');
  assert.deepEqual(regions.data, [regionRows[0]]);
  const gpus = await pageFixture({ data: [{ 'RTX 4090': { idle_gpu_num: 2, total_gpu_num: 8, secret: 'private' } }] }).run('gpus');
  assert.deepEqual(gpus.data, [gpuRows[0]]);
  const result = await pageFixture({ data: { list: [{ ...host('synthetic-a'), ip: 'private', ssh_password: 'private',
    machine_sku_info: [{ ...sku(2290)[0], secret: 'private', level_config: [{ level_name: 'normal_user', discount: 100, secret: 'private' }] }] }],
    result_total: 1, max_page: 1, token: 'private' } }).run('hosts');
  assert.equal(result.data.list[0].machine_id, 'synthetic-a');
  assert.deepEqual(result.data.list[0].machine_sku_info[0].level_config, [{ level_name: 'normal_user', discount: 100 }]);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|token|ssh|password/);
  assert.deepEqual(await pageFixture({ data: { member_level: 'member_user', uid: 123, phone: 'private' } }).run('membership'),
    { data: { member_level: 'member_user' } });
});

test('缺Token、错误origin及未知kind不发请求，其他错误不暴露响应正文', async () => {
  for (const [options, kind, error] of [[{ storage: { token: null } }, 'regions', 'AUTH'],
    [{ origin: 'https://example.test' }, 'regions', 'SESSION'], [{}, 'power_on', 'SESSION']]) {
    const fixture = pageFixture(options); assert.deepEqual(await fixture.run(kind), { error }); assert.equal(fixture.calls.length, 0);
  }
  for (const [options, error] of [[{ status: 401 }, 'AUTH'], [{ code: 'AuthorizeFailed' }, 'AUTH'],
    [{ status: 429 }, 'TRANSIENT'], [{ status: 500 }, 'TRANSIENT'], [{ status: 400 }, 'API'],
    [{ code: 'future-code' }, 'API'], [{ failFetch: true }, 'NETWORK'], [{ changeAccount: true }, 'CHANGED']])
    assert.deepEqual(await pageFixture(options).run('regions'), { error });
});

test('页面响应结构变化不当成空列表；未知计数保留缺失', async () => {
  for (const [kind, data] of [['regions', {}], ['gpus', [null]], ['hosts', { list: null }], ['membership', []]])
    assert.deepEqual(await pageFixture({ data }).run(kind), { error: 'SCHEMA' });
  const result = await pageFixture({ data: [{ 'RTX 4090': { idle_gpu_num: { secret: true }, total_gpu_num: null } }] }).run('gpus');
  assert.deepEqual(result.data, [{ 'RTX 4090': { total_gpu_num: null } }]);
});

test('只用已有已核验页面，会话失效与换号立即中止', async () => {
  const f = adapterFixture();
  await readAutodlInventory(f.adapter, 'regions'); assert.equal(f.calls.length, 1);
  f.adapter.session.state = 'unchecked'; await assert.rejects(readAutodlInventory(f.adapter, 'regions'), { code: 'INVENTORY_SESSION' });
  assert.equal(f.calls.length, 1); f.adapter.session.state = 'ready';
  f.adapter.page.evaluate = async () => ({ error: 'AUTH' });
  await assert.rejects(readAutodlInventory(f.adapter, 'regions'), { code: 'INVENTORY_AUTH' }); assert.equal(f.adapter.session.state, 'expired');
  f.adapter.session.state = 'ready'; f.adapter.page.evaluate = async () => ({ error: 'CHANGED' });
  await assert.rejects(readAutodlInventory(f.adapter, 'regions'), { code: 'INVENTORY_SESSION' });
});

test('传输失败和限流/服务端错误允许退避，登录、会话及结构错误不自动重试', async () => {
  // 从页面 fetch 响应走到 AppError，防止只测试错误字符串而漏掉 retryable 的实际传播。
  const cases = [
    [{ failFetch: true }, true], [{ status: 429 }, true], [{ status: 500 }, true], [{ status: 503 }, true],
    [{ status: 400 }, false], [{ status: 401 }, false], [{ status: 403 }, false],
    [{ code: 'AuthorizeFailed' }, false], [{ code: 'UnknownPlatformError' }, false],
    [{ data: {} }, false], [{ origin: 'https://example.test' }, false], [{ changeAccount: true }, false],
  ];
  for (const [options, retryable] of cases) {
    const page = pageFixture(options), f = adapterFixture();
    f.adapter.page.evaluate = (_fn, { kind, params }) => page.run(kind, params);
    await assert.rejects(readAutodlInventory(f.adapter, 'regions'), error => {
      assert.equal(error.retryable, retryable, JSON.stringify(options));
      assert.doesNotMatch(error.message, /synthetic-private-message|synthetic-secret-in-error|synthetic-token/);
      return true;
    });
  }
  const disconnected = adapterFixture(); disconnected.adapter.session.state = 'unchecked';
  await assert.rejects(readAutodlInventory(disconnected.adapter, 'regions'), error => error.code === 'INVENTORY_SESSION' && !error.retryable);
  const interrupted = adapterFixture(); interrupted.adapter.page.evaluate = async () => { throw Error('synthetic transport interrupted'); };
  await assert.rejects(readAutodlInventory(interrupted.adapter, 'regions'), error => error.code === 'INVENTORY_UNAVAILABLE' && error.retryable);
});

test('地区按data_center合并全部签名，未知/重名地区不猜映射', () => {
  const groups = inventoryRegions([...regionRows, regionRows[0]], ['北京B区', '西北B区', '佛山区']);
  assert.deepEqual(groups[0], { region: '北京B区', signs: ['synthetic-bj-1', 'synthetic-bj-2'] });
  assert.equal(groups[2].missing, true);
  const ambiguous = inventoryRegions([...regionRows, { ...regionRows[0], data_center: 'synthetic-other' }], ['北京B区'])[0];
  assert.deepEqual(ambiguous.signs, []); assert.match(ambiguous.error, /多个/);
});

test('GPU目录一次地区查询加每区一次统计，无导航，保留精确型号及零库存', async () => {
  const f = adapterFixture();
  const result = await readGpuCatalogApi(f.adapter, ['北京B区', '西北B区']);
  assert.deepEqual(f.calls.map(call => call.kind), ['regions', 'gpus', 'gpus']);
  assert.deepEqual(f.calls[1].params, { region_sign_list: ['synthetic-bj-1', 'synthetic-bj-2'] });
  assert.deepEqual(result.regions[0].models, [{ model: 'RTX 4090', available: 2, total: 8, disabled: false },
    { model: 'RTX 4090D', available: 0, total: 16, disabled: false }]);
});

test('GPU缺失/矛盾库存不置零，单区失败标不完整且登录失效不继续其他区', async () => {
  const f = adapterFixture({ gpus: params => params.region_sign_list[0].includes('west') ? { error: 'API' }
    : [{ A: { total_gpu_num: 8 } }, { B: { idle_gpu_num: 9, total_gpu_num: 8 } }] });
  const result = await readGpuCatalogApi(f.adapter, ['北京B区', '西北B区', '佛山区']);
  assert.equal(result.regions[0].models[0].available, null); assert.equal(result.regions[0].models[1].available, null);
  assert.match(result.regions[1].error, /失败/); assert.equal(result.regions[2].missing, true);
  const auth = adapterFixture({ gpus: { error: 'AUTH' } });
  await assert.rejects(readGpuCatalogApi(auth.adapter, REGIONS), { code: 'INVENTORY_AUTH' }); assert.equal(auth.calls.length, 2);
});

test('任务 strict 目录在首个失败地区立即抛出原错误，看板仍可展示部分结果', async () => {
  for (const error of ['NETWORK', 'TRANSIENT', 'SCHEMA', 'AUTH']) {
    const f = adapterFixture({ gpus: { error } });
    await assert.rejects(readGpuCatalogApi(f.adapter, ['北京B区', '西北B区'], { strict: true }), failure => {
      assert.equal(failure.retryable, ['NETWORK', 'TRANSIENT'].includes(error));
      assert.equal(failure.code, error === 'AUTH' ? 'INVENTORY_AUTH' : 'INVENTORY_UNAVAILABLE');
      return true;
    });
    assert.deepEqual(f.calls.map(call => call.kind), ['regions', 'gpus'], '失败后不查询其他地区、不转 DOM');
  }
  const partial = adapterFixture({ gpus: params => params.region_sign_list[0].includes('west') ? { error: 'NETWORK' } : gpuRows });
  const result = await readGpuCatalogApi(partial.adapter, ['北京B区', '西北B区']);
  assert.equal(result.regions[0].models.length, 2); assert.match(result.regions[1].error, /失败/);
});

test('真实引擎遇到 strict 库存网络错误继续退避，登录或结构失效则停止自动检查', async t => {
  for (const error of ['NETWORK', 'TRANSIENT', 'AUTH', 'SCHEMA']) {
    const f = engineFixture(t, { mode: 'create', action: 'observe', paidConsent: false });
    const inventory = adapterFixture({ gpus: { error } });
    f.adapter.probe = () => readGpuCatalogApi(inventory.adapter, ['北京B区'], { strict: true });
    await f.engine.tick();
    const retryable = ['NETWORK', 'TRANSIENT'].includes(error);
    assert.equal(f.task.state, retryable ? 'watching' : 'attention', error);
    assert.equal(f.task.errors, 1); assert.equal(f.submissions, 0);
    assert.equal(inventory.calls.length, 2);
    if (retryable) assert.ok(f.task.nextCheckAt > f.clock(), '失败后安排退避，不立即重复请求');
    else {
      await f.due(600000);
      assert.equal(inventory.calls.length, 2, '人工处理前不继续读取');
    }
  }
});

test('主机请求使用官网默认字段，空闲筛选为0且型号参数精确', () => {
  const query = inventoryHostQuery({ signs: ['synthetic-a'], model: 'RTX 4090 D', pageIndex: 2 });
  assert.equal(query.page_size, 90); assert.equal(query.page_index, 2); assert.equal(query.gpu_idle_num, 0);
  assert.equal(query.charge_type, 'payg'); assert.equal(query.default_order, true); assert.equal(query.region_sign, '');
  assert.deepEqual(query.gpu_type_name, ['RTX 4090 D']); assert.deepEqual(query.region_sign_list, ['synthetic-a']);
  assert.deepEqual(inventoryHostQuery({ signs: ['synthetic-a'] }).gpu_type_name, []);
});

test('每卡小时价沿用官方会员映射、毫元单位和两阶段舍入，未知价格不估算', () => {
  const row = host('synthetic-a');
  assert.equal(inventoryHourlyPrice(row, 'normal_user'), 2.29);
  assert.equal(inventoryHourlyPrice(row, 'member_level_2'), 2.18);
  assert.equal(inventoryHourlyPrice({ machine_sku_info: sku(1005) }, 'member_user'), .96);
  assert.equal(inventoryHourlyPrice(row, null), null); assert.equal(inventoryHourlyPrice(row, 'unknown'), null);
  assert.equal(inventoryHourlyPrice({ machine_sku_info: [] }, 'normal_user'), null);
});

test('官方不可选和实例名额满显示可租空卡0，状态或库存缺失显示未知', () => {
  const group = inventoryRegions(regionRows, ['北京B区'])[0];
  assert.equal(normalizeInventoryHost(host('a', { on_line: 3 }), group, 'normal_user').available, 0);
  assert.equal(normalizeInventoryHost(host('a', { binding_instance_num: 80 }), group, 'normal_user').available, 0);
  assert.equal(normalizeInventoryHost(host('a', { gpu_idle_num: null }), group, 'normal_user').available, null);
  assert.equal(normalizeInventoryHost(host('a', { on_line: undefined }), group, 'normal_user').available, null);
  assert.equal(normalizeInventoryHost(host('a', { gpu_name: undefined }), group, 'normal_user'), null);
  assert.equal(normalizeInventoryHost(host('a', { region_sign: 'unrequested' }), group, 'normal_user'), null);
});

test('主机分页完整时保持现有合同，全查询只读取一次会员档位', async () => {
  const f = adapterFixture({ membership: { member_level: 'member_user' }, hosts: ({ page_index }) => ({
    list: page_index === 1 ? [host('a'), host('b')] : [host('c')], result_total: 3, max_page: 2,
  }) });
  const result = await readMarketHostsApi(f.adapter, { model: 'RTX 4090', region: '北京B区' }, { pageSize: 2 });
  assert.equal(result.complete, true); assert.equal(result.pages, 2); assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].pricePerHour, 2.18); assert.equal(result.rows[0].region, '北京B区');
  assert.deepEqual(f.calls.map(call => call.kind), ['regions', 'membership', 'hosts', 'hosts']);
  assert.equal(f.calls.at(-1).params.page_index, 2);
});

test('单型号跨地区和单地区全部型号各保留正确过滤条件，双空不请求', async () => {
  const f = adapterFixture({ hosts: params => ({ list: [host(params.region_sign_list[0], { region_sign: params.region_sign_list[0] })], result_total: 1 }) });
  const across = await readMarketHostsApi(f.adapter, { model: 'RTX 4090', region: '' });
  assert.deepEqual(across.rows.map(row => row.region), ['北京B区', '西北B区']);
  assert.equal(across.complete, false); assert.equal(across.regions.length, 6);
  assert.ok(f.calls.filter(call => call.kind === 'hosts').every(call => call.params.gpu_type_name[0] === 'RTX 4090'));
  const allModels = adapterFixture(); await readMarketHostsApi(allModels.adapter, { region: '北京B区', model: '' });
  assert.deepEqual(allModels.calls.at(-1).params.gpu_type_name, []);
  const noQuery = adapterFixture(); await assert.rejects(readMarketHostsApi(noQuery.adapter, {}), { code: 'CONFIG' }); assert.equal(noQuery.calls.length, 0);
});

test('翻页后失败保留已读结果，未知总数的短页可结束，读取上限不宣称完整', async () => {
  const failed = adapterFixture({ hosts: ({ page_index }) => page_index === 1 ? { list: [host('a')], result_total: 2 } : { error: 'API' } });
  const partial = await readMarketHostsApi(failed.adapter, { region: '北京B区' }, { pageSize: 1 });
  assert.equal(partial.complete, false); assert.equal(partial.rows.length, 1); assert.match(partial.note, /第 2 页读取失败/);
  const noTotal = adapterFixture({ hosts: () => ({ list: [host('a')] }) });
  assert.equal((await readMarketHostsApi(noTotal.adapter, { region: '北京B区' })).complete, true);
  const limit = adapterFixture({ hosts: () => ({ list: [host('a')], result_total: 2 }) });
  const bounded = await readMarketHostsApi(limit.adapter, { region: '北京B区' }, { maxPages: 1 });
  assert.equal(bounded.complete, false); assert.match(bounded.note, /上限/);
});

test('重复页、总数变化、错误型号和地区均不冒充完整结果', async () => {
  const fixtures = [
    ({ page_index }) => ({ list: [host('a')], result_total: 2 }),
    ({ page_index }) => ({ list: [host(String(page_index))], result_total: page_index === 1 ? 2 : 1 }),
    () => ({ list: [host('a', { gpu_name: 'RTX 4090D' })], result_total: 1 }),
    () => ({ list: [host('a', { region_sign: 'synthetic-other' })], result_total: 1 }),
  ];
  for (const hosts of fixtures) {
    const f = adapterFixture({ hosts });
    const result = await readMarketHostsApi(f.adapter, { model: 'RTX 4090', region: '北京B区' }, { pageSize: 1 });
    assert.equal(result.complete, false); assert.ok(result.note);
  }
});

test('会员读取失败仍展示未知价，主机翻页登录失效立即中止', async () => {
  const membership = adapterFixture({ membership: { error: 'API' } });
  const result = await readMarketHostsApi(membership.adapter, { region: '北京B区' });
  assert.equal(result.rows[0].pricePerHour, null); assert.match(result.rows[0].priceNote, /未确认/);
  const auth = adapterFixture({ hosts: () => ({ error: 'AUTH' }) });
  await assert.rejects(readMarketHostsApi(auth.adapter, { model: 'RTX 4090' }), { code: 'INVENTORY_AUTH' });
  assert.equal(auth.calls.filter(call => call.kind === 'hosts').length, 1);
});

// 旧 DOM 明细的有效约束迁到 API：保留任务页面、跨地区同 ID、未知数据和自定义名称。
test('读取成功或部分失败都不修改任务页面及prepared/probed状态', async () => {
  for (const hosts of [() => ({ list: [host('a', { gpu_idle_num: null, machine_sku_info: [] })], result_total: 1 }),
    () => ({ error: 'API' })]) {
    const f = adapterFixture({ hosts }), main = f.adapter.page;
    const prepared = { synthetic: 'prepared' }, probed = { synthetic: 'probed' };
    Object.assign(f.adapter, { prepared, probed, context: { newPage() { assert.fail('API查询不能新建明细页'); } },
      submit() { assert.fail('只读查询不能提交'); } });
    const result = await readMarketHostsApi(f.adapter, { region: '北京B区' });
    assert.equal(f.adapter.page, main); assert.equal(f.adapter.prepared, prepared); assert.equal(f.adapter.probed, probed);
    if (result.rows.length) {
      assert.equal(result.rows[0].available, null); assert.equal(result.rows[0].pricePerHour, null);
      assert.equal(result.rows[0].disabled, true); assert.equal(result.rows[0].status, '空闲数未知');
    } else assert.equal(result.complete, false);
  }
});

test('六地区逐区从第一页读取，同ID不同地区不误合并，缺型号空结果可以完整', async () => {
  const regions = REGIONS.map((region, index) => ({ data_center: 'synthetic-center-' + index,
    region_name: region, region_sign: 'synthetic-sign-' + index }));
  const f = adapterFixture({ regions, hosts: ({ region_sign_list, page_index }) => {
    if (region_sign_list[0] === 'synthetic-sign-1') return { list: [], result_total: 0 };
    return { list: [host('same-id-page-' + page_index, { region_sign: region_sign_list[0] })], result_total: 2 };
  } });
  const result = await readMarketHostsApi(f.adapter, { model: 'RTX 4090' }, { pageSize: 1 });
  assert.equal(result.complete, true); assert.equal(result.rows.length, 10);
  assert.deepEqual(result.regions.map(row => row.region), REGIONS);
  assert.equal(result.regions[1].count, 0); assert.equal(result.regions[1].complete, true);
  for (const region of regions) assert.deepEqual(f.calls.filter(call => call.kind === 'hosts'
    && call.params.region_sign_list[0] === region.region_sign).map(call => call.params.page_index),
  region.region_sign === 'synthetic-sign-1' ? [1] : [1, 2]);
});

test('单地区全部型号一次分页保留CPU和自定义精确名称，不用请求型号填补缺失', async () => {
  const names = ['Tesla T4', 'CPU', 'Synthetic Accelerator [Mk2] (48GB)'];
  const f = adapterFixture({ hosts: () => ({ list: names.map((gpu_name, i) => host('a' + i, { gpu_name })), result_total: 3 }) });
  const result = await readMarketHostsApi(f.adapter, { region: '北京B区' });
  assert.equal(result.complete, true); assert.deepEqual(result.rows.map(row => row.model), names);
  assert.equal(f.calls.filter(call => call.kind === 'hosts').length, 1);
  assert.deepEqual(f.calls.at(-1).params.gpu_type_name, []);
  const missing = adapterFixture({ hosts: () => ({ list: [host('a', { gpu_name: null })], result_total: 1 }) });
  const unknown = await readMarketHostsApi(missing.adapter, { region: '北京B区', model: names[2] });
  assert.equal(unknown.complete, false); assert.equal(unknown.rows.length, 0);
});
