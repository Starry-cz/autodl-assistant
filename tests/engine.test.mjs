import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { AppError } from '../src/errors.mjs';
import { testConfig as normalizeConfig } from './fixtures/config.mjs';
import { fixture, gate } from './helpers.mjs';
import { blocksTask } from '../src/task-conflicts.mjs';

test('合成测试新建只提交一次，验证完成后不重复租用',async t=>{
  const f=fixture(t);await f.engine.tick();assert.equal(f.task.state,'verifying');assert.equal(f.submissions,1);
  await f.due(40000);assert.equal(f.task.state,'completed');assert.equal(f.task.result.progress,'GPU 实例已运行');await f.due(100000);
  assert.equal(f.submissions,1);assert.equal(f.store.data.notifications.filter(n=>n.event==='completed').length,1);
});
test('合成测试克隆在GPU已运行时仍等待数据盘，复制完成后才成功',async t=>{
  const f=fixture(t,{mode:'clone'});await f.engine.tick();assert.equal(f.task.quote.copyDataDisk,true);assert.equal(f.task.quote.extraDiskGB,100);
  await f.due(40000);assert.equal(f.task.result.running,true);assert.equal(f.task.state,'verifying');
  await f.due(30000);assert.equal(f.task.state,'completed');assert.equal(f.submissions,1);
});
test('仅监测任务不调用提交',async t=>{
  const f=fixture(t,{action:'observe'});await f.engine.tick();assert.equal(f.task.state,'found');assert.equal(f.submissions,0);assert.equal(f.task.operation,null);
});
test('无库存时持续等待，到期仅通知，不提交',async t=>{
  const f=fixture(t,{availableAfter:100,timeoutMinutes:1});await f.engine.tick();assert.equal(f.task.state,'watching');
  await f.due(60001);assert.equal(f.task.state,'expired');assert.equal(f.submissions,0);
});

test('新建和克隆的准备阶段跨过截止时间，不点击付费并转为已到期', async t => {
  for (const mode of ['create', 'clone']) {
    const f = fixture(t, { mode, timeoutMinutes: 1 });
    const prepare = f.adapter.prepare.bind(f.adapter);
    f.adapter.prepare = async (...args) => { const quote = await prepare(...args); f.advance(61000); return quote; };
    let paidClicks = 0;
    // 与真实适配器相同：只有 mark 成功返回后才可点击付费按钮。
    f.adapter.submit = async (_task, _quote, mark) => { mark(); paidClicks++; return { instanceId: 'synthetic-new', acceptedAt: f.clock() }; };
    await f.engine.tick();
    assert.equal(paidClicks, 0, mode);
    assert.equal(f.task.state, 'expired', mode);
    assert.equal(f.task.operation, null, mode);
    assert.equal(f.store.data.notifications.some(n => n.event === 'submitted'), false, mode);
    await f.due(); assert.equal(paidClicks, 0, mode);
  }
});

test('已停止且有开机回执的原实例任务可继续核对，但不重复开机', async t => {
  const f = fixture(t, { mode: 'boot' });
  let boots = 0;
  const source = { id: f.task.config.sourceId, region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
    stopped: true, running: false, cardless: false, starting: false, gpuAvailable: true };
  f.adapter.inspectBoot = async () => ({ ...source });
  f.adapter.boot = async (_task, mark) => { mark(); boots++; return {}; };
  await f.engine.tick(); assert.equal(boots, 1);
  f.engine.control(f.task, 'cancel');
  const operation = f.task.operation;
  f.engine.control(f.task, 'resume');
  assert.equal(f.task.state, 'verifying'); assert.equal(f.task.operation, operation);
  await f.engine.tick(); assert.equal(boots, 1); assert.equal(f.task.state, 'verifying');
  Object.assign(source, { stopped: false, running: true });
  await f.due(); assert.equal(f.task.state, 'completed'); assert.equal(boots, 1);
  assert.equal(blocksTask(f.task, f.task.config), false);
  // 没有开机回执、或者普通新建任务的“停止”，仍然保持终止语义。
  const unsubmitted = fixture(t, { mode: 'boot' }); unsubmitted.engine.control(unsubmitted.task, 'cancel');
  assert.throws(() => unsubmitted.engine.control(unsubmitted.task, 'resume'), /当前状态不能恢复/);
  const created = fixture(t); await created.engine.tick(); created.engine.control(created.task, 'cancel');
  assert.throws(() => created.engine.control(created.task, 'resume'), /当前状态不能恢复/);
});
test('1秒间隔按到期时间检查；正常抖动和错误退避仍生效',async t=>{
  const f=fixture(t,{availableAfter:100,pollSeconds:1});
  await f.engine.tick();assert.equal(f.task.attempts,1);assert.equal(f.task.nextCheckAt-f.clock(),1000);
  await f.due(999);assert.equal(f.task.attempts,1);
  await f.due(1);assert.equal(f.task.attempts,2);assert.equal(f.task.nextCheckAt-f.clock(),1000);
  f.engine.random=()=>0.5;await f.due(1000);assert.equal(f.task.attempts,3);assert.equal(f.task.nextCheckAt-f.clock(),1060);
  f.adapter.probe=async()=>{throw new AppError('NETWORK','合成读取失败',{retryable:true});};
  await f.due(1060);assert.equal(f.task.errors,1);assert.equal(f.task.nextCheckAt-f.clock(),2120);
  assert.equal(f.task.state,'watching');assert.equal(f.submissions,0);assert.equal(f.task.operation,null);
});
test('提交前重启清除intent并暂停，可恢复；不会误认为已点击',async t=>{
  const f=fixture(t);f.store.patch(f.task,{state:'submitting',operation:{stage:'intent',at:f.clock()}});
  const disk=new Store(f.dir,{clock:f.clock});const engine=new Engine(disk,{autodl:f.adapter},f.notifier,{clock:f.clock,random:()=>0});
  const task=disk.get(f.task.id);assert.equal(task.state,'paused');assert.equal(task.operation,null);engine.control(task,'resume');await engine.tick();assert.equal(f.submissions,1);
});
test('点击后断线进入对账，重启和重复tick都不会再次创建',async t=>{
  const f=fixture(t);let clicks=0;f.adapter.submit=async(_t,_q,mark)=>{mark();clicks++;throw new AppError('NETWORK','隔离合成断线',{retryable:true});};
  await f.engine.tick();assert.equal(f.task.state,'verifying');assert.equal(f.task.operation.stage,'click_started');assert.equal(f.task.nextCheckAt,f.task.operation.at+120000);
  const engine=new Engine(f.store,{autodl:f.adapter},f.notifier,{clock:f.clock,random:()=>0});await engine.tick();
  assert.equal(f.task.state,'verifying');assert.throws(()=>engine.control(f.task,'resume'),/不能恢复/);assert.equal(f.task.operation.stage,'click_started');
  // 合成适配器没有回执时返回无法归属：转人工核对，仍不再次创建。
  f.advance(120000);await engine.tick();assert.equal(f.task.state,'reconciling');assert.equal(f.task.operation.stage,'click_started');assert.equal(clicks,1);
});
test('已知目标实例重启后只核对结果',async t=>{
  const f=fixture(t);await f.engine.tick();f.advance(50000);const engine=new Engine(f.store,{autodl:f.adapter},f.notifier,{clock:f.clock,random:()=>0});
  await engine.tick();assert.equal(f.task.state,'completed');assert.equal(f.submissions,1);
});
test('点击前失败可以退避重试，未保留虚假提交记录',async t=>{
  const f=fixture(t);const submit=f.adapter.submit.bind(f.adapter);let first=true;
  f.adapter.submit=async(...args)=>{if(first){first=false;throw new AppError('RESOURCE_GONE','合成库存变化',{retryable:true});}return submit(...args);};
  await f.engine.tick();assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);await f.due(50000);assert.equal(f.task.state,'verifying');assert.equal(f.task.lastError,null);assert.equal(f.submissions,1);
});
test('准备期间暂停阻止后续提交',async t=>{
  const f=fixture(t), entered=gate(), release=gate(), original=f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const run=f.engine.tick();await entered.promise;f.engine.control(f.task,'pause');release.resolve();await run;
  assert.equal(f.task.state,'paused');assert.equal(f.submissions,0);
});
test('mark之前暂停时持久化边界拒绝点击',async t=>{
  const f=fixture(t),entered=gate(),release=gate();let clicked=false;
  f.adapter.submit=async(_t,_q,mark)=>{entered.resolve();await release.promise;mark();clicked=true;return {};};
  const run=f.engine.tick();await entered.promise;f.engine.control(f.task,'pause');release.resolve();await run;
  assert.equal(clicked,false);assert.equal(f.task.state,'paused');assert.equal(f.task.operation,null);
});
test('提交等待期间停止不会被异步回执重新激活',async t=>{
  const f=fixture(t),entered=gate(),release=gate();f.adapter.submit=async(_t,_q,mark)=>{mark();entered.resolve();await release.promise;return {instanceId:'synthetic-isolated-target',acceptedAt:f.clock()};};
  const run=f.engine.tick();await entered.promise;f.engine.control(f.task,'cancel');release.resolve();await run;
  assert.equal(f.task.state,'cancelled');assert.equal(f.task.operation.receipt.instanceId,'synthetic-isolated-target');
});
test('全局互斥不允许两个页面检查同时执行',async t=>{
  const f=fixture(t),entered=gate(),release=gate(),probe=f.adapter.probe.bind(f.adapter);let calls=0;
  f.store.create(normalizeConfig({action:'execute',paidConsent:true,gpuModel:'RTX 4090'}));
  f.adapter.probe=async(...args)=>{calls++;entered.resolve();await release.promise;return probe(...args);};
  const run=f.engine.tick();await entered.promise;await f.engine.tick();assert.equal(calls,1);release.resolve();await run;
});
test('已受理实例结果暂时读取失败只重试查询，不重试付费',async t=>{
  const f=fixture(t);await f.engine.tick();const reconcile=f.adapter.reconcile.bind(f.adapter);let first=true;
  f.adapter.reconcile=async(...args)=>{if(first){first=false;throw new AppError('NETWORK','合成状态读取超时',{retryable:true});}return reconcile(...args);};
  await f.due();assert.equal(f.task.state,'verifying');await f.due(50000);assert.equal(f.task.state,'completed');assert.equal(f.task.lastError,null);assert.equal(f.task.errors,0);assert.equal(f.submissions,1);
});
test('已受理但实例暂不可见时继续只读等待；超过30分钟需处理',async t=>{
  const f=fixture(t);await f.engine.tick();f.adapter.reconcile=async()=>({pending:true,reason:'合成列表延迟'});
  await f.due();assert.equal(f.task.state,'verifying');await f.due(31*60000);assert.equal(f.task.state,'attention');assert.equal(f.submissions,1);
});
test('克隆复制失败保留记录，不误报成功，也不重新克隆',async t=>{
  const f=fixture(t,{mode:'clone',copyFailure:true});await f.engine.tick();await f.due(70000);
  assert.equal(f.task.state,'attention');assert.equal(f.task.result.copyFailed,true);assert.equal(f.task.result.progress,'数据盘复制失败');assert.equal(f.submissions,1);
  assert.equal(f.store.data.notifications.some(n=>n.event==='completed'),false);
});
test('缺少复制证据时需要明确人工确认数据盘，确认后仍检查GPU',async t=>{
  const f=fixture(t,{mode:'clone'});await f.engine.tick();f.adapter.reconcile=async()=>({instance:{id:f.task.operation.receipt.instanceId,running:true,gpuVerified:true}});
  await f.due();assert.equal(f.task.state,'verifying');assert.throws(()=>f.engine.control(f.task,'verify-data',{confirmed:false}),/明确核验/);
  f.engine.control(f.task,'verify-data',{confirmed:true});await f.engine.tick();assert.equal(f.task.state,'completed');
});
test('绑定校验期间取消，不重新激活本地任务',async t=>{
  const f=fixture(t);f.store.patch(f.task,{state:'reconciling',operation:{stage:'click_started',at:f.clock()}});
  const entered=gate(),release=gate();f.adapter.attach=async()=>{entered.resolve();await release.promise;return {instanceId:'synthetic-isolated-target',acceptedAt:f.clock()};};
  const bind=f.engine.attach(f.task,'synthetic-isolated-target');await entered.promise;f.engine.control(f.task,'cancel');release.resolve();await bind;assert.equal(f.task.state,'cancelled');
});
test('仅克隆系统盘不继承源扩容，不等待数据盘复制，并明确通知未复制',async t=>{
 const f=fixture(t,{mode:'clone',copyDataDisk:false,extraDiskGB:10,copyFailure:true});await f.engine.tick();assert.equal(f.task.quote.copyDataDisk,false);assert.equal(f.task.quote.extraDiskGB,10);
 assert.throws(()=>f.engine.control(f.task,'verify-data',{confirmed:true}),/仅可/);await f.due(40000);assert.equal(f.task.state,'completed');assert.equal(f.submissions,1);assert.match(f.store.data.notifications.find(n=>n.event==='completed').message,/未复制数据盘/);
});
test('真实任务余额保护贯穿实际报价、最后刷新及mark；余额不足不进入点击',async t=>{
 const f=fixture(t,{balanceGuard:true});f.task.config.provider='autodl';f.engine.adapters.autodl=f.adapter;const events=[];
 f.engine.wallet={check:async(_c,q,{force})=>{events.push(force?'refresh':'check');assert.equal(q.hourly,1.98);return{requiredMilli:1980};},confirm:()=>events.push('confirm')};
 f.adapter.submit=async(task,q,mark,beforeClick)=>{await beforeClick(q);mark();events.push('click');return{instanceId:'synthetic-target',acceptedAt:f.clock()};};await f.engine.tick();assert.deepEqual(events,['check','check','confirm','click']);assert.equal(f.task.state,'verifying');
});
test('发现候选后余额与表单准备并行刷新；点击前只接受15秒内的余额结果',async t=>{
 const f=fixture(t,{balanceGuard:true});const events=[];
 f.engine.wallet={refresh:async({force})=>{events.push('refresh:'+force);},check:async(_c,q,options)=>{events.push('check:'+(options.maxAge??'default'));return{requiredMilli:1980};},confirm:()=>events.push('confirm')};
 const prepare=f.adapter.prepare.bind(f.adapter);f.adapter.prepare=async(...args)=>{events.push('prepare');return prepare(...args);};
 f.adapter.submit=async(task,q,mark,beforeClick)=>{await beforeClick(q);mark();events.push('click');return{instanceId:'synthetic-target',acceptedAt:f.clock()};};
 await f.engine.tick();assert.deepEqual(events,['refresh:true','prepare','check:default','check:15000','confirm','click']);
 const observe=fixture(t,{action:'observe',balanceGuard:true});let refreshed=0;observe.engine.wallet={refresh:async()=>{refreshed++;}};await observe.engine.tick();assert.equal(refreshed,0);assert.equal(observe.task.state,'found');
});
test('最后余额刷新发现不足：清除未点击意图，不点击，继续监测并只提醒一次',async t=>{
 const f=fixture(t,{balanceGuard:true});f.task.config.provider='autodl';f.engine.adapters.autodl=f.adapter;let clicks=0,checks=0;
 f.engine.wallet={check:async()=>{if(++checks>=2)throw new AppError('BALANCE_INSUFFICIENT','合成余额不足');return{};},confirm:()=>{throw Error('不应到达mark');}};
 f.adapter.submit=async(_t,q,mark,beforeClick)=>{await beforeClick(q);mark();clicks++;};await f.engine.tick();assert.equal(checks,2);assert.equal(clicks,0);assert.equal(f.task.operation,null);
 assert.equal(f.task.state,'watching');assert.match(f.task.balanceLow.message,/合成余额不足/);assert.equal(f.store.data.notifications.filter(n=>n.event==='balance-low').length,1);
 await f.due(100000);assert.equal(clicks,0);assert.equal(f.task.operation,null);assert.equal(f.store.data.notifications.filter(n=>n.event==='balance-low').length,1);
});
test('余额凭证在最后刷新后清除时mark拒绝点击',async t=>{
 const f=fixture(t,{balanceGuard:true});f.task.config.provider='autodl';f.engine.adapters.autodl=f.adapter;let clicks=0;
 f.engine.wallet={check:async()=>({}),confirm:()=>{throw new AppError('BALANCE_STALE','合成凭证已清除');}};
 f.adapter.submit=async(_t,q,mark,beforeClick)=>{await beforeClick(q);mark();clicks++;};await f.engine.tick();assert.equal(clicks,0);assert.equal(f.task.operation,null);assert.equal(f.task.state,'attention');
});
// 扫描策略：只验证调度器选择的扫描范围与记录，合成适配器不访问页面。
function recordScopes(f,{complete=scope=>scope==='full'}={}){
 const scopes=[],probe=f.adapter.probe.bind(f.adapter);
 f.adapter.probe=async(task,options={})=>{scopes.push(options.scope);return {...await probe(task,options),scope:options.scope,complete:complete(options.scope)};};
 return scopes;
}
test('首页优先任务首轮完整翻页，之后按完整翻页间隔兜底',async t=>{
 const f=fixture(t,{availableAfter:100,scanScope:'first-page',fullScanSeconds:60,pollSeconds:20}),scopes=recordScopes(f);
 await f.engine.tick();for(let i=0;i<4;i++)await f.due(20000);
 assert.deepEqual(scopes,['full','first-page','first-page','full','first-page']);
 assert.equal(f.task.lastScan.scope,'first-page');assert.equal(f.task.lastScan.complete,false);assert.equal(f.submissions,0);
});
test('完整检查未完成（命中或停滞）时不更新时间，下轮仍完整翻页；首页恰好读完也算完整',async t=>{
 const f=fixture(t,{availableAfter:100,scanScope:'first-page',fullScanSeconds:60,pollSeconds:20}),scopes=recordScopes(f,{complete:()=>false});
 await f.engine.tick();await f.due(20000);assert.deepEqual(scopes,['full','full']);assert.equal(f.task.lastFullScanAt,undefined);
 const g=fixture(t,{availableAfter:100,scanScope:'first-page',fullScanSeconds:60,pollSeconds:20}),single=recordScopes(g,{complete:()=>true});
 await g.engine.tick();await g.due(20000);await g.due(20000);await g.due(20000);
 assert.deepEqual(single,['full','first-page','first-page','first-page']);
});
test('未设置扫描方式的旧任务每轮完整翻页',async t=>{
 const f=fixture(t,{availableAfter:100,pollSeconds:20});delete f.task.config.scanScope;const scopes=recordScopes(f);
 await f.engine.tick();await f.due(20000);await f.due(20000);
 assert.deepEqual(scopes,['full','full','full']);assert.equal(normalizeConfig({}).scanScope,'full');assert.equal(normalizeConfig({}).fullScanSeconds,null);
});
test('扫描方式和完整翻页间隔按范围校验',()=>{
 assert.equal(normalizeConfig({scanScope:'first-page'}).fullScanSeconds,20);
 assert.equal(normalizeConfig({scanScope:'first-page',fullScanSeconds:'10'}).fullScanSeconds,10);
 for(const fullScanSeconds of [9,3601,30.5,'x'])assert.throws(()=>normalizeConfig({scanScope:'first-page',fullScanSeconds}),/完整翻页间隔/);
 assert.throws(()=>normalizeConfig({scanScope:'page-1'}),/扫描方式/);
 assert.equal(normalizeConfig({scanScope:'full',fullScanSeconds:5}).fullScanSeconds,null);
});
test('命中候选写入日志，核验失败时能看出发生在配置报价阶段',async t=>{
 const f=fixture(t);f.adapter.prepare=async()=>{throw new AppError('CHECKBOX_STATE','合成复选框“需要扩容”未生效',{retryable:true,maxRetries:2});};
 await f.engine.tick();const messages=f.task.logs.map(l=>l.message);
 assert.ok(messages.some(m=>/候选：北京B区 合成922机 RTX 4090，空闲 8，单卡 ¥1\.98\/时；开始核验配置与完整报价/.test(m)));
 assert.match(messages.at(-1),/需要扩容.*第 1\/2 次自动重试/);assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);
});
test('有限重试的页面错误连续超过次数转人工；成功一轮后重新计数',async t=>{
 const f=fixture(t,{availableAfter:100});let failing=true;const probe=f.adapter.probe.bind(f.adapter);
 f.adapter.probe=async(...args)=>{if(failing)throw new AppError('MODEL_FILTER','合成型号筛选被重置',{retryable:true,maxRetries:2});return probe(...args);};
 await f.engine.tick();assert.equal(f.task.state,'watching');assert.equal(f.task.retryStreak,1);
 await f.due(100000);assert.equal(f.task.state,'watching');assert.equal(f.task.retryStreak,2);
 failing=false;await f.due(100000);assert.equal(f.task.retryStreak,0);
 failing=true;await f.due(100000);await f.due(100000);assert.equal(f.task.state,'watching');
 await f.due(100000);assert.equal(f.task.state,'attention');assert.match(f.task.lastError,/已连续 3 次，停止自动重试/);
 assert.ok(f.store.data.notifications.some(n=>n.event==='attention'));assert.equal(f.submissions,0);assert.equal(f.task.operation,null);
 f.engine.control(f.task,'resume');assert.equal(f.task.retryStreak,0);assert.equal(f.task.state,'watching');
});
// 抢卡时序：检查间隔从上一轮开始计时；竞争失败和平台明确拒绝都立即重查，不退避、不停止任务。
test('检查间隔从上一轮开始计时：一轮超过间隔时下一轮立即开始',async t=>{
 const f=fixture(t,{availableAfter:100,pollSeconds:1}),probe=f.adapter.probe.bind(f.adapter);
 f.adapter.probe=async(...args)=>{f.advance(5000);return probe(...args);};
 await f.engine.tick();assert.equal(f.task.nextCheckAt,f.clock());
 const g=fixture(t,{availableAfter:100,pollSeconds:20}),probe2=g.adapter.probe.bind(g.adapter);let started=0;
 g.adapter.probe=async(...args)=>{started=g.clock();g.advance(5000);return probe2(...args);};
 await g.engine.tick();assert.equal(g.task.nextCheckAt,started+20000);assert.equal(g.task.nextCheckAt-g.clock(),15000);
});
test('准备阶段候选被抢走：不计错误、不退避，记录竞争失败后继续监测',async t=>{
 const f=fixture(t),prepare=f.adapter.prepare.bind(f.adapter);let first=true;
 f.adapter.prepare=async(...args)=>{if(first){first=false;throw new AppError('RESOURCE_GONE','合成候选已被占用',{race:true});}return prepare(...args);};
 await f.engine.tick();assert.equal(f.task.state,'watching');assert.equal(f.task.errors,0);assert.equal(f.task.raceLosses,1);assert.equal(f.task.lastError,null);
 assert.equal(f.task.nextCheckAt-f.clock(),20000);assert.ok(f.task.logs.some(l=>l.level==='warn'&&/合成候选已被占用/.test(l.message)));
 await f.due(20000);assert.equal(f.task.state,'verifying');assert.equal(f.submissions,1);
});
test('点击后平台明确拒绝且确认未创建：清除提交记录、保留拒绝证据；这台主机暂时不选，下一轮改选其他主机',async t=>{
 const f=fixture(t),submit=f.adapter.submit;let attempts=0;f.adapter.alternate=true;
 f.adapter.submit=async(task,q,mark,...rest)=>{if(++attempts===1){mark();throw new AppError('SUBMIT_REJECTED','合成平台拒绝：GPU资源不足',{notCreated:true,race:true});}return submit(task,q,mark,...rest);};
 await f.engine.tick();
 assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);assert.equal(f.task.submitRejections.length,1);assert.equal(f.task.raceLosses,1);
 assert.equal(f.task.hostCooldowns[0].hostId,'synthetic-target-host');assert.ok(f.task.logs.some(l=>/合成922机约 2 分钟内不再选择/.test(l.message)));
 assert.equal(f.store.data.notifications.some(n=>n.event==='ambiguous'),false);
 await f.due(20000);assert.equal(f.task.state,'verifying');assert.equal(attempts,2);assert.equal(f.task.operation.stage,'accepted');
 assert.equal(f.task.operation.quote.host.id,'synthetic-other-host');
});
test('“当前主机存储库存已满”：列表上仍有空闲 GPU，但这台主机 30 分钟内不选；没有其他主机时继续监测，到时再试',async t=>{
 // 2026-10-30 00:42～00:43 现场：同一台 311机 被连续选中 5 次，每次都被拒绝。
 const f=fixture(t),submit=f.adapter.submit;let attempts=0;
 f.adapter.submit=async(task,q,mark,...rest)=>{if(++attempts===1){mark();throw new AppError('SUBMIT_REJECTED','平台拒绝创建：“当前主机存储库存已满，请更换其它主机或联系客服处理后创建”；两次核对实例列表均无新实例，未产生实例，继续监测',{notCreated:true,race:true});}return submit(task,q,mark,...rest);};
 await f.engine.tick();assert.equal(f.task.hostCooldowns[0].until-f.clock(),30*60000);
 for(let i=0;i<5;i++){await f.due(20000);assert.equal(f.task.state,'watching');assert.equal(attempts,1);}
 assert.match(f.task.lastScan.summary,/暂不选择最近被平台拒绝的主机：合成922机（约 2\d 分钟后再试，原因：当前主机存储库存已满/);
 assert.equal(f.task.lastScan.candidate,null);
 f.advance(30*60000);await f.engine.tick();assert.equal(attempts,2);assert.equal(f.task.state,'verifying');
});
test('平台因账户原因拒绝：清除提交记录但转人工处理，不反复点击',async t=>{
 const f=fixture(t);f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_REJECTED','合成平台拒绝：账户余额不足',{notCreated:true});};
 await f.engine.tick();assert.equal(f.task.state,'attention');assert.equal(f.task.operation,null);assert.equal(f.task.submitRejections.length,1);
 assert.ok(f.store.data.notifications.some(n=>n.event==='attention'));
 f.engine.control(f.task,'resume');assert.equal(f.task.submitRejections.length,1);assert.equal(f.task.retryStreak,0);
});
test('点击后结果不明确（没有确认未创建）：保留提交记录，约2分钟后自动核对，无法归属时才交给用户，绝不再次创建',async t=>{
 const f=fixture(t);f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_UNCLEAR','合成弹窗',{race:true});};
 await f.engine.tick();assert.equal(f.task.state,'verifying');assert.equal(f.task.operation.stage,'click_started');assert.equal(f.task.lastError,null);
 assert.equal(f.store.data.notifications.some(n=>n.event==='ambiguous'),false);
 await f.due(100000);assert.equal(f.task.state,'verifying');
 await f.due(30000);assert.equal(f.task.state,'reconciling');assert.ok(f.store.data.notifications.some(n=>n.event==='ambiguous'));
 await f.due(100000);assert.equal(f.task.state,'reconciling');assert.equal(f.task.operation.stage,'click_started');
});
test('10分钟内连续被平台拒绝5次时提醒一次，仍继续监测',async t=>{
 const f=fixture(t);f.store.patch(f.task,{submitRejections:[1,2,3,4].map(i=>({at:f.clock()-i*1000,message:'合成'}))});
 f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_REJECTED','合成平台拒绝：GPU资源不足',{notCreated:true,race:true});};
 await f.engine.tick();assert.equal(f.task.state,'watching');assert.equal(f.store.data.notifications.filter(n=>n.event==='repeated-rejections').length,1);
 await f.due(20000);assert.equal(f.store.data.notifications.filter(n=>n.event==='repeated-rejections').length,1);
});
// 点击结果不明的提交：只有用户要求、且完整实例列表没有提交前基线之外的实例时，才清除提交记录。
test('已停止的不明提交：重新核对确认没有新增实例后清除记录，不再阻挡同型号新任务',async t=>{
 const f=fixture(t);f.store.patch(f.task,{state:'cancelled',operation:{id:'synthetic-op',stage:'click_started',at:f.clock(),baselineIds:['synthetic-existing'],quote:{host:{number:'922机'}}}});
 assert.equal(blocksTask(f.task,f.task.config),true);
 await assert.rejects(()=>f.engine.recheck(f.task),e=>e.code==='TOO_EARLY');assert.ok(f.task.operation);
 f.advance(2*60000);f.adapter.extraInstances=[{id:'synthetic-unexpected',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1}];
 const kept=await f.engine.recheck(f.task);assert.equal(kept.cleared,false);assert.equal(kept.extra[0].id,'synthetic-unexpected');assert.equal(f.task.operation.stage,'click_started');assert.equal(blocksTask(f.task,f.task.config),true);
 f.adapter.extraInstances=[];
 const cleared=await f.engine.recheck(f.task);assert.equal(cleared.cleared,true);assert.equal(f.task.operation,null);assert.equal(f.task.state,'cancelled');
 assert.equal(f.task.resolvedSubmissions[0].outcome,'not-created');assert.equal(blocksTask(f.task,f.task.config),false);assert.equal(f.submissions,0);
});
test('重新核对只用于未绑定实例的提交；等待核对中的任务清除后暂停，可手动恢复',async t=>{
 const f=fixture(t);f.store.patch(f.task,{state:'reconciling',operation:{id:'synthetic-op',stage:'click_started',at:f.clock()-3*60000,baselineIds:[]}});
 await f.engine.recheck(f.task);assert.equal(f.task.state,'paused');assert.equal(f.task.operation,null);f.engine.control(f.task,'resume');assert.equal(f.task.state,'watching');
 const bound=fixture(t);bound.store.patch(bound.task,{state:'reconciling',operation:{stage:'accepted',at:bound.clock()-3*60000,receipt:{instanceId:'synthetic-target'}}});
 await assert.rejects(()=>bound.engine.recheck(bound.task),e=>e.code==='STATE');
 const idle=fixture(t);await assert.rejects(()=>idle.engine.recheck(idle.task),e=>e.code==='STATE');
 const busy=fixture(t);busy.store.patch(busy.task,{state:'cancelled',operation:{stage:'click_started',at:busy.clock()-3*60000}});busy.engine.busy=true;
 try{await assert.rejects(()=>busy.engine.recheck(busy.task),e=>e.code==='BUSY');}finally{busy.engine.busy=false;}
});
test('已停止且有提交记录的任务可以绑定已创建的实例，恢复核对该实例',async t=>{
 const f=fixture(t);f.store.patch(f.task,{state:'cancelled',operation:{stage:'click_started',at:f.clock()}});
 await f.engine.attach(f.task,'synthetic-isolated-target');assert.equal(f.task.state,'verifying');assert.equal(f.task.operation.receipt.instanceId,'synthetic-isolated-target');
});
// 点击结果不明后的自动核对：不需要用户手动点“重新核对实例列表”。适配器的核对结果由测试替身给出。
const unclearOnce=f=>{const submit=f.adapter.submit;let attempts=0;
  f.adapter.submit=async(task,q,mark,...rest)=>{if(++attempts===1){mark();throw new AppError('SUBMIT_UNCLEAR','合成页面无结果');}return submit(task,q,mark,...rest);};return ()=>attempts;};
test('点击结果不明：约2分钟后自动核对，确认未创建就清除记录并立即继续，下一轮改选其他主机再次提交',async t=>{
 const f=fixture(t),attempts=unclearOnce(f),reconcile=f.adapter.reconcile.bind(f.adapter);f.adapter.alternate=true;
 f.adapter.reconcile=async task=>task.operation.stage==='click_started'&&!task.operation.receipt?{notCreated:true,reason:'合成：完整实例列表两次都没有新实例'}:reconcile(task);
 await f.engine.tick();assert.equal(f.task.state,'verifying');assert.equal(f.task.nextCheckAt,f.task.operation.at+120000);
 await f.due(120000);assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);assert.equal(f.task.unclearStreak,1);assert.equal(f.task.nextCheckAt,f.clock());
 assert.ok(f.task.logs.some(l=>/两次都没有新实例；已清除提交记录，继续监测；合成922机约 2 分钟内不再选择/.test(l.message)));assert.equal(f.store.data.notifications.some(n=>n.event==='ambiguous'),false);
 await f.engine.tick();assert.equal(attempts(),2);assert.equal(f.task.state,'verifying');assert.equal(f.task.operation.stage,'accepted');assert.equal(f.task.unclearStreak,0);
 assert.equal(f.task.operation.quote.host.id,'synthetic-other-host');
});
test('连续两次点击结果都不明（都确认未创建）：清除记录、提醒一次，但不停止；那台主机暂时不选，到时再试',async t=>{
 const f=fixture(t);f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_UNCLEAR','合成页面无结果');};
 f.adapter.reconcile=async()=>({notCreated:true,reason:'合成：没有新实例'});
 await f.engine.tick();await f.due(120000);assert.equal(f.task.state,'watching');
 // 只有一台主机且刚被暂停选择：本轮不点击，继续监测。
 await f.engine.tick();assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);assert.match(f.task.lastScan.summary,/暂不选择最近被平台拒绝的主机/);
 f.advance(2*60000);await f.engine.tick();assert.equal(f.task.state,'verifying');await f.due(120000);
 assert.equal(f.task.state,'watching');assert.equal(f.task.operation,null);assert.equal(f.task.unclearStreak,2);
 assert.equal(f.task.hostCooldowns[0].count,2);assert.equal(f.task.hostCooldowns[0].until-f.task.hostCooldowns[0].at,4*60000);
 assert.equal(f.store.data.notifications.filter(n=>n.event==='unclear-clicks').length,1);assert.equal(f.store.data.notifications.some(n=>n.event==='attention'),false);
});
test('点击结果不明：自动核对发现目标主机上唯一的新实例时直接绑定并完成，不需要手动绑定',async t=>{
 const f=fixture(t);f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_UNCLEAR','合成页面无结果');};
 f.adapter.reconcile=async task=>task.operation.receipt?{instance:{id:'synthetic-bound',running:true,gpuVerified:true}}
   :{receipt:{acceptedAt:task.operation.at,instanceId:'synthetic-bound',evidence:'unique-new-instance-on-selected-host-after-unclear-click'},instance:{id:'synthetic-bound',running:true,gpuVerified:true}};
 await f.engine.tick();await f.due(120000);assert.equal(f.task.state,'completed');assert.equal(f.task.operation.receipt.instanceId,'synthetic-bound');
});
test('自动核对时读取实例列表失败：30秒后再试，连续3次失败才交给用户；登录失效立即交给用户',async t=>{
 const f=fixture(t);f.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_UNCLEAR','合成页面无结果');};
 f.adapter.reconcile=async()=>{throw new AppError('LIST_LOADING','合成列表加载中',{retryable:true});};
 await f.engine.tick();await f.due(120000);assert.equal(f.task.state,'verifying');assert.equal(f.task.operation.recheckFailures,1);assert.equal(f.task.nextCheckAt-f.clock(),30000);
 await f.due(30000);assert.equal(f.task.operation.recheckFailures,2);assert.equal(f.task.state,'verifying');
 await f.due(30000);assert.equal(f.task.state,'reconciling');assert.ok(f.store.data.notifications.some(n=>n.event==='ambiguous'));
 const g=fixture(t);g.adapter.submit=async(task,q,mark)=>{mark();throw new AppError('SUBMIT_UNCLEAR','合成页面无结果');};
 g.adapter.reconcile=async()=>{throw new AppError('LOGIN_REQUIRED','合成登录失效');};
 await g.engine.tick();await g.due(120000);assert.equal(g.task.state,'reconciling');assert.equal(g.task.operation.stage,'click_started');
});
test('服务重启时点击结果不明：自动等到点击约2分钟后核对，不先报警',async t=>{
 const f=fixture(t);f.store.patch(f.task,{state:'submitting',operation:{id:'synthetic-op',stage:'click_started',at:f.clock()-30000,baselineIds:[]}});
 const engine=new Engine(f.store,{autodl:f.adapter},f.notifier,{clock:f.clock,random:()=>0});
 assert.equal(f.task.state,'verifying');assert.equal(f.task.nextCheckAt,f.task.operation.at+120000);assert.equal(f.store.data.notifications.some(n=>n.event==='restart-reconcile'),false);
 await engine.tick();assert.equal(f.task.state,'verifying');assert.equal(f.submissions,0);
});
// 余额预检：只用页面单卡价估算下限；余额确定不够时提醒一次并继续监测，充值后自动恢复。余额由测试替身给出。
const lowWallet=(f,balance)=>{const w={snapshot:{balance,vouchers:0,checkedAt:f.clock()},calls:[],
  recentBalance:async maxAge=>{w.calls.push(maxAge);w.snapshot={...w.snapshot,balance:w.balance??w.snapshot.balance,checkedAt:f.clock()};return w.snapshot;},
  refresh:async()=>w.snapshot,check:async()=>({requiredMilli:1980,checkedAt:f.clock()}),confirm:()=>{}};f.engine.wallet=w;return w;};
test('监测中余额不足以支付页面单卡价：提醒一次，不刷屏；充值后解除',async t=>{
 const f=fixture(t,{balanceGuard:true,availableAfter:100});const w=lowWallet(f,1);
 await f.engine.tick();assert.match(f.task.balanceLow.message,/不足页面单卡价 ¥1\.98\/时 × 1 卡 × 1 小时/);assert.equal(w.calls[0],300000);
 await f.due(20000);assert.equal(f.store.data.notifications.filter(n=>n.event==='balance-low').length,1);assert.equal(f.task.state,'watching');
 w.balance=50;await f.due(20000);assert.equal(f.task.balanceLow,null);assert.ok(f.task.logs.some(l=>l.message==='余额已足够，恢复自动提交'));
});
test('找到空闲 GPU 时余额确定不足：跳过核验与提交继续监测；充值后下一次找到即提交',async t=>{
 const f=fixture(t,{balanceGuard:true});const w=lowWallet(f,1);let prepares=0;const prepare=f.adapter.prepare.bind(f.adapter);
 f.adapter.prepare=async(...args)=>{prepares++;return prepare(...args);};
 await f.engine.tick();assert.equal(prepares,0);assert.equal(f.submissions,0);assert.equal(f.task.state,'watching');assert.ok(f.task.balanceLow);
 assert.ok(f.task.logs.some(l=>/余额不足，未核验和提交，请先充值/.test(l.message)));
 w.balance=50;await f.due(20000);assert.equal(w.calls.at(-1),0);assert.equal(prepares,1);assert.equal(f.submissions,1);assert.equal(f.task.balanceLow,null);
});
test('仅监测任务和关闭余额保护的任务不做余额预检',async t=>{
 const observe=fixture(t,{action:'observe',balanceGuard:true});const w=lowWallet(observe,0);await observe.engine.tick();assert.equal(w.calls.length,0);assert.equal(observe.task.state,'found');
 const off=fixture(t,{balanceGuard:false});const w2=lowWallet(off,0);await off.engine.tick();assert.equal(w2.calls.length,0);assert.equal(off.submissions,1);
});
test('对账返回可能多租的实例时提醒一次；另一个同型号任务的提交还没绑定实例时，本任务不提交',async t=>{
  const f=fixture(t,{mode:'clone'});await f.engine.tick();assert.equal(f.task.state,'verifying');
  const reconcile=f.adapter.reconcile.bind(f.adapter);f.adapter.reconcile=async task=>({...(await reconcile(task)),lateIds:['synthetic-late01']});
  await f.due(40000);await f.due(30000);assert.equal(f.task.state,'completed');
  assert.equal(f.store.data.notifications.filter(n=>n.event==='possible-duplicate').length,1);assert.deepEqual(f.task.duplicateSuspectIds,['synthetic-late01']);
  const other={id:'synthetic-other-task',config:{...f.task.config,name:'另一任务'},operation:{stage:'click_started',at:f.clock()}};
  assert.equal(f.engine.pendingOverlap({...f.task,id:'synthetic-third'}),null);
  f.store.data.tasks.push(other);assert.equal(f.engine.pendingOverlap({...f.task,id:'synthetic-third'})?.id,'synthetic-other-task');
  assert.equal(f.engine.pendingOverlap({...f.task,id:'synthetic-third',config:{...f.task.config,gpuCount:2}}),null);
});

