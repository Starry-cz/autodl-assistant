import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { gate } from './helpers.mjs';
const TOKEN='synthetic-account-wallet-token';
const source=()=>({id:'syntheticsource-abcdef12',region:'北京B区',gpuModel:'A100 80GB',gpuCount:2,stopped:true,running:false});
const config=(extra={})=>({provider:'autodl',mode:'clone',action:'observe',gpuModel:'A100 80GB',gpuCount:2,regions:['北京B区'],sourceId:source().id,maxGpuHourly:3,maxTotalHourly:6,maxStorageDaily:1,...extra});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-account-isolated-'));let rows=[source()],calls=0,walletCalls=0,balance=100000,ready=true,wait=null;
 const autodl=Object.assign(new SyntheticAdapter(),{sessionStatus:()=>({state:ready?'ready':'expired',browserOpen:ready}),instances:async()=>{calls++;if(wait)await wait.promise;return rows;}});
 const app=createApplication({runtimeDir:dir,startEngine:false,adapters:{autodl},walletOptions:{fetchImpl:async()=>{walletCalls++;return new Response(JSON.stringify({code:'Success',data:{assets:balance,voucher_balance:50000}}));}}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await app.close();const target=path.resolve(dir);if(!target.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(target).startsWith('autodl-account-isolated-'))throw Error('bad cleanup');fs.rmSync(target,{recursive:true,force:true});});
 const request=(url,data,headers={})=>fetch(base+url,{method:data===undefined?'GET':'POST',headers:{'X-Local-Token':app.token,...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 return {app,dir,base,request,get calls(){return calls;},get walletCalls(){return walletCalls;},set rows(v){rows=v;},set ready(v){ready=v;},set balance(v){balance=v;},set wait(v){wait=v;}};
}
test('实例同步只返回选择所需字段，轮询状态使用缓存而不访问平台',async t=>{
 const f=await fixture(t);let state=await(await f.request('/api/state')).json();assert.deepEqual(state.autodlInstances.instances,[]);assert.equal(f.calls,0);
 f.rows=[{...source(),sshPassword:'must-not-return',privateUrl:'must-not-return'},{...source(),id:'syntheticrunning-abcdef12',running:true,stopped:false}];
 const result=await(await f.request('/api/autodl/instances',{})).json();assert.equal(result.instances.length,2);assert.equal(result.instances[0].cloneable,true);assert.equal(result.instances[1].cloneable,false);assert.equal(JSON.stringify(result).includes('must-not-return'),false);
 for(let i=0;i<3;i++)state=await(await f.request('/api/state')).json();assert.equal(f.calls,1);assert.equal(state.autodlInstances.instances.length,2);f.ready=false;state=await(await f.request('/api/state')).json();assert.deepEqual(state.autodlInstances.instances,[]);
});
test('新账号接口沿用本地Token和同源限制，无权限不查询实例或余额',async t=>{
 const f=await fixture(t);for(const url of ['/api/autodl/instances','/api/wallet/token','/api/wallet/refresh','/api/wallet/preflight','/api/wallet/clear-token']){
 assert.equal((await f.request(url,{token:TOKEN},{'X-Local-Token':'invalid'})).status,403);assert.equal((await f.request(url,{token:TOKEN},{Origin:'https://untrusted.example.test'})).status,403);}
 assert.equal(f.calls,0);assert.equal(f.walletCalls,0);f.ready=false;assert.equal((await f.request('/api/autodl/instances',{})).status,409);
});
test('实例同步与引擎浏览器操作互斥，等待期间本地状态仍可读取',async t=>{
 const f=await fixture(t),release=gate();f.wait=release;const pending=f.request('/api/autodl/instances',{});
 while(!f.calls)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(f.app.engine.busy,true);assert.equal((await f.request('/api/autodl/instances',{})).status,409);assert.equal((await f.request('/api/state')).status,200);release.resolve();assert.equal((await pending).status,200);assert.equal(f.app.engine.busy,false);
});
test('建立克隆任务重新读取源，拒绝删除、开机、地区不一致或无法识别的源；目标型号和卡数可以与源不同',async t=>{
 const f=await fixture(t);await f.request('/api/autodl/instances',{});
 for(const rows of [[],[{...source(),running:true,stopped:false}],[{...source(),region:'重庆A区'}],[{...source(),gpuModel:''}]]){
 f.rows=rows;const r=await f.request('/api/tasks',config());assert.equal(r.status,409);assert.match((await r.json()).error,/SOURCE_(MISMATCH|UNAVAILABLE)/);assert.equal(f.app.store.tasks().length,0);assert.equal(f.app.engine.busy,false);}
 // 源实例是 A100 40GB × 1，目标选 A100 80GB × 2：克隆到其他型号和卡数；CUDA 不由用户填写，首次检查时从源实例读取。
 f.rows=[{...source(),gpuModel:'A100 40GB',gpuCount:1}];const r=await f.request('/api/tasks',config({copyDataDisk:false,cuda:'13.2'}));assert.equal(r.status,201);
 const {task}=await r.json();assert.equal(task.config.copyDataDisk,false);assert.equal(task.config.gpuModel,'A100 80GB');assert.equal(task.config.gpuCount,2);assert.equal(task.config.cuda,'');assert.equal(f.calls,6);
});
test('余额Token只存在内存，状态和保存文件不回显；清除后预检失效',async t=>{
 const f=await fixture(t);const result=await f.request('/api/wallet/token',{token:TOKEN});assert.equal(result.status,200);assert.equal((await result.json()).wallet.snapshot.balance,100);
 assert.equal((await(await f.request('/api/state')).text()).includes(TOKEN),false);for(const file of fs.readdirSync(f.dir)){const p=path.join(f.dir,file);if(fs.statSync(p).isFile())assert.equal(fs.readFileSync(p,'utf8').includes(TOKEN),false);}
 await f.request('/api/wallet/clear-token',{});assert.equal((await f.request('/api/wallet/refresh',{})).status,409);assert.equal(f.app.wallet.publicState().configured,false);
});
test('真实自动创建和克隆启用余额保护时无Token或余额不足均不入队',async t=>{
 const f=await fixture(t);for(const mode of ['create','clone']){
 const before=f.app.store.tasks().length;const c=config({mode,action:'execute',paidConsent:true,balanceGuard:true,imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1']});
 assert.equal((await f.request('/api/tasks',c)).status,409);f.balance=1000;await f.request('/api/wallet/token',{token:TOKEN});let r=await f.request('/api/tasks',c);assert.equal((await r.json()).error,'BALANCE_INSUFFICIENT');assert.equal(f.app.store.tasks().length,before);
 f.balance=100000;r=await f.request('/api/tasks',c);assert.equal(r.status,201);const {task}=await r.json();assert.equal(task.balanceCheck.basis,'limits');await f.request('/api/tasks/'+task.id+'/cancel',{});await f.request('/api/wallet/clear-token',{});
 }
});
test('余额保护关闭或仅监测可以不配置Token，预算预检本身不要求付费授权',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/tasks',config())).status,201);await f.request('/api/tasks/'+f.app.store.tasks()[0].id+'/cancel',{});
 assert.equal((await f.request('/api/tasks',config({action:'execute',paidConsent:true,balanceGuard:false}))).status,201);assert.equal(f.walletCalls,0);
 await f.request('/api/wallet/token',{token:TOKEN});const r=await f.request('/api/wallet/preflight',config({action:'execute',paidConsent:false,expectedHours:2,balanceReserve:1}));assert.equal(r.status,200);assert.equal((await r.json()).check.required,14);assert.equal(f.app.store.tasks().length,2);
});

