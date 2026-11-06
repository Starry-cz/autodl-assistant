import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const config=(extra={})=>({provider:'autodl',mode:'create',action:'observe',gpuModel:'RTX 4090',regions:['北京B区'],cuda:'12.1',imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1'],pricePolicy:'official',...extra});
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-lifecycle-isolated-'));let ready=true,balance=100000,logouts=0,submits=0;
  const key=randomBytes(32),secretProtector={available:true,method:'isolated AES test',protect(plain){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(plain,'utf8'),c.final()]);return{data:data.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64')};},unprotect(s){const c=createDecipheriv('aes-256-gcm',key,Buffer.from(s.iv,'base64'));c.setAuthTag(Buffer.from(s.tag,'base64'));return Buffer.concat([c.update(Buffer.from(s.data,'base64')),c.final()]).toString('utf8');}};
  const autodl=Object.assign(new SyntheticAdapter(),{sessionStatus:()=>({state:ready?'ready':'not_open',browserOpen:ready}),logout:async()=>{logouts++;ready=false;return{message:'isolated logout'};},submit:async()=>{submits++;throw Error('禁止提交');}});
  const app=createApplication({runtimeDir:dir,startEngine:false,secretProtector,adapters:{autodl},aiOptions:{fetchImpl:()=>{throw Error('禁止模型请求');}},walletOptions:{fetchImpl:async()=>new Response(JSON.stringify({code:'Success',data:{assets:balance,voucher_balance:0}}))}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('autodl-lifecycle-isolated-'));fs.rmSync(target,{recursive:true,force:true});});
  return{app,dir,autodl,secretProtector,set balance(n){balance=n;},get logouts(){return logouts;},get submits(){return submits;},request:(url,data,extra={})=>fetch(base+url,{method:data===undefined?'GET':'POST',headers:{'X-Local-Token':app.token,...(data===undefined?{}:{'Content-Type':'application/json'}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})})};
}
test('HTTP记住三类凭据后磁盘及响应无明文，重载恢复为已配置',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/ai/settings',{enabled:true,rememberKey:true,apiKey:'sk-synthetic-lifecycle-123456'})).status,200);
  assert.equal((await f.request('/api/wallet/token',{token:'synthetic-lifecycle-wallet',rememberToken:true})).status,200);
  assert.equal((await f.request('/api/notifications/settings',{wechatEnabled:true,wechatToken:'synthetic-lifecycle-wechat',rememberCredentials:true})).status,200);
  const raw=fs.readFileSync(path.join(f.dir,'state.json'),'utf8'),state=await(await f.request('/api/state')).json();assert.equal(raw.includes('synthetic-lifecycle'),false);assert.equal(JSON.stringify(state).includes('synthetic-lifecycle'),false);assert.equal(state.wallet.rememberToken,true);assert.equal(state.ai.hasKey,true);assert.equal(state.credentialStorage.available,true);
  const restored=new Store(f.dir,{secretProtector:f.secretProtector});assert.equal(restored.data.walletSettings.token,'synthetic-lifecycle-wallet');assert.equal(restored.data.aiSettings.apiKey,'sk-synthetic-lifecycle-123456');
});
test('退出暂停真实活动任务但保留提交记录及已完成任务，可选清除全部凭据',async t=>{
  const f=await fixture(t);f.app.ai.saveSettings({enabled:true,rememberKey:true,apiKey:'sk-synthetic-logout-123456'});f.app.wallet.setToken('synthetic-logout-wallet',{rememberToken:true});
  const live=f.app.store.create(normalizeConfig(config())),completed=f.app.store.create(normalizeConfig(config()));f.app.store.patch(completed,{state:'completed'});const operation={stage:'accepted',at:Date.now(),receipt:{instanceId:'synthetic-target'}};f.app.store.patch(live,{operation,state:'verifying'});
  const r=await f.request('/api/browser/logout',{});assert.equal(r.status,200);assert.equal((await r.json()).paused,1);assert.equal(live.state,'paused');assert.deepEqual(live.operation,operation);assert.equal(completed.state,'completed');assert.equal(f.app.ai.publicState().hasKey,true);assert.equal(f.app.wallet.publicState().configured,true);assert.equal(f.submits,0);
  const clear=await f.request('/api/browser/logout',{clearCredentials:true});assert.equal(clear.status,200);assert.equal(f.app.ai.publicState().hasKey,false);assert.equal(f.app.wallet.publicState().configured,false);assert.equal(f.app.store.data.settings.rememberCredentials,false);assert.equal(fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes('protectedSecrets'),false);
});
test('退出和报价接口沿用同源权限及互斥，忙碌期间不打断页面操作',async t=>{
  const f=await fixture(t);for(const url of ['/api/browser/logout','/api/pricing/preview']){assert.equal((await f.request(url,config(),{'X-Local-Token':'invalid'})).status,403);assert.equal((await f.request(url,config(),{Origin:'https://untrusted.example.test'})).status,403);}
  f.app.engine.busy=true;try{assert.equal((await f.request('/api/browser/logout',{})).status,409);assert.equal((await f.request('/api/pricing/preview',config())).status,409);}finally{f.app.engine.busy=false;}assert.equal(f.logouts,0);
});
test('余额预检要求完整同配置报价，按官方报价拒绝不足余额，未提交租用',async t=>{
  const f=await fixture(t);await f.request('/api/wallet/token',{token:'synthetic-pricing-wallet'});let r=await f.request('/api/wallet/preflight',config());assert.equal((await r.json()).error,'PRICE_REQUIRED');
  r=await f.request('/api/pricing/preview',config());assert.equal(r.status,200);const p=await r.json();assert.equal(p.source,'AutoDL 官方页面');assert.equal(p.quote.hourly,1.98);
  r=await f.request('/api/wallet/preflight',config({gpuCount:2}));assert.equal((await r.json()).error,'PRICE_REQUIRED');
  r=await f.request('/api/wallet/preflight',config({expectedHours:2}));assert.equal((await r.json()).check.required,3.96);
  f.balance=1000;r=await f.request('/api/tasks',config({action:'execute',paidConsent:true,balanceGuard:true}));assert.equal((await r.json()).error,'BALANCE_INSUFFICIENT');assert.equal(f.app.store.tasks().length,0);assert.equal(f.submits,0);
});
test('无完整报价时可入队监测；找到资源时余额不足不提交、继续监测并提醒，充值后下一次找到资源即提交',async t=>{
  const f=await fixture(t);f.balance=1000;await f.request('/api/wallet/token',{token:'synthetic-pending-wallet'});
  const r=await f.request('/api/tasks',config({action:'execute',paidConsent:true,balanceGuard:true}));assert.equal(r.status,201);const task=f.app.store.tasks()[0];assert.equal(task.balanceCheck.pendingQuote,true);
  await f.app.engine.tick();assert.equal(task.state,'watching');assert.match(task.balanceLow.message,/余额/);assert.equal(task.operation,null);assert.equal(f.submits,0);
  assert.ok(f.app.store.data.notifications.some(n=>n.event==='balance-low'));
  f.balance=100000;task.nextCheckAt=0;await f.app.engine.tick();assert.equal(task.balanceLow,null);assert.equal(f.submits,1);
});
test('余额确定不足以支付页面单卡价时，新建自动任务前就提示充值',async t=>{
  const f=await fixture(t);f.autodl.availableAfter=100;await f.request('/api/wallet/token',{token:'synthetic-lowbound-wallet'});
  const preview=await (await f.request('/api/pricing/preview',config())).json();assert.equal(preview.quote,null);assert.equal(preview.listed[0].price,1.98);
  f.balance=1000;let r=await f.request('/api/tasks',config({action:'execute',paidConsent:true,balanceGuard:true}));
  const body=await r.json();assert.equal(r.status,409);assert.equal(body.error,'BALANCE_INSUFFICIENT');assert.match(body.message,/请先充值/);assert.equal(f.app.store.tasks().length,0);
  f.balance=100000;r=await f.request('/api/tasks',config({action:'execute',paidConsent:true,balanceGuard:true}));assert.equal(r.status,201);
});
test('过期或读取失败的报价失效，不作为余额判断依据',async t=>{
  const f=await fixture(t);await f.request('/api/wallet/token',{token:'synthetic-expired-wallet'});const originalNow=Date.now;
  try{Date.now=()=>1000;await f.request('/api/pricing/preview',config());Date.now=()=>62001;let r=await f.request('/api/wallet/preflight',config());assert.equal((await r.json()).error,'PRICE_REQUIRED');Date.now=()=>1000;f.autodl.probe=async()=>{throw Error('isolated read failure');};assert.equal((await f.request('/api/pricing/preview',config())).status,500);r=await f.request('/api/wallet/preflight',config());assert.equal((await r.json()).error,'PRICE_REQUIRED');}finally{Date.now=originalNow;}
});
test('专用浏览器退出只清理隔离资料目录，异常目录不能递归删除',async t=>{
  const f=await fixture(t),adapter=new AutoDLBrowserAdapter(f.dir),profile=path.join(f.dir,'browser-profile');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'isolated-cookie'),'synthetic');fs.writeFileSync(path.join(f.dir,'keep.txt'),'keep');
  await adapter.logout();assert.equal(fs.existsSync(profile),false);assert.equal(fs.existsSync(path.join(f.dir,'keep.txt')),true);assert.equal(adapter.sessionStatus().browserOpen,false);
  adapter.profileDir=f.dir;await assert.rejects(adapter.logout(),{code:'PROFILE_PATH'});assert.equal(fs.existsSync(path.join(f.dir,'keep.txt')),true);
});


test('重建的余额保护仍在提交前生效，校验失败保留旧任务',async t=>{
  const f=await fixture(t),old=f.app.store.create(normalizeConfig(config()));f.app.store.patch(old,{state:'attention',lastError:'合成旧镜像失效'});
  await f.request('/api/wallet/token',{token:'synthetic-replacement-wallet'});await f.request('/api/pricing/preview',config());f.balance=1000;
  const r=await f.request('/api/tasks',config({replaceTaskId:old.id,action:'execute',paidConsent:true,balanceGuard:true}));
  assert.equal(r.status,409);assert.equal((await r.json()).error,'BALANCE_INSUFFICIENT');assert.equal(old.state,'attention');assert.equal(old.replacedBy,undefined);assert.equal(f.app.store.tasks().length,1);assert.equal(f.submits,0);
});

