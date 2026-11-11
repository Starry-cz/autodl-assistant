import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { testConfig } from './fixtures/config.mjs';
import { fixture } from './helpers.mjs';
// 仅内存中的合成实例列表；实例ID、主机号及配置不指向真实账号。
const makeTask=(overrides={})=>({config:testConfig({gpuModel:'RTX 4090',mode:'clone',sourceId:'synthetic-source',action:'execute',paidConsent:true,...overrides}),operation:{stage:'accepted',at:Date.now(),quote:{host:{number:'合成922机'}},baselineIds:['synthetic-existing'],receipt:{acceptedAt:Date.now(),instanceId:null}}});
const instance=patch=>({id:'synthetic-newtarget',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'合成922机',running:true,...patch});
const adapter=()=>new AutoDLBrowserAdapter('isolated-unused-profile');
test('差集候选必须同时匹配地区、精确型号、数量、目标主机，排除源与基线',()=>{
  const a=adapter(),t=makeTask();const rows=[instance({id:'synthetic-existing'}),instance({id:'synthetic-source'}),instance({id:'synthetic-wrongmodel',gpuModel:'RTX 4090D'}),instance({id:'synthetic-wrongregion',region:'北京A区'}),instance({id:'synthetic-wrongcount',gpuCount:2}),instance({id:'synthetic-wronghost',hostNumber:'合成923机'}),instance()];
  assert.deepEqual(a.newTargets(rows,t).map(i=>i.id),['synthetic-newtarget']);
  delete t.operation.baselineIds;assert.deepEqual(a.newTargets(rows,t),[]);
});
test('受理导航有证据且唯一精确新增目标才自动绑定',async()=>{
  const a=adapter(),t=makeTask();a.instances=async()=>[instance()];const result=await a.reconcile(t);assert.equal(result.receipt.instanceId,'synthetic-newtarget');assert.equal(result.instance.gpuVerified,true);
});
test('点击结果不明：点击2分钟内等待；之后目标主机恰好一个新实例自动绑定，没有新实例确认未创建，其余交给用户核对',async()=>{
  const a=adapter(),t=makeTask();t.operation.stage='click_started';t.operation.receipt=null;t.operation.at=Date.now();a.rejectRecheckMs=0;
  a.instances=async()=>[instance()];assert.equal((await a.reconcile(t)).pending,true);
  t.operation.at=Date.now()-3*60000;
  const bound=await a.reconcile(t);assert.equal(bound.receipt.instanceId,'synthetic-newtarget');assert.equal(bound.instance.gpuVerified,true);assert.equal(bound.receipt.acceptedAt,t.operation.at);
  let reads=0;a.instances=async()=>{reads++;return [];};assert.equal((await a.reconcile(t)).notCreated,true);assert.equal(reads,2);
  a.instances=async()=>[instance(),instance({id:'synthetic-newsecond'})];assert.equal((await a.reconcile(t)).ambiguous,true);
  a.instances=async()=>[instance({id:'synthetic-otherhost',hostNumber:'合成923机'})];const other=await a.reconcile(t);assert.equal(other.ambiguous,true);assert.match(other.reason,/synthetic-otherhost/);
});
test('多个匹配候选不能猜测绑定',async()=>{
  const a=adapter(),t=makeTask();a.instances=async()=>[instance(),instance({id:'synthetic-newsecond'})];assert.equal((await a.reconcile(t)).ambiguous,true);
});
test('受理后列表有短暂延迟可等候，超过窗口需人工处理',async()=>{
  const a=adapter(),t=makeTask();a.instances=async()=>[];assert.equal((await a.reconcile(t)).pending,true);t.operation.receipt.acceptedAt-=91000;assert.equal((await a.reconcile(t)).ambiguous,true);
});
test('已绑定实例先精确核验，型号不符不算完成',async()=>{
  const a=adapter(),t=makeTask();t.operation.receipt.instanceId='synthetic-newtarget';a.instances=async()=>[instance({gpuModel:'RTX 4090D'})];assert.equal((await a.reconcile(t)).ambiguous,true);
  // 写明不符的是哪一项，便于下次判断原因；不写实例 ID。
  const reason=(await a.reconcile(t)).reason;assert.match(reason,/型号为“RTX 4090D”，任务要求 北京B区 · RTX 4090 × 1/);assert.doesNotMatch(reason,/synthetic-newtarget/);
  a.instances=async()=>[instance({gpuCount:null})];assert.match((await a.reconcile(t)).reason,/卡数为 无法识别/);
  t.operation.receipt.acceptedAt-=91000;a.instances=async()=>[];assert.match((await a.reconcile(t)).reason,/已不在实例列表中/);
});
test('手工绑定同样排除源、既有基线实例和不匹配配置',async()=>{
  const a=adapter(),t=makeTask();a.instances=async()=>[instance(),instance({id:'synthetic-existing'}),instance({id:'synthetic-source'})];
  await assert.rejects(()=>a.attach(t,'synthetic-existing'),/基线/);await assert.rejects(()=>a.attach(t,'synthetic-source'),/源实例/);assert.equal((await a.attach(t,'synthetic-newtarget')).instanceId,'synthetic-newtarget');
});
// 页面接口替身：只验证列表读取与分页编排，不启动浏览器，也不连接任何云端。
function listPage(pages) {
  let index = 0;
  return {
    locator(selector) {
      if (selector === 'table tbody tr') return { evaluateAll: async () => (pages[index].texts || []).map(text => ({text, instanceId: text.split('\n')[0], identityColumn: 0})) };
      if (selector === '.el-table__empty-text:visible') return { allInnerTexts: async () => pages[index].empty || [] };
      if (selector === '.el-pagination .btn-next:visible') return {
        count: async () => pages.length > 1 ? 1 : 0,
        isEnabled: async () => index < pages.length - 1,
        click: async () => { index++; },
      };
      throw new Error(`unexpected synthetic locator: ${selector}`);
    },
    waitForFunction: async () => {},
  };
}
const listText = id => `${id}\n北京B区\nRTX 4090 × 1\n922机\n运行中`;
test('空表但没有明确空态时不能保存空实例基线', async () => {
  const a = adapter(); a.page = listPage([{texts:[]}]);
  await assert.rejects(() => a.readInstancePage(), error => error.code === 'LIST_LOADING' && error.retryable === true);
});
test('可见的明确暂无数据空态才允许空实例列表', async () => {
  const a = adapter(); a.page = listPage([{texts:[],empty:[' 暂无数据 ']}]);
  assert.deepEqual((await a.readInstancePage()).instances, []);
});
test('部分列表行无法解析时停止，不漏掉已有实例基线', async () => {
  const a = adapter(); a.page = listPage([{texts:[listText('synthetic-first01'),'页面更新后的未知实例行']}]);
  await assert.rejects(() => a.readInstancePage(), error => error.code === 'DOM_CHANGED');
});
test('读取可解析的合成列表并保留实例身份', async () => {
  const a = adapter(); a.page = listPage([{texts:[listText('synthetic-first01')]}]);
  const result = await a.readInstancePage();
  assert.equal(result.instances[0].id,'synthetic-first01');
  assert.equal(result.instances[0].gpuModel,'RTX 4090');
  assert.equal(result.instances[0].gpuCount,1);
});
test('实例分页基线收集互不重叠的所有页面', async () => {
  const a = adapter();
  a.page = listPage([{texts:[listText('synthetic-first01')]}, {texts:[listText('synthetic-second1')]}]);
  a.settle = async () => {}; a.checkPage = async () => {};
  assert.deepEqual((await a.scanInstances()).map(i => i.id), ['synthetic-first01','synthetic-second1']);
});

// 新实例插入首页会把旧行推到下一页；跨页重复意味着快照发生变化，不能靠去重声称读全。
for (const shifted of ['重复旧行', '后续空页']) test(`提交结果不明时遇到${shifted}，保留点击记录且不再次下单`, async t => {
  const a = adapter(), f = fixture(t, {}, { adapter: a });
  const first = 'synthetic-first01', second = 'synthetic-second1', third = 'synthetic-third01';
  a.goto = async () => { a.page = listPage([
    { texts: [listText(first), listText(second)] },
    shifted === '重复旧行' ? { texts: [listText(second), listText(third)] } : { texts: [], empty: ['暂无数据'] },
  ]); };
  a.settle = async () => {}; a.checkPage = async () => {}; a.rejectRecheckMs = 0;
  const operation = { id: 'synthetic-pagination-operation', stage: 'click_started',
    at: f.clock() - 180000, clickedAt: f.clock() - 180000,
    quote: { host: { number: '922机', region: '北京B区' } }, baselineIds: [first, second, third] };
  f.store.patch(f.task, { state: 'verifying', operation });
  a.probe = async () => assert.fail('分页快照未确认完整，不能重新进入租用');
  await f.engine.tick();
  assert.equal(f.task.operation?.id, operation.id);
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.submissions, 0);
  await f.due(30001);
  assert.equal(f.task.operation?.id, operation.id);
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.submissions, 0);
  // 后续完整快照中出现唯一目标时，恢复正常绑定而不是永久阻断任务。
  a.goto = async () => { a.page = listPage([
    { texts: [listText('synthetic-newtarget'), listText(first)] },
    { texts: [listText(second), listText(third)] },
  ]); };
  await f.due(30001);
  assert.equal(f.task.state, 'completed');
  assert.equal(f.task.operation?.id, operation.id);
  assert.equal(f.task.operation.receipt.instanceId, 'synthetic-newtarget');
  assert.equal(f.submissions, 0);
});

test('平台报拒绝后跨页重复，不能把不完整列表认作未创建', async () => {
  const a = adapter(), t = makeTask();
  const first = 'synthetic-first01', second = 'synthetic-second1';
  a.goto = async () => { a.page = listPage([
    { texts: [listText(first)] }, { texts: [listText(first), listText(second)] },
  ]); };
  a.settle = async () => {}; a.checkPage = async () => {}; a.rejectRecheckMs = 0;
  await assert.rejects(a.confirmNotCreated(t, { baselineIds: [first, second] }, '合成平台拒绝'),
    error => error.code === 'LIST_CHANGED' && error.retryable === true && !error.notCreated);
});

test('实例读取复用导航时的第一页等待，后续每页仍等待并核验登录', async () => {
  for (const ids of [['synthetic-first01'], ['synthetic-first01', 'synthetic-second1']]) {
    const a = adapter(), calls = { goto: 0, settle: 0, checkPage: 0 };
    a.page = listPage(ids.map(id => ({ texts: [listText(id)] })));
    a.page.goto = async () => { calls.goto++; };
    a.browser = async () => a.page;
    a.settle = async () => { calls.settle++; };
    a.checkPage = async () => { calls.checkPage++; };
    assert.deepEqual((await a.instances()).map(row => row.id), ids);
    assert.deepEqual(calls, { goto: 1, settle: ids.length, checkPage: ids.length });
  }
});
