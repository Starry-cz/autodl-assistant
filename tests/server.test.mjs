import { configInput } from './fixtures/config.mjs';
import { syntheticImageOptions } from './fixtures/images.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplication, inspectRunningBackend, describeRunningBackend, stopRunningBackend, lockReleased } from '../src/server.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from './fixtures/gpu-catalog.mjs';
async function localApp(t, aiOptions = {}, options = {}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-http-isolated-'));
  // 真实账号适配器也是内存合成会话，不能连接平台或产生费用。
  const autodl=Object.assign(new SyntheticAdapter(),{imageOptions:syntheticImageOptions,instances:async(model)=>[{id:'synthetic-source',region:'北京B区',gpuModel:model||'RTX 4090',gpuCount:1,stopped:true,running:false}],sessionStatus:()=>({state:'ready',label:'合成会话，仅测试',message:'未连接真实账号',browserOpen:true,checkedAt:1})});
  const app=createApplication({runtimeDir:dir,adapters:{autodl},startEngine:false,aiOptions,...options});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('autodl-http-isolated-'))throw Error('invalid test cleanup target');fs.rmSync(resolved,{recursive:true,force:true});});
  return {app,dir,base,request:(url,data)=>fetch(base+url,{method:data===undefined?'GET':'POST',headers:{'X-Local-Token':app.token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(url==='/api/tasks'?configInput(data):data)})})};
}
test('本地HTTP健康、首页令牌注入与静态资源正常',async t=>{
  const f=await localApp(t);assert.equal((await (await fetch(f.base+'/api/health')).json()).ok,true);
  const home=await fetch(f.base);assert.match(await home.text(),new RegExp(f.app.token));assert.equal(home.headers.get('x-frame-options'),'DENY');assert.match(home.headers.get('content-security-policy'),/default-src 'self'/);
  assert.equal((await fetch(f.base+'/app.js')).status,200);assert.equal((await fetch(f.base+'/not-a-page')).status,404);
});
test('任务接口要求本地令牌，合法请求返回队列状态',async t=>{
  const f=await localApp(t);assert.equal((await fetch(f.base+'/api/state')).status,403);
  const response=await f.request('/api/tasks',{provider:'autodl',gpuModel:'RTX 4090',mode:'clone',action:'execute',paidConsent:true});assert.equal(response.status,201);const {task}=await response.json();assert.equal(task.state,'queued');
  const state=await (await f.request('/api/state')).json();assert.equal(state.tasks.length,1);assert.equal(state.tasks[0].config.mode,'clone');
});
test('HTTP暂停恢复停止不接触云端实例',async t=>{
  const f=await localApp(t),{task}=await (await f.request('/api/tasks',{provider:'autodl',gpuModel:'RTX 4090'})).json();
  for(const [action,state] of [['pause','paused'],['resume','watching'],['cancel','cancelled']]){const response=await f.request(`/api/tasks/${task.id}/${action}`,{});assert.equal(response.status,200);assert.equal((await response.json()).task.state,state);}
});
test('真实执行未经费用确认不创建任务，重复真实任务被阻止',async t=>{
  const f=await localApp(t);const live={gpuModel:'RTX 4090',provider:'autodl',mode:'clone',sourceId:'synthetic-source',maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5};
  assert.equal((await f.request('/api/tasks',{...live,action:'execute'})).status,400);assert.equal(f.app.store.tasks().length,0);
  assert.equal((await f.request('/api/tasks',{...live,action:'observe'})).status,201);assert.equal((await f.request('/api/tasks',{...live,action:'observe'})).status,409);
});
test('通知配置保存但API始终掩码凭证，不发真实通知',async t=>{
  const f=await localApp(t);const response=await f.request('/api/notifications/settings',{webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify',webhookToken:'synthetic-test-secret'});assert.equal(response.status,200);
  const saved=await response.json();assert.equal(saved.settings.webhookToken,'***');assert.equal(saved.settings.webhookUrl,'***');assert.equal(JSON.stringify(saved).includes('synthetic-test-secret'),false);
  const state=await (await f.request('/api/state')).json();assert.equal(state.settings.webhookToken,'***');assert.equal(state.settings.webhookUrl,'***');assert.equal(JSON.stringify(state).includes('synthetic-test-secret'),false);
});

test('测试通知接口需本机授权，使用保存的配置且不创建任务或通知队列', async t => {
  const f = await localApp(t), sent = [];
  f.app.engine.notifier.fetch = async (url, options) => { sent.push({ url, options }); return new Response(null, { status: 204 }); };
  const route = '/api/notifications/test';
  assert.equal((await fetch(f.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"channel":"webhook"}' })).status, 403);
  assert.equal((await fetch(f.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': f.app.token, Origin: 'https://untrusted.example.test' }, body: '{"channel":"webhook"}' })).status, 403);
  assert.equal((await f.request(route, { channel: 'webhook' })).status, 400);
  assert.equal((await f.request(route, { channel: 'other' })).status, 400);
  assert.equal(sent.length, 0);
  await f.request('/api/notifications/settings', { webhookEnabled: true, webhookUrl: 'https://saved.example.test/notify', webhookToken: 'saved-synthetic-token', rememberCredentials: false });
  // 请求中额外附带的地址和 Token 不得覆盖已保存配置。
  const response = await f.request(route, { channel: 'webhook', webhookUrl: 'https://unsaved.example.test', webhookToken: 'unsaved-token' });
  const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.test.success, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://saved.example.test/notify'); assert.equal(sent[0].options.headers.Authorization, 'Bearer saved-synthetic-token');
  assert.equal(JSON.stringify(result).includes('saved-synthetic-token'), false);
  assert.equal(f.app.store.tasks().length, 0); assert.equal(f.app.store.data.notifications.length, 0);
  const repeated = await f.request(route, { channel: 'webhook' }); assert.equal(repeated.status, 429); assert.match((await repeated.json()).message, /秒后再试/); assert.equal(sent.length, 1);
});

test('测试通知明确返回业务失败而非成功，保存新配置不会混用旧回执', async t => {
  const f = await localApp(t);
  await f.request('/api/notifications/settings', { wechatEnabled: true, wechatToken: 'synthetic-wechat-private', rememberCredentials: false });
  f.app.engine.notifier.fetch = async () => Response.json({ code: 'InvalidToken', msg: 'synthetic-wechat-private 已失效' });
  const failed = await f.request('/api/notifications/test', { channel: 'wechat' }), data = await failed.json();
  assert.equal(failed.status, 200); assert.equal(data.test.success, false); assert.equal(data.test.code, 'NOTIFICATION_REJECTED');
  assert.match(data.test.message, /已失效/); assert.equal(JSON.stringify(data).includes('synthetic-wechat-private'), false);
  await f.request('/api/notifications/settings', { webhookEnabled: true, webhookUrl: 'https://saved.example.test/notify', rememberCredentials: false });
  let entered, release; const entry = new Promise(resolve => entered = resolve), hold = new Promise(resolve => release = resolve);
  f.app.engine.notifier.fetch = async () => { entered(); await hold; return new Response(null, { status: 204 }); };
  const pending = f.request('/api/notifications/test', { channel: 'webhook' }); await entry;
  try { await f.request('/api/notifications/settings', { webhookEnabled: true, webhookUrl: 'https://changed.example.test/notify', rememberCredentials: false }); }
  finally { release(); }
  const changed = await pending; assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'NOTIFICATION_CONTEXT_CHANGED');
});

test('通知配置修订阻止旧页面误发到新地址或覆盖新配置，修订随状态持久化', async t => {
  const f = await localApp(t), sent = [];
  f.app.engine.notifier.fetch = async url => { sent.push(url); return new Response(null, { status: 204 }); };
  const oldState = await (await f.request('/api/state')).json();
  assert.equal(oldState.notificationSettingsRevision, 0);
  const save = async (url, revision) => (await f.request('/api/notifications/settings', {
    webhookEnabled: true, webhookUrl: url, rememberCredentials: false, expectedRevision: revision,
  })).json();
  const first = await save('https://first.example.test/notify', 0);
  const second = await save('https://second.example.test/notify', first.notificationSettingsRevision);
  assert.equal(first.notificationSettingsRevision, 1); assert.equal(second.notificationSettingsRevision, 2);
  assert.equal(second.settings.webhookUrl, '***');
  // 两个地址都显示同一掩码，旧页必须依靠修订号拒绝发送，不能凭表单字符串判断相同。
  for (const [route, body] of [
    ['/api/notifications/test', { channel: 'webhook', expectedRevision: first.notificationSettingsRevision }],
    ['/api/notifications/settings', { ...first.settings, expectedRevision: first.notificationSettingsRevision }],
  ]) {
    const response = await f.request(route, body); assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'NOTIFICATION_SETTINGS_CHANGED');
  }
  assert.deepEqual(sent, []); assert.equal(f.app.store.data.settings.webhookUrl, 'https://second.example.test/notify');
  const current = await (await f.request('/api/state')).json();
  assert.equal(current.notificationSettingsRevision, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).notificationSettingsRevision, 2);
  const delivered = await f.request('/api/notifications/test', { channel: 'webhook', expectedRevision: 2 });
  assert.equal((await delivered.json()).test.success, true); assert.deepEqual(sent, ['https://second.example.test/notify']);
});

test('通知配置保存失败回滚修订和设置，无效修订不改变当前配置', async t => {
  const f = await localApp(t);
  await f.request('/api/notifications/settings', { wechatEnabled: true, wechatToken: 'synthetic-notification-token', rememberCredentials: false });
  const before = f.app.store.data.settings, revision = f.app.store.data.notificationSettingsRevision;
  for (const expectedRevision of [-1, null, '1']) {
    const invalid = await f.request('/api/notifications/settings', { wechatEnabled: false, expectedRevision });
    assert.equal(invalid.status, 400); assert.equal(f.app.store.data.settings, before);
  }
  const original = f.app.store.save;
  f.app.store.save = () => { throw Error('合成写盘失败'); };
  try {
    const failed = await f.request('/api/notifications/settings', { wechatEnabled: false, expectedRevision: revision });
    assert.equal(failed.status, 500); assert.equal(f.app.store.data.settings, before);
    assert.equal(f.app.store.data.notificationSettingsRevision, revision);
  } finally { f.app.store.save = original; }
});
test('单进程运行锁拒绝第二实例，关闭后移除且可再次启动',async t=>{
  const f=await localApp(t);assert.throws(()=>createApplication({runtimeDir:f.dir,startEngine:false}),/已有服务/);await f.app.close();assert.equal(fs.existsSync(path.join(f.dir,'server.lock')),false);
  const second=createApplication({runtimeDir:f.dir,startEngine:false});await second.close();assert.equal(fs.existsSync(path.join(f.dir,'server.lock')),false);
});

const AI_TEST_KEY = 'sk-http-synthetic-not-real-123456789';
const AI_TEST_INPUT = { consent: true, mode: 'plan', request: '请分析4090环境需求', projectText: 'torch==2.1.0', errorText: '' };
const AI_TEST_RESULT = { summary: '需要核验环境', findings: [{ message: '项目指定torch', evidence: 'torch==2.1.0' }],
  recommendations: [{ action: '核对依赖', reason: '尚未验证', verification: '在目标实例运行最小检查' }], questions: [], warnings: ['仅供建议'], paidConsent: true };
test('AI接口要求本地令牌及同源，未启用时核心任务仍可建立', async t => {
  let calls = 0; const f = await localApp(t, { fetchImpl: async () => { calls++; throw Error('不应调用'); } });
  assert.equal((await fetch(f.base + '/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.base + '/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': f.app.token, Origin: 'https://untrusted.example.test' }, body: '{}' })).status, 403);
  const result = await f.request('/api/ai/analyze', AI_TEST_INPUT); assert.equal(result.status, 409);
  assert.equal((await result.json()).error, 'AI_DISABLED');
  assert.equal((await f.request('/api/tasks', { provider: 'autodl', gpuModel: 'RTX 4090', mode: 'clone' })).status, 201); assert.equal(calls, 0);
  assert.equal((await fetch(f.base + '/ai.js')).status, 200);
});
test('HTTP配置及状态均不回显AI Key，默认不写磁盘，保存不触发分析', async t => {
  let calls = 0; const f = await localApp(t, { fetchImpl: async () => { calls++; } });
  const saved = await f.request('/api/ai/settings', { enabled: true, apiKey: AI_TEST_KEY }); assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(AI_TEST_KEY), false);
  const state = await (await f.request('/api/state')).json(); assert.equal(state.ai.ready, true); assert.equal(state.ai.hasKey, true);
  assert.equal(state.aiProviders.length, 3); assert.equal(JSON.stringify(state).includes(AI_TEST_KEY), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8').includes(AI_TEST_KEY), false); assert.equal(calls, 0);
});
test('AI设置与通知设置分别持久化，更新通知不会丢失已记住的模型配置', async t => {
  const f = await localApp(t); await f.request('/api/ai/settings', { enabled: true, apiKey: AI_TEST_KEY, rememberKey: true });
  await f.request('/api/notifications/settings', { wechatEnabled: true, wechatToken: 'synthetic-wechat-private-token' });
  const state = await (await f.request('/api/state')).json(); assert.equal(state.ai.ready, true); assert.equal(state.settings.wechatEnabled, true);
  assert.equal(JSON.stringify(state).includes(AI_TEST_KEY), false); assert.equal(JSON.stringify(state).includes('synthetic-wechat-private-token'), false);
  await f.request('/api/ai/clear-key', {});
  assert.equal(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8').includes(AI_TEST_KEY), false);
  assert.equal(f.app.store.data.settings.wechatToken, 'synthetic-wechat-private-token');
});
test('HTTP分析只返回建议与匹配证据，不创建任务或接受模型费用授权', async t => {
  let calls = 0; const f = await localApp(t, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(AI_TEST_RESULT) } }] })); } });
  await f.request('/api/ai/settings', { enabled: true, apiKey: AI_TEST_KEY });
  const noConsent = await f.request('/api/ai/analyze', { ...AI_TEST_INPUT, consent: false }); assert.equal(noConsent.status, 400); assert.equal(calls, 0);
  const result = await f.request('/api/ai/analyze', AI_TEST_INPUT); assert.equal(result.status, 200); const data = await result.json();
  assert.equal(data.result.findings[0].evidenceMatched, true); assert.equal(data.result.paidConsent, undefined);
  assert.equal(data.meta.automaticExecution, false); assert.equal(f.app.store.tasks().length, 0); assert.equal(calls, 1);
});
test('HTTP模型鉴权失败不泄露Key，失败后仍可建立和暂停核心任务', async t => {
  const f = await localApp(t, { fetchImpl: async () => new Response('upstream key=' + AI_TEST_KEY, { status: 401 }) });
  await f.request('/api/ai/settings', { enabled: true, apiKey: AI_TEST_KEY }); const failed = await f.request('/api/ai/analyze', AI_TEST_INPUT);
  assert.equal(failed.status, 502); const error = await failed.json(); assert.equal(error.error, 'AI_AUTH'); assert.equal(JSON.stringify(error).includes(AI_TEST_KEY), false);
  const { task } = await (await f.request('/api/tasks', { provider: 'autodl', gpuModel: 'RTX 4090' })).json();
  assert.equal((await f.request('/api/tasks/' + task.id + '/pause', {})).status, 200);
});
test('HTTP分析等待期间核心接口可用，取消AI不会暂停或取消核心任务', async t => {
  let entered; const entry = new Promise(resolve => { entered = resolve; });
  const f = await localApp(t, { fetchImpl: async (_url, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })); } });
  await f.request('/api/ai/settings', { enabled: true, apiKey: AI_TEST_KEY }); const pending = f.request('/api/ai/analyze', AI_TEST_INPUT); await entry;
  const { task } = await (await f.request('/api/tasks', { provider: 'autodl', gpuModel: 'RTX 4090', mode: 'clone' })).json();
  assert.equal((await f.request('/api/state')).status, 200);
  assert.equal((await f.request('/api/ai/cancel', {})).status, 200); const cancelled = await pending;
  assert.equal(cancelled.status, 409); assert.equal((await cancelled.json()).error, 'AI_CANCELLED');
  assert.equal(f.app.store.get(task.id).state, 'queued');
});


test('所有任务均需先核验登录，不存在演练绕过入口', async t => {
  const f = await localApp(t);
  const live = { gpuModel: 'RTX 4090', provider: 'autodl', mode: 'clone', sourceId: 'synthetic-source', action: 'observe', maxGpuHourly: 3, maxTotalHourly: 4, maxStorageDaily: 5 };
  for (const state of ['not_open','unchecked','login_required','human_required','expired','unknown','error','closed','checking']) {
    f.app.adapters.autodl.sessionStatus = () => ({ state, browserOpen: true });
    const response = await f.request('/api/tasks', live);
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'LOGIN_CHECK_REQUIRED');
  }
  f.app.adapters.autodl.sessionStatus = () => ({ state: 'ready', browserOpen: false });
  assert.equal((await f.request('/api/tasks', live)).status, 409);
  assert.equal(f.app.store.tasks().length, 0);
  assert.equal((await f.request('/api/tasks', { provider: 'demo', gpuModel: 'RTX 4090' })).status, 400);
  assert.equal((await f.request('/api/tasks', { gpuModel: 'RTX 4090' })).status, 409);
  f.app.adapters.autodl.sessionStatus = () => ({ state: 'ready', browserOpen: true });
  assert.equal((await f.request('/api/tasks', live)).status, 201);
});
test('状态刷新只返回缓存会话，主动核验才访问适配器', async t => {
  const f = await localApp(t); let checks = 0;
  f.app.adapters.autodl.checkLogin = async () => { checks++; return { message: '合成只读核验', session: f.app.adapters.autodl.sessionStatus() }; };
  for (let i = 0; i < 3; i++) {
    const state = await (await f.request('/api/state')).json(); assert.equal(state.browser.session.state, 'ready');
  }
  assert.equal(checks, 0);
  const result = await f.request('/api/browser/check', {}); assert.equal(result.status, 200);
  assert.equal((await result.json()).session.state, 'ready'); assert.equal(checks, 1);
  assert.equal(f.app.store.tasks().length, 0);
});
test('登录检查沿用本地令牌保护，无令牌请求不触发适配器', async t => {
  const f = await localApp(t); let checks = 0;
  f.app.adapters.autodl.checkLogin = async () => { checks++; return {}; };
  const response = await fetch(f.base + '/api/browser/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403); assert.equal(checks, 0);
});
test('登录检查与任务页面操作互斥，重复点击不会并发操控浏览器', async t => {
  const f = await localApp(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  f.app.adapters.autodl.checkLogin = async () => { entered(); await wait; return { message: '合成核验完成' }; };
  const pending = f.request('/api/browser/check', {}); await started;
  try {
    assert.equal(f.app.engine.busy, true);
    assert.equal((await f.request('/api/browser/check', {})).status, 409);
    assert.equal((await f.request('/api/browser/open', {})).status, 409);
  } finally { release(); }
  assert.equal((await pending).status, 200); assert.equal(f.app.engine.busy, false);
});
test('核验异常后释放互斥锁，接口可继续重试和建立真实任务', async t => {
  const f = await localApp(t);
  f.app.adapters.autodl.checkLogin = async () => { throw Error('synthetic check failure'); };
  assert.equal((await f.request('/api/browser/check', {})).status, 500); assert.equal(f.app.engine.busy, false);
  assert.equal((await f.request('/api/tasks', { provider: 'autodl', gpuModel: 'RTX 4090' })).status, 201);
});


test('HTTP 新建和克隆保存用户选择的型号及自定义型号，状态目录仅为临时合成夹具', async t => {
  const f=await localApp(t);
  const state=await (await f.request('/api/state')).json();
  // 不再下发内置预设；同步前没有型号目录。
  assert.equal(state.models,undefined);assert.equal(state.gpuCatalog,null);
  for (const mode of ['create','clone']) for (const gpuModel of ['L20','A100 80GB','ExampleGPU [Mk2] (48GB)']) {
    const response=await f.request('/api/tasks',{provider:'autodl',mode,gpuModel});
    assert.equal(response.status,201);
    const {task}=await response.json();assert.equal(task.config.gpuModel,gpuModel);assert.equal(task.config.mode,mode);
    const persisted=JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8'));
    assert.ok(persisted.tasks.some(item=>item.id===task.id&&item.config.gpuModel===gpuModel));
    assert.equal((await f.request('/api/tasks/'+task.id+'/cancel',{})).status,200);
  }
});
test('同步 AutoDL 型号：按地区保存并返回；读不到任何型号时保留上次目录；名称逐项校验', async t => {
  const f=await localApp(t);
  const response=await f.request('/api/autodl/gpus',{});assert.equal(response.status,200);
  const catalog=await response.json();
  assert.deepEqual(catalog.regions.map(row=>row.region),['北京B区','西北B区','重庆A区','内蒙B区','北京A区','佛山区']);
  assert.deepEqual(catalog.regions[0].models.map(row=>row.model),['RTX 4090','RTX 4090D','L20','A100','A100 80GB']);
  assert.deepEqual(catalog.regions[1].models[0],{model:'RTX 4090',available:0,total:16,disabled:false});
  const state=await (await f.request('/api/state')).json();assert.deepEqual(state.gpuCatalog,catalog);
  // 保存在本机状态文件中，重启后仍可选择。
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8')).gpuCatalog,catalog);
  f.app.adapters.autodl.gpuCatalog=async regions=>({checkedAt:Date.now(),regions:regions.map(region=>({region,models:[],error:'合成读取失败'}))});
  const failed=await f.request('/api/autodl/gpus',{});assert.equal(failed.status,502);
  assert.match((await failed.json()).message,/北京B区（合成读取失败）.*上次同步的型号已保留/);
  assert.deepEqual((await (await f.request('/api/state')).json()).gpuCatalog,catalog);
  f.app.adapters.autodl.gpuCatalog=async()=>({checkedAt:Date.now(),regions:[
    {region:'北京B区',models:[{model:'RTX 5090',available:1,total:8},{model:'A\nB',available:1,total:1},{model:'X'.repeat(81)},{model:'+++'},{model:'rtx 5090',available:9,total:9}]},
    {region:'未知区',models:[{model:'H100',available:1,total:1}]},{region:'西北B区',models:[],missing:true}]});
  const filtered=await (await f.request('/api/autodl/gpus',{})).json();
  assert.deepEqual(filtered.regions,[{region:'北京B区',models:[{model:'RTX 5090',available:1,total:8,disabled:false}]},{region:'西北B区',models:[],missing:true}]);
});
test('同步 AutoDL 型号需要可用会话；页面忙时等待后返回忙碌，不打断当前一轮', async t => {
  const f=await localApp(t,{},{imageBusyWaitMs:50});
  f.app.adapters.autodl.sessionStatus=()=>({state:'login_required',browserOpen:true});
  assert.equal((await f.request('/api/autodl/gpus',{})).status,409);
  f.app.adapters.autodl.sessionStatus=()=>({state:'ready',browserOpen:true});
  f.app.engine.busy=true;
  try { assert.equal((await f.request('/api/autodl/gpus',{})).status,409); } finally { f.app.engine.busy=false; }
  assert.equal((await f.request('/api/autodl/gpus',{})).status,200);
});
test('HTTP 缺少或填写无效型号时不会创建默认 4090 任务', async t => {
  const f=await localApp(t);
  for (const gpuModel of [undefined,'','__custom__','A100\n80GB','A'.repeat(81)]) {
    const response=await f.request('/api/tasks',{provider:'autodl',gpuModel});
    assert.equal(response.status,400);assert.equal((await response.json()).error,'CONFIG');
  }
  assert.equal(f.app.store.tasks().length,0);
});
test('真实任务型号按别名去重，但不同型号的新建任务可以独立配置（内存会话）', async t => {
  const f=await localApp(t);
  const live={provider:'autodl',action:'observe',maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5,
    imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1']};
  assert.equal((await f.request('/api/tasks',{...live,gpuModel:'RTX 4090'})).status,201);
  const duplicate=await f.request('/api/tasks',{...live,gpuModel:'rtx4090'});
  assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error,'DUPLICATE');
  assert.equal((await f.request('/api/tasks',{...live,gpuModel:'L20'})).status,201);
  assert.equal(f.app.store.tasks().length,2);assert.equal(f.app.engine.busy,false);
});
test('同一源实例不能通过更换型号重复建立未结束克隆任务（内存会话）', async t => {
  const f=await localApp(t);
  const live={provider:'autodl',action:'observe',mode:'clone',sourceId:'synthetic-source',
    maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5};
  assert.equal((await f.request('/api/tasks',{...live,gpuModel:'A100'})).status,201);
  const duplicate=await f.request('/api/tasks',{...live,gpuModel:'L20'});
  assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error,'DUPLICATE');
  assert.equal(f.app.store.tasks().length,1);
});

test('HTTP拒绝旧演练入口、跨端口、转发及非对象正文，未访问云端',async t=>{
  const f=await localApp(t);let calls=0;f.app.adapters.autodl.probe=async()=>{calls++;throw Error('禁止监测');};
  const rejected=await f.request('/api/tasks',{provider:'demo',gpuModel:'RTX 4090'});assert.equal(rejected.status,400);assert.match((await rejected.json()).message,/仅支持真实/);
  for(const headers of [{Host:'localhost:1234'},{Forwarded:'for=192.0.2.1'},{'Sec-Fetch-Site':'cross-site'},{Origin:'http://127.0.0.1:1234'}]) {
    const response=await new Promise((resolve,reject)=>{
      http.get(f.base+'/',{headers},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,body}));res.on('error',reject);}).on('error',reject);
    });
    assert.equal(response.status,403,JSON.stringify(headers));assert.equal(response.body.includes(f.app.token),false);
  }
  for(const data of [null,[],42,'synthetic']){const response=await fetch(f.base+'/api/tasks',{method:'POST',headers:{'X-Local-Token':f.app.token,'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(response.status,400);assert.equal((await response.json()).error,'JSON');}
  assert.equal(f.app.store.tasks().length,0);assert.equal(calls,0);
});

test('官方镜像接口要求本地令牌和已核验会话，逐级返回当前分支，不创建任务',async t=>{
  const f=await localApp(t),route='/api/autodl/images';
  assert.equal((await fetch(f.base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const root=await f.request(route,{prefix:[]});assert.equal(root.status,200);assert.deepEqual((await root.json()).options.map(option=>option.label),['PyTorch','Miniconda']);
  const leaf=await f.request(route,{prefix:['PyTorch','2.1.0','3.10(ubuntu22.04)']});assert.equal(leaf.status,200);assert.deepEqual((await leaf.json()).options.map(option=>option.label),['12.1']);
  assert.equal((await f.request(route,{prefix:['a','b','c','d']})).status,400);assert.equal((await f.request(route,{prefix:null})).status,400);
  // 读取镜像时引擎正在一轮检查：等它结束再读；一直忙则在等待上限后返回忙碌。
  f.app.engine.busy=true;const waiting=f.request(route,{prefix:[]});setTimeout(()=>{f.app.engine.busy=false;},150);
  assert.equal((await waiting).status,200);
  const strict=await localApp(t,{},{imageBusyWaitMs:50});strict.app.engine.busy=true;
  try{assert.equal((await strict.request(route,{prefix:[]})).status,409);}finally{strict.app.engine.busy=false;}
  f.app.adapters.autodl.sessionStatus=()=>({state:'expired',browserOpen:true});
  assert.equal((await f.request(route,{prefix:[]})).status,409);assert.equal(f.app.engine.busy,false);assert.equal(f.app.store.tasks().length,0);
});


test('失败旧任务返回明确冲突原因，未选择替换时保持原记录',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{cuda:'13.0',imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','13.0']})).json();
  const old=f.app.store.get(task.id);f.app.store.patch(old,{state:'attention',lastError:'镜像 13.0 已失效 token=synthetic-private https://private.example.test'});
  const r=await f.request('/api/tasks',{}),data=await r.json();
  assert.equal(r.status,409);assert.equal(data.error,'DUPLICATE');assert.equal(data.conflict.id,old.id);assert.equal(data.conflict.cuda,'13.0');assert.equal(data.conflict.replaceable,true);
  assert.match(data.conflict.lastError,/镜像 13.0/);assert.equal(JSON.stringify(data).includes('synthetic-private'),false);assert.equal(JSON.stringify(data).includes('private.example.test'),false);
  assert.equal(f.app.store.tasks().length,1);assert.equal(old.state,'attention');
});
test('显式重建保留旧配置日志，新任务使用当前参数且一次落盘',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{})).json();const old=f.app.store.get(task.id);
  f.app.store.patch(old,{state:'attention',lastError:'镜像需重新选择'});const oldConfig=structuredClone(old.config),oldLogs=structuredClone(old.logs);
  const r=await f.request('/api/tasks',{replaceTaskId:old.id,pollSeconds:1,extraDiskGB:50,name:'修正后的配置'});assert.equal(r.status,201);const next=(await r.json()).task;
  assert.equal(old.state,'cancelled');assert.equal(old.replacedBy,next.id);assert.deepEqual(old.config,oldConfig);assert.deepEqual(old.logs.slice(0,-1),oldLogs);
  assert.equal(next.replacesTaskId,old.id);assert.equal(next.config.pollSeconds,1);assert.equal(next.config.extraDiskGB,50);assert.equal(next.operation,null);
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8'));assert.equal(saved.tasks.length,2);assert.equal(saved.tasks.find(x=>x.id===old.id).replacedBy,next.id);
  assert.equal((await f.request('/api/tasks/'+old.id+'/resume',{})).status,409);assert.equal(old.state,'cancelled');
});
test('活动任务或已有提交的任务不能被重建，停止也不能绕过防重复租用',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{})).json(),old=f.app.store.get(task.id);
  let r=await f.request('/api/tasks',{replaceTaskId:old.id});assert.equal(r.status,409);assert.equal((await r.json()).conflict.replaceable,false);
  const operation={stage:'click_started',at:1234};
  for(const state of ['attention','paused','cancelled','expired','found','reconciling']){
    f.app.store.patch(old,{state,operation});
    for(const data of [{},{replaceTaskId:old.id}]){
      r=await f.request('/api/tasks',data);assert.equal(r.status,409);const conflict=(await r.json()).conflict;assert.equal(conflict.hasOperation,true);assert.equal(conflict.replaceable,false);
      assert.equal(old.state,state);assert.deepEqual(old.operation,operation);assert.equal(f.app.store.tasks().length,1);
    }
  }
});
test('无提交但已有目标结果的旧任务不能被替换；已完成任务允许主动新建下一份资源',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{})).json(),old=f.app.store.get(task.id);
  f.app.store.patch(old,{state:'attention',result:{id:'synthetic-target'}});
  let r=await f.request('/api/tasks',{replaceTaskId:old.id});assert.equal(r.status,409);assert.equal((await r.json()).conflict.replaceable,false);
  f.app.store.patch(old,{state:'completed',operation:{stage:'accepted',receipt:{instanceId:'synthetic-target'}}});
  r=await f.request('/api/tasks',{});assert.equal(r.status,201);assert.equal(old.state,'completed');
});
test('新配置无效、费用未授权或克隆源消失时不停止旧任务',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{mode:'clone'})).json(),old=f.app.store.get(task.id);f.app.store.patch(old,{state:'attention'});
  for(const data of [{mode:'clone',pollSeconds:0},{mode:'clone',action:'execute',paidConsent:false},{gpuModel:'L20'},{replaceTaskId:true}]){
    const r=await f.request('/api/tasks',{replaceTaskId:old.id,...data});assert.ok(r.status>=400);assert.equal(old.state,'attention');assert.equal(old.replacedBy,undefined);
  }
  f.app.adapters.autodl.instances=async()=>[];
  const r=await f.request('/api/tasks',{mode:'clone',replaceTaskId:old.id});assert.ok(r.status>=400);assert.equal(old.state,'attention');assert.equal(f.app.store.tasks().length,1);
});
test('校验期间旧任务恢复运行会拒绝重建，不取消恢复后的任务',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{mode:'clone'})).json(),old=f.app.store.get(task.id);f.app.store.patch(old,{state:'attention'});
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.app.adapters.autodl.instances;
  f.app.adapters.autodl.instances=async(...args)=>{entered();await hold;return original(...args);};
  const pending=f.request('/api/tasks',{mode:'clone',replaceTaskId:old.id});await started;
  try{assert.equal((await f.request('/api/tasks/'+old.id+'/resume',{})).status,200);}finally{release();}
  const r=await pending;assert.equal(r.status,409);assert.equal((await r.json()).conflict.replaceable,false);assert.equal(old.state,'watching');assert.equal(f.app.store.tasks().length,1);
});
test('并发重建仅产生一份新任务，过期旧任务不能恢复成重复监测',async t=>{
  const f=await localApp(t),{task}=await(await f.request('/api/tasks',{})).json(),old=f.app.store.get(task.id);f.app.store.patch(old,{state:'paused'});
  const responses=await Promise.all([f.request('/api/tasks',{replaceTaskId:old.id}),f.request('/api/tasks',{replaceTaskId:old.id})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(f.app.store.tasks().length,2);
  const newer=f.app.store.tasks()[0];f.app.store.patch(old,{state:'expired'});
  const r=await f.request('/api/tasks/'+old.id+'/resume',{});assert.equal(r.status,409);assert.equal((await r.json()).conflict.id,newer.id);assert.equal(old.state,'expired');
});
// 后台版本提示与正常停止：只用临时目录和合成适配器，onStop 为替身，不结束测试进程。
async function serverApp(t, options) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-http-isolated-'));
  const autodl=Object.assign(new SyntheticAdapter(),{sessionStatus:()=>({state:'ready',browserOpen:true})});
  const app=createApplication({runtimeDir:dir,adapters:{autodl},startEngine:false,...options});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('autodl-http-isolated-'))throw Error('invalid test cleanup target');fs.rmSync(resolved,{recursive:true,force:true});});
  const request=(url,data,token=app.token)=>fetch(base+url,{method:data===undefined?'GET':'POST',headers:{'X-Local-Token':token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {app,dir,request};
}
test('状态接口报告后台启动后磁盘代码是否已变化',async t=>{
  let code='synthetic-code-a';const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try{
    const f=await serverApp(t,{fingerprint:()=>code});
    let state=await (await f.request('/api/state')).json();assert.equal(state.server.codeChanged,false);assert.equal(state.server.canStop,false);assert.ok(state.server.startedAt>0);
    code='synthetic-code-b';state=await (await f.request('/api/state')).json();assert.equal(state.server.codeChanged,false,'5秒内沿用上次结果');
    now+=5001;state=await (await f.request('/api/state')).json();assert.equal(state.server.codeChanged,true);
  }finally{Date.now=originalNow;}
});
test('正常停止接口需要本地令牌与明确确认，确认后才调用停止回调',async t=>{
  let stops=0;const f=await serverApp(t,{onStop:()=>{stops++;}});
  assert.equal((await f.request('/api/server/stop',{confirm:true},'invalid')).status,403);
  assert.equal((await f.request('/api/server/stop',{})).status,400);assert.equal(stops,0);
  const response=await f.request('/api/server/stop',{confirm:true});assert.equal(response.status,202);assert.equal(response.headers.get('connection'),'close');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);
  assert.equal((await (await f.request('/api/state')).json()).server.canStop,true);
  const plain=await serverApp(t,{});assert.equal((await plain.request('/api/server/stop',{confirm:true})).status,409);
});
test('HTTP重新核对需要明确确认与可用会话；清除后可新建同型号任务',async t=>{
  const f=await localApp(t);const old=f.app.store.create(normalizeConfig(configInput({gpuModel:'RTX 4090'})));
  f.app.store.patch(old,{state:'cancelled',operation:{id:'synthetic-op',stage:'click_started',at:Date.now()-130000,baselineIds:['synthetic-existing']}});
  assert.equal((await f.request('/api/tasks',configInput({gpuModel:'RTX 4090'}))).status,409);
  assert.equal((await f.request(`/api/tasks/${old.id}/recheck`,{})).status,400);assert.ok(old.operation);
  const response=await f.request(`/api/tasks/${old.id}/recheck`,{confirmed:true});assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.result.cleared,true);assert.equal(old.operation,null);
  assert.equal((await f.request('/api/tasks',configInput({gpuModel:'RTX 4090'}))).status,201);
});
test('再次启动时识别已在运行的后台：当前、代码已更新、旧版本与无响应，提示中不含令牌',async t=>{
  let code='synthetic-code-a';const originalNow=Date.now;let now=originalNow();Date.now=()=>now;let stops=0;
  try{
    const f=await serverApp(t,{fingerprint:()=>code,onStop:()=>{stops++;}});f.app.store.create(normalizeConfig(configInput({gpuModel:'RTX 4090'})));
    const port=f.app.server.address().port;
    const current=await inspectRunningBackend(port);assert.equal(current.kind,'current');assert.equal(current.active,1);
    const currentText=describeRunningBackend(current,{pid:4242,port});assert.match(currentText,/PID 4242/);assert.match(currentText,/关闭网页不会停止后台/);assert.match(currentText,/当前代码/);assert.equal(currentText.includes(f.app.token),false);
    code='synthetic-code-b';now+=5001;
    const outdated=await inspectRunningBackend(port);assert.equal(outdated.kind,'outdated');assert.equal(outdated.canStop,true);
    const outdatedText=describeRunningBackend(outdated,{pid:4242,port});assert.match(outdatedText,/1 个任务/);assert.equal(outdatedText.includes(f.app.token),false);
    assert.equal((await outdated.stop()).status,202);await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);
  }finally{Date.now=originalNow;}
  // 旧版后台的状态里没有 server 字段：只提示手动结束，不提供停止请求。
  const legacyFetch=async url=>url.endsWith('/api/state')?new Response(JSON.stringify({tasks:[{state:'watching'},{state:'cancelled'}]})):new Response('<meta name="local-token" content="abc123">');
  const legacy=await inspectRunningBackend(8787,{fetchImpl:legacyFetch});assert.deepEqual(legacy,{kind:'legacy',active:1});
  const legacyText=describeRunningBackend(legacy,{pid:20524,port:8787});assert.match(legacyText,/不支持正常停止的旧版本/);assert.match(legacyText,/结束 PID 20524/);assert.match(legacyText,/1 个任务/);
  const down=await inspectRunningBackend(8787,{fetchImpl:async()=>{throw Error('synthetic refused');}});assert.equal(down.kind,'unreachable');
  assert.match(describeRunningBackend(down,{pid:7,port:8787}),/没有正常响应/);
});
test('重启时停止旧后台：先发完回复再停止，真实关闭后释放运行锁',async t=>{
  let code='synthetic-code-a';const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try{
    const f=await serverApp(t,{fingerprint:()=>code,onStop:()=>{void f.app.close();}});
    const port=f.app.server.address().port,lockPath=path.join(f.dir,'server.lock');
    code='synthetic-code-b';now+=5001;
    const info=await inspectRunningBackend(port);assert.equal(info.kind,'outdated');
    const logs=[];
    assert.equal(await stopRunningBackend(info,{pid:process.pid,port,lockPath,waitSeconds:20,log:m=>logs.push(m),warn:m=>logs.push(m)}),true);
    assert.match(logs[0],/已请求旧后台正常停止/);assert.equal(logs.length,1);assert.equal(fs.existsSync(lockPath),false);
  }finally{Date.now=originalNow;}
});
test('停止旧后台：回复丢失时先核对运行锁和端口，仍在运行才重发；被拒绝时写明原因，不强制结束',async()=>{
  const socketLost=()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_SOCKET'}});};
  const timedOut=()=>{throw Object.assign(new Error('synthetic timeout'),{name:'TimeoutError'});};
  const run=async({replies,releaseAt=Infinity,healthy=true,waitSeconds=40})=>{
    const logs=[],warns=[];let sends=0,checks=0;
    const info={stop:async()=>{const reply=replies[Math.min(sends++,replies.length-1)];return typeof reply==='function'?reply():new Response(JSON.stringify(reply.body||{}),{status:reply.status});}};
    const ok=await stopRunningBackend(info,{pid:4242,port:8787,waitSeconds,sleep:async()=>{},released:()=>++checks>=releaseAt,
      fetchImpl:async()=>new Response('{}',{status:healthy?200:503}),log:m=>logs.push(m),warn:m=>warns.push(m)});
    return {ok,logs,warns,sends,checks};
  };
  let r=await run({replies:[{status:202}],releaseAt:3});
  assert.equal(r.ok,true);assert.equal(r.sends,1);assert.match(r.logs[0],/已请求旧后台正常停止/);assert.deepEqual(r.warns,[]);
  r=await run({replies:[{status:403,body:{message:'本地访问令牌无效'}}]});
  assert.equal(r.ok,false);assert.equal(r.checks,0);assert.match(r.warns[0],/拒绝停止（HTTP 403，本地访问令牌无效），未做任何处理/);
  // 旧后台已开始停止、回复没送到：不能报“未处理”，等运行锁释放后继续重启。
  r=await run({replies:[socketLost],releaseAt:2});
  assert.equal(r.ok,true);assert.equal(r.sends,1);assert.match(r.logs[0],/没有收到回复：连接中断（UND_ERR_SOCKET）.*可能已经开始停止/);assert.deepEqual(r.warns,[]);
  // 回复丢失且旧后台仍在正常运行：请求没送到，第5秒重发。
  r=await run({replies:[socketLost,{status:202}],releaseAt:9});
  assert.equal(r.ok,true);assert.equal(r.sends,2);assert.match(r.logs[1],/重新发送停止请求并收到确认/);
  // 端口已不响应：只等待，不重发。
  r=await run({replies:[socketLost],healthy:false});
  assert.equal(r.ok,false);assert.equal(r.sends,1);assert.match(r.warns[0],/等待40秒后旧后台仍未退出，未强制结束.*PID 4242/);
  // 每次都超时：第5秒、第30秒各重发一次，到时限后报告。
  r=await run({replies:[timedOut]});
  assert.equal(r.ok,false);assert.equal(r.sends,3);assert.match(r.logs[0],/15秒内没有回复/);assert.match(r.warns[0],/仍未退出，未强制结束/);
});
test('运行锁释放判断：文件不在、换了进程或记录的进程已退出都算释放；本进程持有时不算',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-http-isolated-'));
  t.after(()=>{const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('autodl-http-isolated-'))throw Error('invalid test cleanup target');fs.rmSync(resolved,{recursive:true,force:true});});
  const lockPath=path.join(dir,'server.lock');
  assert.equal(lockReleased(lockPath,process.pid),true);
  fs.writeFileSync(lockPath,String(process.pid));assert.equal(lockReleased(lockPath,process.pid),false);
  assert.equal(lockReleased(lockPath,process.pid+1),true);
  const exited=spawnSync(process.execPath,['-e','0']).pid;fs.writeFileSync(lockPath,String(exited));
  assert.equal(lockReleased(lockPath,exited),true);
});
// ---- 环境与选卡规划接口：合成目录与合成镜像菜单，不连接平台、不调用真实模型 ----
const PLAN_TEXT = 'pip install torch==2.1.0+cu121\nVicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.';
test('规划接口需要本地令牌；只用规则时不调用模型、不创建任务，返回约束、型号结论与草稿',async t=>{
  let calls=0;const f=await localApp(t,{fetchImpl:async()=>{calls++;throw Error('不应调用');}});seedGpuCatalog(f.app.store);
  assert.equal((await fetch(f.base+'/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectText:PLAN_TEXT})})).status,403);
  assert.equal((await f.request('/api/plan',{})).status,400);
  const r=await f.request('/api/plan',{projectText:PLAN_TEXT});assert.equal(r.status,200);const plan=await r.json();
  assert.equal(plan.model,null);assert.equal(calls,0);assert.equal(f.app.store.tasks().length,0);assert.equal(plan.automaticExecution,false);
  assert.ok(plan.constraints.some(row=>row.key==='vramGB'&&row.ambiguous));
  // 资料中有 14GB 与 28GB 两个显存数字：按最大的 28GB 判断，24GB 的卡不满足；满足的卡中 L20 空闲最多
  assert.equal(plan.vramNeed.basis,'max');assert.equal(plan.vramNeed.gb,28);assert.match(plan.notices[0],/最大的 28GB/);
  assert.equal(plan.draft.gpuModel,'L20');assert.deepEqual(plan.draft.regions,['北京B区','重庆A区']);assert.equal(plan.draft.imageHint.cuda,'==12.1');
  assert.equal(plan.gpus.find(g=>g.model==='RTX 4090').status,'excluded');
  const unknown=await (await f.request('/api/plan',{projectText:'pip install torch==2.1.0+cu121'})).json();
  assert.equal(unknown.draft,null);assert.match(unknown.notices[0],/没有读出显存要求/);assert.ok(unknown.gpus.every(g=>g.status!=='ok'));
  const sized=await (await f.request('/api/plan',{request:'部署27b模型',projectText:''})).json();
  assert.equal(sized.vramNeed.gb,65);assert.equal(sized.gpus.find(g=>g.model==='A100 80GB').status,'ok');assert.equal(sized.gpus.find(g=>g.model==='L20').status,'excluded');
  assert.equal((await f.request('/api/plan',{projectText:PLAN_TEXT,useModel:true})).status,400);
  const off=await (await f.request('/api/plan',{projectText:PLAN_TEXT,useModel:true,consent:true})).json();
  assert.equal(off.model.code,'AI_DISABLED');assert.ok(off.gpus.length>0);
});
test('规划接口：模型按需求选出显存后排除显存不足的型号；引用不符的条目被丢弃并返回原因',async t=>{
  const reply={items:[{field:'vramGB',value:'28',evidence:'Vicuna-13B requires around 28GB of GPU memory.'},{field:'cuda',value:'==11.8',evidence:'需要 CUDA 11.8'}],summary:'按 13B 推理'};
  const f=await localApp(t,{fetchImpl:async(url,options)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+AI_TEST_KEY);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)},finish_reason:'stop'}]}));}});seedGpuCatalog(f.app.store);
  await f.request('/api/ai/settings',{enabled:true,apiKey:AI_TEST_KEY});
  const plan=await (await f.request('/api/plan',{request:'推理 Vicuna-13B',projectText:PLAN_TEXT,useModel:true,consent:true})).json();
  assert.equal(plan.model.accepted,1);assert.equal(plan.model.rejected[0].reason,'引用不是输入资料中的原文');
  const status=Object.fromEntries(plan.gpus.map(g=>[g.model,g.status]));
  assert.equal(status['RTX 4090'],'excluded');assert.equal(status['L20'],'warn');assert.equal(status['A100'],'check');
  assert.match(plan.gpus.find(g=>g.model==='L20').reasons.join(' '),/显存要求来自模型补充/);
  assert.ok(plan.constraints.some(row=>row.key==='vramGB'&&row.source==='model'&&row.value==='≥ 28GB'));
});
test('规划镜像接口只读官方菜单并逐级选择，会话不可用时拒绝',async t=>{
  const f=await localApp(t);
  const r=await f.request('/api/plan/image',{hint:{framework:'PyTorch',torch:'==2.1.0',cuda:'==12.1',minCuda:'11.3'}});assert.equal(r.status,200);
  const body=await r.json();assert.deepEqual(body.path,['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1']);assert.equal(body.complete,true);assert.equal(body.levels.length,4);
  const stuck=await (await f.request('/api/plan/image',{hint:{framework:'PyTorch',torch:'==2.1.0',minTorch:'2.7'}})).json();
  assert.equal(stuck.complete,false);assert.match(stuck.levels[1].reason,/Miniconda/);
  assert.equal((await f.request('/api/plan/image',{hint:{torch:'rm -rf'}})).status,400);
  f.app.adapters.autodl.sessionStatus=()=>({state:'expired',browserOpen:true});
  assert.equal((await f.request('/api/plan/image',{hint:{}})).status,409);assert.equal(f.app.store.tasks().length,0);
});
test('控制台响应带 Cross-Origin-Opener-Policy；接管失效运行锁时锁文件已被别的进程改写就退出',async t=>{
  const f=await localApp(t);const home=await fetch(f.base);assert.equal(home.headers.get('cross-origin-opener-policy'),'same-origin');await home.text();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-lock-isolated-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const lockPath=path.join(dir,'server.lock');fs.writeFileSync(lockPath,'999999');
  const original=fs.readFileSync;let reads=0;
  fs.readFileSync=function(p,...rest){if(String(p)===lockPath&&++reads===2)return '424242';return original.call(this,p,...rest);};
  try{assert.throws(()=>createApplication({runtimeDir:dir,startEngine:false}),/另一个进程接管/);}finally{fs.readFileSync=original;}
  assert.equal(original(lockPath,'utf8'),'999999');
});

