import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, BALANCE_URL, estimateBudget } from '../src/wallet.mjs';
import { testConfig as normalizeConfig } from './fixtures/config.mjs';
import { gate } from './helpers.mjs';
const TOKEN = 'synthetic-autodl-token-never-real';
const cfg = (extra={}) => normalizeConfig({gpuModel:'RTX 4090',maxTotalHourly:2,maxStorageDaily:0,expectedHours:2,...extra});
const response = (assets=10000,voucher_balance=50000) => new Response(JSON.stringify({code:'Success',data:{assets,voucher_balance}}));
function fixture(options={}) { const wallet=new Wallet({fetchImpl:async()=>response(),...options});wallet.setToken(TOKEN);return wallet; }
test('余额请求固定官方POST和原始Authorization，千分元换算且公共状态无Token',async()=>{
  let calls=0;const w=fixture({fetchImpl:async(url,options)=>{calls++;assert.equal(url,BALANCE_URL);assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,TOKEN);assert.equal(options.redirect,'error');return response(12345,6789);}});
  const value=await w.refresh();assert.deepEqual([value.balance,value.vouchers],[12.345,6.789]);await w.refresh();assert.equal(calls,1);assert.equal(JSON.stringify(w.publicState()).includes(TOKEN),false);w.close();
});
test('没有Token时拒绝余额判断，字符串布尔配置不能绕过选项',async()=>{
  const w=new Wallet({fetchImpl:async()=>{throw Error('不得请求');}});await assert.rejects(w.check(cfg()),e=>e.code==='BALANCE_TOKEN_REQUIRED');
  for(const key of ['copyDataDisk','balanceGuard','includeVouchers'])assert.throws(()=>cfg({[key]:'false'}),e=>e.code==='CONFIG');
  for(const token of ['', 'has space', 'a\nb'])assert.throws(()=>w.setToken(token),e=>e.code==='WALLET_TOKEN');
});
test('预算按总价和整天磁盘费用计算，向上取整且未知实际报价不能回退上限',()=>{
  assert.equal(estimateBudget(cfg({maxTotalHourly:0.1,expectedHours:0.1,maxStorageDaily:0.001})).requiredMilli,11);
  const budget=estimateBudget(cfg({expectedHours:25,balanceReserve:0.5}),{hourly:0.333,storageDaily:0.1});
  assert.equal(budget.storageDays,2);assert.equal(budget.requiredMilli,9025);assert.equal(budget.basis,'quote');
  assert.equal(estimateBudget(cfg(),{hourly:0.10001,storageDaily:0}).requiredMilli,201);
  for(const quote of [{hourly:null,storageDaily:0},{hourly:1,storageDaily:null},{hourly:NaN,storageDaily:0},{}])assert.throws(()=>estimateBudget(cfg(),quote),e=>e.code==='BALANCE_QUOTE');
});
test('余额不足拒绝提交；代金券默认排除，显式开启后才计入',async()=>{
  const w=fixture({fetchImpl:async()=>response(3999,10000)});
  await assert.rejects(w.check(cfg()),e=>e.code==='BALANCE_INSUFFICIENT');
  const check=await w.check(cfg({includeVouchers:true}));assert.equal(check.sufficient,true);assert.equal(check.available,13.999);w.confirm(check);w.close();
});
test('负余额不能因为代金券未勾选而通过',async()=>{
  const w=fixture({fetchImpl:async()=>response(-1000,100000)});await assert.rejects(w.check(cfg()),e=>e.code==='BALANCE_INSUFFICIENT');w.close();
});
test('30秒缓存到期刷新；强制刷新绕过缓存，查询失败使旧证据失效',async()=>{
  let now=100000,calls=0,broken=false;const w=fixture({clock:()=>now,fetchImpl:async()=>{calls++;if(broken)throw Error(TOKEN);return response();}});
  const check=await w.check(cfg());now+=30000;w.confirm(check);await w.refresh();assert.equal(calls,1);now++;assert.equal(w.publicState().stale,true);assert.throws(()=>w.confirm(check),e=>e.code==='BALANCE_STALE');
  await w.refresh();assert.equal(calls,2);broken=true;await assert.rejects(w.refresh({force:true}));assert.equal(calls,3);assert.equal(JSON.stringify(w.publicState()).includes(TOKEN),false);assert.throws(()=>w.confirm(check),e=>e.code==='BALANCE_STALE');w.close();
});
test('拒绝HTTP错误、业务失败、无效金额、过大或无效JSON，不回显上游正文',async()=>{
  const values=[new Response(TOKEN,{status:401}),new Response(TOKEN,{status:500}),new Response(JSON.stringify({code:'Fail',msg:TOKEN})),new Response('{'),new Response('x'.repeat(65537)),new Response(JSON.stringify({code:'Success',data:{assets:'1000',voucher_balance:0}})),response(10000,-1),response(0.5,0)];
  for(const value of values){const w=fixture({fetchImpl:async()=>value});await assert.rejects(w.refresh(),e=>!e.message.includes(TOKEN));assert.equal(w.publicState().snapshot,null);assert.equal(JSON.stringify(w.publicState()).includes(TOKEN),false);w.close();}
});
test('并发刷新只发一个请求；清除Token后迟到响应不能恢复余额',async()=>{
  const started=gate(),release=gate();let calls=0,signal;const w=fixture({fetchImpl:async(_u,o)=>{calls++;signal=o.signal;started.resolve();await release.promise;return response();}});
  const first=w.refresh(),second=w.refresh();const settled=Promise.allSettled([first,second]);await started.promise;w.clearToken();assert.equal(signal.aborted,true);release.resolve();const results=await settled;assert.equal(calls,1);assert.equal(results.every(r=>r.status==='rejected'&&r.reason.code==='BALANCE_CHANGED'),true);assert.equal(w.publicState().configured,false);assert.equal(w.publicState().snapshot,null);
});
test('替换Token取消旧请求，旧结果不会覆盖新凭证的余额',async()=>{
  const release=gate();const w=fixture({fetchImpl:async(_u,o)=>{if(o.headers.Authorization===TOKEN){await release.promise;return response(999999);}return response(5000);}});
  const old=w.refresh();const oldResult=assert.rejects(old,e=>e.code==='BALANCE_CHANGED');w.setToken('synthetic-replacement-token');await w.refresh();release.resolve();await oldResult;assert.equal(w.publicState().snapshot.balance,5);w.close();
});
test('刷新超时会中止请求并禁止使用余额',async()=>{
  const w=fixture({timeoutMs:5,fetchImpl:async(_u,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error(TOKEN)),{once:true}))});
  await assert.rejects(w.refresh(),e=>e.code==='BALANCE_UNAVAILABLE'&&e.message.includes('超时')&&!e.message.includes(TOKEN));assert.equal(w.publicState().snapshot,null);w.close();
});
test('点击边界再次检查余额下降、凭证替换和清除',async()=>{
  let assets=10000;const w=fixture({fetchImpl:async()=>response(assets)});const check=await w.check(cfg());assets=3999;await w.refresh({force:true});assert.throws(()=>w.confirm(check),e=>e.code==='BALANCE_INSUFFICIENT');
  w.setToken('synthetic-other-token');assert.throws(()=>w.confirm(check),e=>e.code==='BALANCE_STALE');await w.refresh();w.clearToken();assert.throws(()=>w.confirm(check),e=>e.code==='BALANCE_STALE');
});
test('多卡预算不低于“单卡价 × 卡数”；租多卡时钱包余额（不含代金券）需大于 10 元', async () => {
  const four = cfg({ gpuCount: 4, expectedHours: 1 });
  assert.equal(estimateBudget(four, { hourly: 2.18, storageDaily: 0, host: { price: 2.18 } }).hourly, 8.72);
  assert.equal(estimateBudget(four, { hourly: 9, storageDaily: 0, host: { price: 2.18 } }).hourly, 9);
  const w = fixture({ fetchImpl: async () => response(5000, 100000) });
  await assert.rejects(w.check(cfg({ gpuCount: 2, includeVouchers: true }), { hourly: 2, storageDaily: 0 }), e => e.code === 'BALANCE_INSUFFICIENT' && /大于 10 元/.test(e.message));
  assert.equal((await w.check(cfg({ gpuCount: 1, includeVouchers: true }), { hourly: 1, storageDaily: 0 })).sufficient, true); w.close();
});

test('多卡提交前余额下降时，代金券或低预算不能绕过现金余额下限', async () => {
  let assets = 12000;
  const w = fixture({ fetchImpl: async () => response(assets, 100000) });
  try {
    const check = await w.check(cfg({ gpuCount: 2, includeVouchers: true, expectedHours: 1 }), { hourly: 2, storageDaily: 0 });
    // 预检通过后，另一次余额刷新读到现金下降；即便总余额仍覆盖预算也必须阻止提交。
    assets = 10000;
    await w.refresh({ force: true });
    assert.throws(() => w.confirm(check), error => error.code === 'BALANCE_INSUFFICIENT' && /大于 10 元/.test(error.message));
    assets = 10001;
    await w.refresh({ force: true });
    assert.doesNotThrow(() => w.confirm(check));
  } finally { w.close(); }
});

