import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { readInventoryInPage } from '../src/adapters/autodl-inventory.mjs';

// 执行实际浏览器函数，以可控响应替代网络；只验证并发与取消合同，不读取本机账号。
const zero = [{ 'RTX 4090': { idle_gpu_num: 0, total_gpu_num: 8 } }];
const positive = [{ 'RTX 4090': { idle_gpu_num: 2, total_gpu_num: 8, token: 'synthetic-private' } }];
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(count = 6) {
  const groups = Array.from({ length: count }, (_, i) => ({ region: `合成地区${i}`, signs: [`sign-${i}`] }));
  const storage = { token: 'synthetic-token', user: '{}' }, requests = [];
  let active = 0, peak = 0, cancelled = 0;
  const pending = vm.runInNewContext(`(${readInventoryInPage.toString()})(input)`, {
    URL, AbortSignal, AbortController, location: { origin: 'https://www.autodl.com' },
    input: { kind: 'task-gpus', params: { groups, modelKey: 'RTX4090' } },
    localStorage: { getItem: key => storage[key] ?? null },
    fetch: async (url, options) => {
      active++; peak = Math.max(peak, active);
      let finish, cancel;
      const response = new Promise((resolve, reject) => {
        finish = (data = zero, status = 200, code = 'Success') => resolve({ status, ok: status >= 200 && status < 300,
          json: async () => ({ code, data }) });
        cancel = () => { cancelled++; reject(new Error('synthetic-abort')); };
        options.signal.addEventListener('abort', cancel, { once: true });
      });
      requests.push({ url, params: JSON.parse(options.body), finish });
      try { return await response; }
      finally { active--; options.signal.removeEventListener('abort', cancel); }
    },
  }).then(result => JSON.parse(JSON.stringify(result)));
  return { groups, storage, requests, pending, active: () => active, peak: () => peak, cancelled: () => cancelled };
}

test('慢首区不会阻挡快次区命中，取消其他请求并全部收尾后才返回', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 2); assert.equal(f.active(), 2);
  f.requests[1].finish(positive);
  const result = await f.pending;
  assert.deepEqual(result.data.map(row => row.region), ['合成地区1']);
  assert.equal(result.data[0].data[0]['RTX 4090'].idle_gpu_num, 2);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|token/);
  assert.equal(f.requests.length, 2, '命中后不再派发第三区');
  assert.equal(f.cancelled(), 1); assert.equal(f.active(), 0); assert.equal(f.peak(), 2);
});

test('全零按空出的工作位继续读取，峰值为2且结果仍按用户地区顺序排列', async () => {
  const f = fixture();
  // 首区始终较慢，另一个工作位顺次读取其余地区；结果不能按返回顺序重排。
  for (let i = 1; i < 6; i++) { assert.equal(f.requests.length, i + 1); f.requests[i].finish(); await turn(); }
  assert.equal(f.active(), 1);
  f.requests[0].finish();
  const result = await f.pending;
  assert.deepEqual(result.data.map(row => row.region), f.groups.map(group => group.region));
  assert.equal(result.data.length, 6); assert.equal(f.active(), 0); assert.equal(f.peak(), 2);
  assert.equal(f.cancelled(), 0);
});

test('仅监测一个地区时只发一个查询，不创建额外并发请求', async () => {
  const f = fixture(1);
  f.requests[0].finish();
  assert.equal((await f.pending).data.length, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.peak(), 1); assert.equal(f.active(), 0);
});

test('429保留可退避错误并取消其他请求，不把部分零库存当作全部无卡', async () => {
  const f = fixture();
  f.requests[1].finish([], 429);
  assert.deepEqual(await f.pending, { error: 'TRANSIENT' });
  assert.equal(f.requests.length, 2); assert.equal(f.cancelled(), 1); assert.equal(f.active(), 0);
});

test('已经明确返回的登录失效优先于同批库存命中', async () => {
  const f = fixture();
  f.requests[0].finish(positive); f.requests[1].finish([], 401);
  assert.deepEqual(await f.pending, { error: 'AUTH' });
  assert.equal(f.requests.length, 2); assert.equal(f.active(), 0);
});

test('Token、子账号或账号资料变化使整批失效，停止派发并收尾', async () => {
  for (const change of [storage => { storage.token = 'synthetic-other-token'; },
    storage => { storage.user = '{"sub_name":"synthetic-sub"}'; }, storage => { storage.user = '{'; }]) {
    const f = fixture(); change(f.storage); f.requests[1].finish(positive);
    assert.deepEqual(await f.pending, { error: 'CHANGED' });
    assert.equal(f.requests.length, 2); assert.equal(f.active(), 0); assert.equal(f.cancelled(), 1);
  }
});

test('空型号目录属于未知，停止预筛交还DOM，不伪造成零库存', async () => {
  const f = fixture(); f.requests[1].finish([]);
  const result = await f.pending;
  assert.deepEqual(result.data, [{ region: '合成地区1', data: [] }]);
  assert.equal(f.cancelled(), 1); assert.equal(f.active(), 0); assert.equal(f.requests.length, 2);
});

// 原生 fetch 的响应头和响应体是两个阶段：只有实际读取挂起正文，才能覆盖提前释放工作位的回归。
async function streamingFixture(t, { controlledTimeout = false } = {}) {
  const responses = new Map(), closed = new Set(), deadlines = [], bodyReads = new Set();
  let readersReady, requestsClosed;
  const bothReading = new Promise(resolve => readersReady = resolve);
  const bothClosed = new Promise(resolve => requestsClosed = resolve);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const index = Number(JSON.parse(Buffer.concat(chunks).toString()).region_sign_list[0]);
    responses.set(index, response);
    response.on('close', () => { closed.add(index); if (closed.size === 2) requestsClosed(); });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const pending = vm.runInNewContext(`(${readInventoryInPage.toString()})(input)`, {
    URL, AbortController, location: { origin: 'https://www.autodl.com' },
    input: { kind: 'task-gpus', params: { modelKey: 'RTX4090', groups: Array.from({ length: 6 }, (_, i) => ({ region: String(i), signs: [String(i)] })) } },
    localStorage: { getItem: key => key === 'token' ? 'synthetic-token' : null },
    // 不等待真实 15 秒：在两个原生正文读取已挂起后，确定性地触发同一超时信号。
    AbortSignal: { any: signals => AbortSignal.any(signals), timeout: ms => {
      assert.equal(ms, 15000);
      if (!controlledTimeout) return AbortSignal.timeout(ms);
      const controller = new AbortController(); deadlines.push(controller); return controller.signal;
    } },
    fetch: async (_url, options) => {
      const index = Number(JSON.parse(options.body).region_sign_list[0]);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/inventory`, options);
      const readJson = response.json.bind(response);
      response.json = () => { bodyReads.add(index); if (bodyReads.size === 2) readersReady(); return readJson(); };
      return response;
    },
  }).then(result => JSON.parse(JSON.stringify(result)));
  return { pending, bothReading, bothClosed, responses, closed, deadlines,
    finish(index, data) { responses.get(index).end(JSON.stringify({ code: 'Success', data }).slice(1)); } };
}

test('收到响应头后正文挂起，另一地区命中仍取消原生正文读取并关闭连接', { timeout: 5000 }, async t => {
  const f = await streamingFixture(t);
  await f.bothReading; f.finish(1, positive);
  const result = await f.pending; await f.bothClosed;
  assert.deepEqual(result.data.map(row => row.region), ['1']);
  assert.equal(f.responses.size, 2, '命中后不能派发第三个地区');
  assert.deepEqual([...f.closed].sort(), [0, 1]);
});

test('原生正文读取超时会取消另一地区并返回可退避错误，不能报告部分零库存', { timeout: 5000 }, async t => {
  const f = await streamingFixture(t, { controlledTimeout: true });
  await f.bothReading;
  f.deadlines[1].abort(new DOMException('synthetic timeout', 'TimeoutError'));
  assert.deepEqual(await f.pending, { error: 'NETWORK' });
  await f.bothClosed;
  assert.equal(f.responses.size, 2, '超时后不能继续派发地区');
  assert.deepEqual([...f.closed].sort(), [0, 1]);
});
