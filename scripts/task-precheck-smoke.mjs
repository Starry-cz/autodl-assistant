import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveBrowserLaunchOptions } from '../src/browser.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { accountOwnerId } from '../src/account-scope.mjs';
import { testConfig } from '../tests/fixtures/config.mjs';
import { gate } from '../tests/helpers.mjs';

// 真实 Chromium 运行生产读取逻辑；独立上下文只接收合成响应，并禁用外部域名解析。
const browser = await chromium.launch({...await resolveBrowserLaunchOptions(chromium), headless:true,
  args:['--host-resolver-rules=MAP * ~NOTFOUND']});
try {
  const context = await browser.newContext({serviceWorkers:'block'});
  const main = await context.newPage();
  const origin = 'https://www.autodl.com', mainUrl = origin+'/synthetic-workspace';
  const accountId = 'synthetic-account', ownerId = accountOwnerId(accountId);
  const gpuModel = 'RTX 4090', regions = ['北京B区','西北B区','重庆A区'];
  const calls = [], unexpected = [];
  const holds = new Map();
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.url() === mainUrl)
      return route.fulfill({contentType:'text/html', body:'<!doctype html><title>离线任务主页面</title>'});
    if (url.origin !== origin || req.headers().authorization !== 'synthetic-test-token') {
      unexpected.push(url.pathname); return route.abort();
    }
    const reply = data => route.fulfill({json:{code:'Success', data}});
    const reader = req.frame().page();
    calls.push({path:url.pathname, page:reader});
    if (req.method() === 'GET' && url.pathname === '/api/v1/user/detail') return reply({uuid:accountId});
    if (req.method() === 'GET' && url.pathname === '/api/v1/region/list')
      return reply(regions.map((name,i) => ({data_center:'center-'+i, region_name:name, region_sign:'sign-'+i})));
    if (req.method() === 'POST' && url.pathname === '/api/v1/machine/region/gpu_type') {
      const sign = req.postDataJSON().region_sign_list[0], hold = holds.get(sign);
      if (hold) {
        hold.entered.resolve();
        await hold.resume.promise;
        if (reader.isClosed()) return;
      }
      return reply([{[gpuModel]:{idle_gpu_num:sign === 'sign-0' ? 0 : 2, total_gpu_num:8}}]);
    }
    unexpected.push(req.method()+' '+url.pathname); return route.abort();
  });
  await main.goto(mainUrl);
  await main.evaluate(() => localStorage.setItem('token', 'synthetic-test-token'));
  const adapter = new AutoDLBrowserAdapter('.');
  Object.assign(adapter, {context, page:main, browserMode:'background'});
  adapter.setSession('ready');
  const probe = (i, options = {}) => adapter.isolatedPrecheck({
    id:'task-'+i, ownerId, config:testConfig({regions:[regions[i]], gpuModel}),
  }, {expectedOwnerId:ownerId, maxParallel:3, signal:AbortSignal.timeout(10000), ...options});
  const startHeld = async (index, options = {}) => {
    const hold = {entered:gate(), resume:gate()};
    holds.set('sign-'+index,hold);
    const read = probe(index, options);
    await Promise.race([hold.entered.promise, read.then(() => { throw Error('未进入预期的库存请求'); })]);
    return {read, resume:() => { holds.delete('sign-'+index); hold.resume.resolve(); }};
  };
  // 两个慢查询仍在途，第三个任务能独立命中并释放自己的标签页。
  const first = await startHeld(0);
  const middle = await startHeld(1);
  try {
    const fast = await probe(2);
    assert.equal(fast.ownerId, ownerId); assert.equal(fast.verdict, 'candidate');
    assert.equal(context.pages().length, 3, '两个慢任务尚未结束时，快任务已收到结果并关闭自己的页面');
  } finally { first.resume(); middle.resume(); }
  assert.equal((await middle.read).verdict, 'candidate');
  const slow = await first.read;
  assert.equal(slow.verdict, 'empty'); assert.equal(slow.ownerId, ownerId);
  assert.deepEqual(context.pages(), [main]);

  // 用户中途切换账号时，即使旧账号的合成库存响应到达，也不能当作当前任务的有效库存。
  const second = await startHeld(0);
  await main.evaluate(() => localStorage.setItem('token', 'synthetic-changed-token'));
  second.resume();
  await assert.rejects(second.read);
  assert.deepEqual(context.pages(), [main]);
  await main.evaluate(() => localStorage.setItem('token', 'synthetic-test-token'));

  const controller = new AbortController();
  const third = await startHeld(0,{signal:controller.signal});
  controller.abort();
  try { await assert.rejects(third.read); } finally { third.resume(); }
  assert.deepEqual(context.pages(), [main]);
  assert.equal(main.url(), mainUrl);
  assert.equal(adapter.page, main);
  assert.ok(calls.length > 0 && calls.every(call => call.page !== main));
  assert.deepEqual(unexpected, []);
  console.log('通过：三任务独立页面、先返回先取结果、账号切换丢弃结果、取消释放页面以及主页面隔离。');
} finally { await browser.close(); }
