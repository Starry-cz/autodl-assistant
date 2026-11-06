import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import os from 'node:os';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { readObservatoryInPage, readAutodlObservatory } from '../src/adapters/autodl-observatory.mjs';

// VM 只模拟专用网页环境，fetch 永远是内存替身；不读取任何真实 profile 或令牌。
function pageFixture({ storage = {}, origin = 'https://www.autodl.com', response = { code: 'Success', data: {} }, status = 200, throws = false } = {}) {
  const calls = [], values = { token: 'synthetic-web-session-token', app_version: '{"version":"0.0.0"}', ...storage };
  const globals = { URL, AbortSignal, location: { origin }, localStorage: { getItem: key => values[key] ?? null },
    fetch: async (url, options) => {
      calls.push({ url, options: JSON.parse(JSON.stringify({ ...options, signal: undefined })) });
      if (throws) throw Error('synthetic secret that must stay in page');
      return new Response(JSON.stringify(response), { status });
    } };
  return { calls, async run(kind, params = {}) {
    const value = await vm.runInNewContext(`(${readObservatoryInPage.toString()})(input)`, { ...globals, input: { kind, params } });
    // 模拟 Playwright 的跨页面序列化，断言的对象不保留 VM realm 原型。
    return JSON.parse(JSON.stringify(value));
  } };
}

test('只在官网页面内附加裸网页Token，Node返回只包含白名单数据', async () => {
  const fixture = pageFixture({ response: { code: 'Success', data: { list: [{ uuid: 'synthetic-a', name: '合成实例', status: 'running',
    root_password: 'synthetic-password', ssh_command: 'synthetic-ssh', jupyter_domain: 'synthetic-private-url',
    usage_info: { mem_limit: 100, cpu_usage_percent: 20, token: 'synthetic-hidden' } }], result_total: 1 } } });
  const result = await fixture.run('instances', { page_index: 1, page_size: 100 });
  assert.equal(fixture.calls[0].url, 'https://www.autodl.com/api/v1/instance');
  assert.equal(fixture.calls[0].options.method, 'POST'); assert.equal(fixture.calls[0].options.credentials, 'include');
  assert.equal(fixture.calls[0].options.headers.Authorization, 'synthetic-web-session-token');
  assert.equal(fixture.calls[0].options.headers.AppVersion, '0.0.0'); assert.equal(fixture.calls[0].options.redirect, 'error');
  assert.deepEqual(result, { data: { list: [{ uuid: 'synthetic-a', name: '合成实例', status: 'running', usage_info: { mem_limit: 100, cpu_usage_percent: 20 } }], result_total: 1 } });
  assert.doesNotMatch(JSON.stringify(result), /password|ssh|jupyter|token/);
});

test('子账号的实例、钱包、账单和监控全部使用官网子账号前缀', async () => {
  for (const [kind, suffix] of [['instances', '/instance'], ['wallet', '/wallet'], ['bills', '/bill/list'], ['monitor', '/instance/monitor']]) {
    const fixture = pageFixture({ storage: { user: '{"sub_name":"synthetic-sub"}', app_version: '{"version":"1.2.3"}' },
      response: { code: 'Success', data: { list: [], result_total: 0 } } });
    await fixture.run(kind, { instanceId: 'synthetic-a' });
    assert.equal(new URL(fixture.calls[0].url).pathname, '/api/v1/sub_user' + suffix);
    assert.equal(fixture.calls[0].options.headers.AppVersion, '1.2.3');
  }
});

test('监控GET使用明确实例UUID，大写UsageInfo且不透传其他字段', async () => {
  const fixture = pageFixture({ response: { code: 'Success', data: { uuid: 'a-b', cpu_number: 8, gpu_number: 1,
    UsageInfo: { cpu_usage_percent: 65, mem_usage: 100, root_password: 'synthetic' }, root_password: 'synthetic' } } });
  const result = await fixture.run('monitor', { instanceId: 'a-b' });
  assert.equal(fixture.calls[0].url, 'https://www.autodl.com/api/v1/instance/monitor?instance_uuid=a-b');
  assert.equal(fixture.calls[0].options.method, 'GET'); assert.equal(fixture.calls[0].options.body, undefined);
  assert.deepEqual(result.data, { uuid: 'a-b', cpu_number: 8, gpu_number: 1, UsageInfo: { cpu_usage_percent: 65, mem_usage: 100 } });
});

test('钱包和账单仅传出已确认字段，未知嵌套对象也不会带出凭据', async () => {
  const wallet = pageFixture({ response: { code: 'Success', data: { assets: 1000, blocked_asset: 10, voucher_balance: 20, token: 'synthetic-private' } } });
  assert.deepEqual((await wallet.run('wallet')).data, { assets: 1000, blocked_asset: 10, voucher_balance: 20 });
  const bills = pageFixture({ response: { code: 'Success', data: { result_total: 1, list: [{ uuid: 'bill1', product_uuid: 'a-b', bill_type: 'charge',
    asset: { token: 'synthetic-hidden' }, details: { charge_from: '2026-11-05 00:00:00', password: 'synthetic-hidden' }, order_uuid: 'order-private' }] } } });
  const result = await bills.run('bills', { page_index: 1 });
  assert.deepEqual(result.data.list[0], { uuid: 'bill1', product_uuid: 'a-b', bill_type: 'charge', details: { charge_from: '2026-11-05 00:00:00' } });
});

test('缺少网页Token、离开官网、未知接口时都不发请求，也不借开发者Token', async () => {
  const noToken = pageFixture({ storage: { token: null, developer_token: 'synthetic-developer-token' } });
  assert.deepEqual(await noToken.run('wallet'), { error: 'AUTH' }); assert.equal(noToken.calls.length, 0);
  const otherOrigin = pageFixture({ origin: 'https://other.example.test' });
  assert.deepEqual(await otherOrigin.run('wallet'), { error: 'SESSION' }); assert.equal(otherOrigin.calls.length, 0);
  const unsupported = pageFixture();
  assert.deepEqual(await unsupported.run('deleteInstance'), { error: 'SESSION' }); assert.equal(unsupported.calls.length, 0);
});

test('官方Success才接受，授权失败与网络错误只返回固定错误码', async () => {
  for (const code of ['success', 0, 'future-code']) assert.deepEqual(await pageFixture({ response: { code, msg: 'synthetic-secret' } }).run('wallet'), { error: 'API' });
  assert.deepEqual(await pageFixture({ response: { code: 'AuthorizeFailed', msg: 'synthetic-secret' } }).run('wallet'), { error: 'AUTH' });
  assert.deepEqual(await pageFixture({ status: 401 }).run('wallet'), { error: 'AUTH' });
  assert.deepEqual(await pageFixture({ throws: true }).run('wallet'), { error: 'NETWORK' });
  assert.deepEqual(await pageFixture({ response: { code: 'Success', data: { list: null } } }).run('instances'), { error: 'SCHEMA' });
});

function adapterFixture(result = { data: { list: [], result_total: 0 } }) {
  const adapter = new AutoDLBrowserAdapter(os.tmpdir()), calls = [];
  adapter.context = {};
  adapter.session = { state: 'ready', checkedAt: 1 };
  adapter.page = { isClosed: () => false, url: () => 'https://www.autodl.com/create', evaluate: async (fn, input) => {
    calls.push({ fn, input }); return result;
  } };
  return { adapter, calls };
}

test('adapter四个方法使用既有页面且只构造只读查询，不导航或建立浏览器', async () => {
  const { adapter, calls } = adapterFixture();
  adapter.browser = async () => { throw Error('must not open browser'); };
  adapter.goto = async () => { throw Error('must not navigate'); };
  await adapter.observatoryInstances({ pageIndex: 2, pageSize: 100 }); await adapter.observatoryWallet();
  await adapter.observatoryMonitor('synthetic-a');
  await adapter.observatoryBills({ dateFrom: '2026-10-02', dateTo: '2026-11-06', pageIndex: 3, pageSize: 500 });
  assert.deepEqual(calls.map(call => call.input.kind), ['instances', 'wallet', 'monitor', 'bills']);
  assert.deepEqual(calls[0].input.params, { date_from: '', date_to: '', page_index: 2, page_size: 100, status: [], charge_type: [] });
  assert.deepEqual(calls[3].input.params, { order_uuid: '', sub_name: '', date_from: '2026-10-02', date_to: '2026-11-06', page_index: 3, page_size: 500, bill_type: '' });
  assert.ok(calls.every(call => call.fn === readObservatoryInPage));
});

test('adapter未核验会话不请求，鉴权失效更新session且异常不暴露页面错误', async () => {
  const { adapter, calls } = adapterFixture({ error: 'AUTH' });
  adapter.session.state = 'unchecked';
  await assert.rejects(adapter.observatoryWallet(), { code: 'OBSERVATORY_SESSION' }); assert.equal(calls.length, 0);
  adapter.session.state = 'ready';
  await assert.rejects(adapter.observatoryWallet(), { code: 'OBSERVATORY_AUTH' }); assert.equal(adapter.session.state, 'expired');
  adapter.session.state = 'ready'; adapter.page.evaluate = async () => { throw Error('synthetic-private-token'); };
  await assert.rejects(readAutodlObservatory(adapter, 'wallet'), error => error.code === 'OBSERVATORY_UNAVAILABLE' && !error.message.includes('synthetic-private-token'));
});
