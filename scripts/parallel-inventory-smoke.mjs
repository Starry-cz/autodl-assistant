import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { resolveBrowserLaunchOptions } from '../src/browser.mjs';
import { REGIONS } from '../src/config.mjs';
import { readTaskGpuCatalogApi } from '../src/adapters/autodl-inventory.mjs';

// 真实 Chromium + 本地拦截页面。禁用外部域名解析，不使用登录资料、不接触任何付费接口。
const browser = await chromium.launch({ ...await resolveBrowserLaunchOptions(chromium), headless: true,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const reports = [], unexpected = [], errors = [];
const regions = REGIONS.map((region, index) => ({ data_center: `center-${index}`, region_name: region, region_sign: `sign-${index}` }));
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const gpuData = available => [{ 'RTX 4090': { idle_gpu_num: available, total_gpu_num: 8 } }];

async function fixture(name, plan) {
  const context = await browser.newContext();
  const page = await context.newPage(), calls = [], active = new Set(), held = new Map(), bothStarted = gate();
  let peak = 0, cancelled = 0;
  const cancelledRegions = [];
  const drained = gate();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/v1/machine/region/gpu_type') return;
    active.add(request); peak = Math.max(peak, active.size);
  });
  const finish = (request, failed) => {
    if (!active.delete(request)) return;
    if (failed) {
      cancelled++; cancelledRegions.push(Number(request.postDataJSON().region_sign_list[0].replace('sign-', '')));
      held.get(request)?.resolve();
    }
    if (calls.length >= 2 && active.size === 0) drained.resolve();
  };
  page.on('requestfinished', request => finish(request, false));
  page.on('requestfailed', request => finish(request, true));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/synthetic-parallel')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>离线并行库存验收</body>' });
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/api/v1/region/list')
      return route.fulfill({ json: { code: 'Success', data: regions } });
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/api/v1/machine/region/gpu_type' && request.method() === 'POST') {
      const input = request.postDataJSON();
      const index = Number(input.region_sign_list[0].replace('sign-', ''));
      const spec = plan(index), release = gate(); held.set(request, release);
      calls.push(index); if (calls.length === 2) bothStarted.resolve();
      try {
        if (spec.hold) await release.promise;
        else await new Promise(done => setTimeout(done, spec.delay ?? 60));
        // 浏览器已取消时不再向该路由发送迟到响应。
        if (!active.has(request)) return;
        await route.fulfill({ status: spec.status ?? 200,
          json: { code: spec.code ?? 'Success', data: spec.data ?? gpuData(spec.available ?? 0) } });
      } finally { held.delete(request); }
      return;
    }
    unexpected.push(request.method() + ' ' + url.pathname); await route.abort();
  });
  await page.goto('https://www.autodl.com/synthetic-parallel');
  await page.evaluate(() => {
    localStorage.setItem('token', 'synthetic-only-token'); localStorage.setItem('user', '{}');
  });
  const adapter = { page, session: { state: 'ready' }, setSession(state) { this.session.state = state; } };
  return { page, calls, bothStarted: bothStarted.promise,
    run: () => readTaskGpuCatalogApi(adapter, REGIONS, 'RTX 4090'),
    releaseFirst: () => held.values().next().value?.resolve(),
    async complete() {
      // 等待浏览器的终结事件确认网络已收尾，不仅检查外层 Promise 已返回。
      await Promise.race([drained.promise, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('批次结束后仍有未清理请求')), 2000); timer.unref?.();
      })]);
      assert.equal(active.size, 0); assert.ok(peak <= 2, '真实浏览器在途请求不能超过 2');
      reports.push({ scenario: name, requests: calls.length, peak, cancelled, cancelledRegions, activeAfterBatch: active.size });
    },
    async close() { for (const release of held.values()) release.resolve(); await context.close(); },
  };
}

try {
  // 慢的首地区不能挡住第二地区已返回的库存；首个批次内命中后不派发第三地区。
  const fast = await fixture('slow-first-fast-second', index => index === 0 ? { hold: true } : { available: 2 });
  try {
    const result = await fast.run(); await fast.complete();
    assert.deepEqual(fast.calls, [0, 1]);
    assert.ok(result.regions.some(row => row.region === REGIONS[1] && row.models[0].available === 2));
    assert.deepEqual(reports.at(-1).cancelledRegions, [0]);
    // 批次已经释放网络资源后，主页面可立即进入后续流程。
    await fast.page.goto('https://www.autodl.com/synthetic-parallel');
  } finally { await fast.close(); }

  const zero = await fixture('all-regions-zero', () => ({}));
  try {
    const result = await zero.run(); await zero.complete();
    assert.equal(zero.calls.length, REGIONS.length);
    assert.deepEqual(result.regions.map(row => row.region), REGIONS);
    assert.ok(result.regions.every(row => row.models[0].available === 0));
    assert.equal(reports.at(-1).peak, 2); assert.equal(reports.at(-1).cancelled, 0);
  } finally { await zero.close(); }

  const limited = await fixture('rate-limit-cancels-sibling', index => index === 0 ? { status: 429 } : { hold: true });
  try {
    await assert.rejects(limited.run(), error => error.code === 'INVENTORY_UNAVAILABLE' && error.retryable);
    await limited.complete(); assert.deepEqual(limited.calls, [0, 1]);
    // 429 在响应头就能判定；批次取消也可能中止这份无需再读的错误响应正文。
    assert.ok(reports.at(-1).cancelledRegions.includes(1));
  } finally { await limited.close(); }

  const switched = await fixture('account-change-cancels-batch', () => ({ hold: true }));
  try {
    const read = switched.run();
    // 先挂拒绝断言，避免网络取消先返回时产生测试自身的未处理拒绝。
    const rejected = assert.rejects(read, error => error.code === 'INVENTORY_SESSION');
    await switched.bothStarted;
    await switched.page.evaluate(() => localStorage.setItem('token', 'synthetic-other-token'));
    switched.releaseFirst(); await rejected; await switched.complete();
    assert.deepEqual(switched.calls, [0, 1]); assert.ok(reports.at(-1).cancelledRegions.includes(1));
  } finally { await switched.close(); }

  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  await fs.mkdir(new URL('../output/playwright/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('../output/playwright/parallel-inventory-smoke.json', import.meta.url),
    JSON.stringify({ synthetic: true, reports, unexpected, errors }, null, 2));
  console.log(JSON.stringify({ synthetic: true, reports, unexpected, errors }, null, 2));
} finally { await browser.close(); }
