import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { normalizeAccountIdentity } from '../src/account-scope.mjs';
import { AppError } from '../src/errors.mjs';
import { createObservatoryFixtureAdapter, OBSERVATORY_INSTANCE_ID } from './fixtures/observatory.mjs';
import { configInput, testConfig } from './fixtures/config.mjs';

const identity = letter => normalizeAccountIdentity({ accountId: `synthetic-account-${letter}`, subAccountId: null,
  kind: 'main', displayName: `合成账号 ${letter}` });
const ACCOUNT_A = identity('A'), ACCOUNT_B = identity('B');
const otherId = id => id?.replace('syntheticobserve-', 'syntheticother-');

// 使用真实本地 HTTP、Store 和 Engine；所有账号、资源、余额及通知响应均为内存合成数据。
// 临时目录与用户 .runtime 分离，任何付费方法、浏览器启动和外部网络请求都禁止执行。
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-account-workspace-'));
  const adapter = createObservatoryFixtureAdapter();
  let current = ACCOUNT_A, identityError = null, session = { state: 'not_open', browserOpen: false };
  let paidCalls = 0, probes = 0, logouts = 0;
  const originalInstances = adapter.observatoryInstances.bind(adapter), originalBills = adapter.observatoryBills.bind(adapter);
  const originalDomInstances = adapter.instances.bind(adapter);
  const forbidden = async () => { paidCalls++; throw Error('账号隔离测试禁止真实网络或付费操作'); };
  Object.assign(adapter, {
    sessionStatus: () => ({ ...session }),
    checkLogin: async () => { session = { state: 'ready', browserOpen: true }; return { session: { ...session } }; },
    login: forbidden,
    logout: async () => { logouts++; session = { state: 'not_open', browserOpen: false }; return { message: '合成会话已退出' }; },
    readIdentity: async () => { if (identityError) throw identityError; return { ...current }; },
    instances: async () => (await originalDomInstances()).map(row => current.ownerId === ACCOUNT_B.ownerId ? { ...row, id: otherId(row.id) } : row),
    observatoryInstances: async options => {
      const result = await originalInstances(options);
      if (current.ownerId === ACCOUNT_B.ownerId) result.list = result.list.map(row => ({ ...row, uuid: otherId(row.uuid), name: '账号 B 的合成实例' }));
      return result;
    },
    observatoryBills: async options => {
      const result = await originalBills(options);
      result.list = result.list.map(row => ({ ...row, uuid: current.accountId + '-' + row.uuid,
        ...(current.ownerId === ACCOUNT_B.ownerId ? { product_uuid: otherId(row.product_uuid) } : {}) }));
      return result;
    },
    probe: async () => { probes++; throw Error('账号不符时不得读取资源'); },
    inspectBoot: async () => { probes++; throw Error('账号不符时不得读取原实例'); },
    prepare: forbidden, submit: forbidden, boot: forbidden,
  });
  const app = createApplication({ runtimeDir: dir, startEngine: false, adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden },
    walletOptions: { fetchImpl: async () => new Response(JSON.stringify({ code: 'Success', data: { assets: 123400, voucher_balance: 5000 } })) } });
  const delivered = [];
  app.engine.notifier.fetch = async (_url, options) => { delivered.push(JSON.parse(options.body)); return new Response('{}'); };
  t.after(async () => {
    await app.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-account-workspace-'));
    fs.rmSync(target, { recursive: true, force: true });
    assert.equal(paidCalls, 0);
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Local-Token': app.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await request('/api/state')).body;
  const connect = async (next = ACCOUNT_A) => {
    current = next;
    const result = await request('/api/browser/check', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.account.ownerId, next.ownerId);
  };
  const cache = async () => {
    for (const route of ['/api/autodl/instances', '/api/observatory/overview', '/api/observatory/billing', '/api/autodl/gpus']) {
      const result = await request(route, {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const result = await request('/api/wallet/token', { token: 'synthetic-developer-token', rememberToken: false });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  const seedTask = ({ ownerId, state = 'queued', mode = 'create', ...patch } = {}) => {
    const task = app.store.create(testConfig({ mode, sourceId: OBSERVATORY_INSTANCE_ID }), { ownerId });
    app.store.patch(task, { state, ...patch });
    return task;
  };
  return { app, adapter, dir, request, state, connect, cache, seedTask, delivered,
    setAccount: value => { current = value; }, setIdentityError: value => { identityError = value; },
    setSession: value => { session = value; }, get probes() { return probes; }, get logouts() { return logouts; } };
}

test('主机明细要求当前账号并在查询结束复核身份，不泄露跨账号结果', async t => {
  const f = await fixture(t); let calls = 0;
  f.adapter.marketHosts = async query => { calls++; assert.deepEqual(query,{model:'RTX 4090',region:'北京B区'}); return {rows:[{hostId:'synthetic-host'}]}; };
  const query={model:'RTX 4090',region:'北京B区'};
  assert.equal((await f.request('/api/market/hosts',query)).status,409);
  assert.equal(calls,0);
  await f.connect();
  assert.equal((await f.request('/api/market/hosts',query)).status,200);
  assert.equal(calls,1);
  f.adapter.marketHosts = async () => {f.setAccount(ACCOUNT_B);return {rows:[{hostId:'must-not-return'}]};};
  const changed=await f.request('/api/market/hosts',query);
  assert.equal(changed.status,409);
  assert.equal(JSON.stringify(changed.body).includes('must-not-return'),false);
  assert.equal(f.app.store.tasks().length,0);
});

test('日志导出返回本机最近200条，不受界面80条限制，且仅允许当前账号读取',async t=>{
  const f=await fixture(t);await f.connect();
  const own=f.seedTask({ownerId:ACCOUNT_A.ownerId,state:'completed'}),other=f.seedTask({ownerId:ACCOUNT_B.ownerId,state:'completed'});
  f.app.store.patch(own,{logs:Array.from({length:200},(_,i)=>({at:1700000000000+i,level:'info',message:'合成记录 '+i})),monitor:{samples:[]}});
  assert.equal((await f.state()).tasks.find(task=>task.id===own.id).logs.length,80);
  const exported=await f.request('/api/tasks/'+own.id+'/logs');
  assert.equal(exported.status,200);assert.equal(exported.body.limit,200);assert.equal(exported.body.logs.length,200);
  assert.equal(exported.body.logs[0].message,'合成记录 0');assert.equal(exported.body.logs.at(-1).message,'合成记录 199');
  assert.equal(exported.body.task.id,own.id);assert.equal(exported.body.task.config,undefined);
  assert.equal((await f.request('/api/tasks/'+other.id+'/logs')).status,409);
  f.setSession({state:'expired',browserOpen:true});
  assert.equal((await f.request('/api/tasks/'+own.id+'/logs')).status,409);
});

function assertPrivateHidden(state) {
  assert.equal(state.account.identity, null);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.autodlInstances.instances, []);
  assert.equal(state.observatory, null);
  assert.equal(state.market, null);
  assert.equal(state.gpuCatalog, null);
  assert.equal(state.wallet.configured, false);
  assert.equal(state.wallet.snapshot, null);
}

test('测试通知发送期间换号，不将原账号回执返回为新账号发送成功', async t => {
  const f = await fixture(t); await f.connect();
  await f.request('/api/notifications/settings', { webhookEnabled: true, webhookUrl: 'https://synthetic.invalid/test-account-a', rememberCredentials: false });
  let entered, release; const entry = new Promise(resolve => entered = resolve), hold = new Promise(resolve => release = resolve);
  f.app.engine.notifier.fetch = async () => { entered(); await hold; return new Response(null, { status: 204 }); };
  const pending = f.request('/api/notifications/test', { channel: 'webhook' }); await entry;
  try { await f.connect(ACCOUNT_B); } finally { release(); }
  const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.error, 'NOTIFICATION_CONTEXT_CHANGED');
  assert.equal(f.app.store.tasks().length, 0); assert.equal(f.app.store.data.notifications.length, 0);
});

test('任务控制的账号核验遵守页面锁，忙碌时不会读错页面并清空连接', async t => {
  const f = await fixture(t); await f.connect();
  const task = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'paused' });
  let reads = 0;
  f.adapter.readIdentity = async () => { reads++; throw Error('合成页面正在导航，账号读取被中断'); };
  f.app.engine.busy = true;
  try {
    for (const action of ['resume', 'verify-data', 'attach', 'recheck']) {
      const response = await f.request(`/api/tasks/${task.id}/${action}`, { confirmed: true, instanceId: 'synthetic-target' });
      assert.equal(response.status, 409, action + ' 应先报告页面忙碌');
      assert.equal(response.body.error, 'BUSY');
      assert.equal(reads, 0, action + ' 不能绕过锁读取身份');
      assert.equal((await f.state()).account.identity?.ownerId, ACCOUNT_A.ownerId, '忙碌不应导致账号意外断开');
    }
  } finally { f.app.engine.busy = false; }
});

test('恢复核验占有页面锁，核验中的后续取消不会被旧恢复请求覆盖', async t => {
  const f = await fixture(t); await f.connect();
  const task = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'paused', mode: 'boot',
    operation: { id: 'synthetic-boot-operation', stage: 'accepted', receipt: { instanceId: OBSERVATORY_INSTANCE_ID } } });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  f.adapter.readIdentity = async () => { enter(); await released; return { ...ACCOUNT_A }; };
  const resuming = f.request(`/api/tasks/${task.id}/resume`, {});
  try {
    await entered;
    assert.equal(f.app.engine.busy, true, '账号核验与状态修改之间必须持有页面锁');
    const busy = await f.request('/api/market/hosts', { model: 'RTX 4090' });
    assert.equal(busy.body.error, 'BUSY');
    const cancelled = await f.request(`/api/tasks/${task.id}/cancel`, {});
    assert.equal(cancelled.status, 200, '停止不等待账号核验结束');
    assert.equal(task.state, 'cancelled');
  } finally { release(); }
  const response = await resuming;
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'TASK_CHANGED');
  assert.equal(task.state, 'cancelled');
  assert.equal(f.app.engine.busy, false);
});

test('HTTP 新任务必须先确认账号，ownerId 与任务首次保存原子落盘', async t => {
  const f = await fixture(t);
  assertPrivateHidden(await f.state());
  assert.equal((await f.request('/api/tasks', configInput())).status, 409);
  assert.equal(f.app.store.tasks().length, 0);
  await f.connect();
  const saves = [], originalSave = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { originalSave(); saves.push(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8'))); };
  // 客户端提供的 ownerId 不可信，归属必须来自服务端刚核验的账号。
  const result = await f.request('/api/tasks', configInput({ ownerId: ACCOUNT_B.ownerId, name: '账号 A 新建任务' }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.task.ownerId, ACCOUNT_A.ownerId);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].tasks[0].ownerId, ACCOUNT_A.ownerId);
  assert.equal(saves[0].tasks[0].id, result.body.task.id);
  assert.equal((await f.state()).tasks[0].ownerId, ACCOUNT_A.ownerId);
});

test('HTTP 源实例查询后最终身份核验失败，不落盘新任务', async t => {
  const f = await fixture(t);
  await f.connect();
  const originalInstances = f.adapter.instances;
  let sourceRead = false;
  f.adapter.instances = async (...args) => {
    const rows = await originalInstances(...args);
    sourceRead = true;
    // 模拟异步实例查询完成后身份服务失效，入口核验已经成功。
    f.setIdentityError(new AppError('ACCOUNT_IDENTITY', '合成最终身份核验失败', { status: 409 }));
    return rows;
  };
  const result = await f.request('/api/tasks', configInput({ mode: 'boot', sourceId: OBSERVATORY_INSTANCE_ID }));
  assert.equal(sourceRead, true);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'ACCOUNT_IDENTITY');
  assert.equal(result.body.task, undefined);
  assert.deepEqual(f.app.store.tasks(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).tasks, []);
  assertPrivateHidden(await f.state());
});

test('HTTP 新任务落盘后不再请求身份，201 与磁盘和当前账号一致', async t => {
  const f = await fixture(t);
  await f.connect();
  const originalIdentity = f.adapter.readIdentity;
  let beforeWrites = 0, afterWrites = 0;
  f.adapter.readIdentity = async () => {
    // 若写入后再请求身份，模拟该请求失败，防止“实际入队但 HTTP 报错”的回归。
    if (f.app.store.tasks().length) {
      afterWrites++;
      throw new AppError('ACCOUNT_IDENTITY', '不应执行的落盘后身份请求', { status: 409 });
    }
    beforeWrites++;
    return originalIdentity();
  };
  const result = await f.request('/api/tasks', configInput({ name: '合成成功创建任务' }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.ok(beforeWrites > 0);
  assert.equal(afterWrites, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).tasks;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, result.body.task.id);
  assert.equal(saved[0].ownerId, ACCOUNT_A.ownerId);
  assert.equal(result.body.task.ownerId, ACCOUNT_A.ownerId);
  assert.equal(f.app.store.tasks()[0].id, result.body.task.id);
  const current = await f.state();
  assert.equal(current.account.identity.ownerId, result.body.task.ownerId);
  assert.equal(current.tasks[0].id, result.body.task.id);
});

test('HTTP A 切换 B 清空账号缓存、暂停 A 任务且仅显示 B 的任务和通知', async t => {
  const f = await fixture(t);
  await f.connect();
  const taskA = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  const receiptA = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'verifying', operation: {
    stage: 'click_started', at: Date.now(), receipt: { instanceId: OBSERVATORY_INSTANCE_ID } } });
  const taskB = f.seedTask({ ownerId: ACCOUNT_B.ownerId, state: 'completed', result: { id: otherId(OBSERVATORY_INSTANCE_ID) } });
  f.app.store.enqueueNotification(taskA, 'found', '账号 A 的通知');
  f.app.store.enqueueNotification(taskB, 'completed', '账号 B 的通知');
  await f.cache();
  const a = await f.state();
  assert.deepEqual(new Set(a.tasks.map(task => task.id)), new Set([taskA.id, receiptA.id]));
  assert.deepEqual(a.notifications.map(item => item.taskId), [taskA.id]);
  assert.ok(a.observatory.overview.instances.some(row => row.id === OBSERVATORY_INSTANCE_ID));
  assert.ok(a.observatory.billing.items.length > 0);
  assert.ok(a.gpuCatalog.regions.length > 0);
  assert.ok(a.market.snapshot);
  assert.ok(a.market.history.length > 0);
  assert.equal(a.wallet.snapshot.balance, 123.4);
  await f.connect(ACCOUNT_B);
  const b = await f.state();
  assert.equal(b.account.identity.ownerId, ACCOUNT_B.ownerId);
  assert.deepEqual(b.tasks.map(task => task.id), [taskB.id]);
  assert.deepEqual(b.notifications.map(item => item.taskId), [taskB.id]);
  assert.equal(taskA.state, 'paused');
  assert.equal(receiptA.state, 'paused');
  assert.equal(receiptA.operation.receipt.instanceId, OBSERVATORY_INSTANCE_ID);
  assert.deepEqual(b.autodlInstances.instances, []);
  assert.equal(b.observatory.overview, null);
  assert.equal(b.observatory.billing, null);
  assert.equal(b.gpuCatalog, null);
  assert.equal(b.market.snapshot, null);
  assert.deepEqual(b.market.history, []);
  assert.equal(b.wallet.configured, false);
  assert.equal(b.wallet.snapshot, null);
  await f.request('/api/observatory/overview', {});
  await f.request('/api/observatory/billing', {});
  const refreshed = await f.state();
  assert.ok(refreshed.observatory.overview.instances.some(row => row.id === otherId(OBSERVATORY_INSTANCE_ID)));
  assert.equal(JSON.stringify(refreshed.observatory).includes(OBSERVATORY_INSTANCE_ID), false);
  assert.equal(JSON.stringify(refreshed.observatory.billing).includes(ACCOUNT_A.accountId), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).tasks.find(task => task.id === taskA.id).ownerId, ACCOUNT_A.ownerId);
});

test('HTTP 正常退出与会话失效均隐藏全部私有数据，原记录保留', async t => {
  const f = await fixture(t);
  await f.connect();
  const task = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  f.app.store.enqueueNotification(task, 'found', '合成账号私有消息');
  await f.cache();
  f.setSession({ state: 'expired', browserOpen: true });
  assertPrivateHidden(await f.state());
  await f.connect();
  assert.equal((await f.request('/api/browser/logout', {})).status, 200);
  assert.equal(f.logouts, 1);
  assertPrivateHidden(await f.state());
  assert.equal(task.state, 'paused');
  assert.equal(task.ownerId, ACCOUNT_A.ownerId);
  assert.equal(f.app.store.tasks().length, 1);
  assert.equal(f.app.store.data.notifications.length, 1);
});

test('HTTP 完整实例列表才认领旧完成任务，精确目标 ID 保留原完成记录', async t => {
  const f = await fixture(t);
  const exact = f.seedTask({ state: 'completed', result: { id: OBSERVATORY_INSTANCE_ID } });
  const receipt = f.seedTask({ state: 'completed', operation: { stage: 'accepted', receipt: { instanceId: OBSERVATORY_INSTANCE_ID } } });
  const prefix = f.seedTask({ state: 'completed', result: { id: OBSERVATORY_INSTANCE_ID.slice(0, -1) } });
  const sourceOnly = f.seedTask({ state: 'completed', mode: 'clone', result: { id: 'anotherinstance-12345678' } });
  const other = f.seedTask({ ownerId: ACCOUNT_B.ownerId, state: 'completed', result: { id: OBSERVATORY_INSTANCE_ID } });
  f.app.store.enqueueNotification(exact, 'completed', '旧任务成功通知');
  const originalResult = structuredClone(exact.result), originalLogs = structuredClone(exact.logs), createdAt = exact.createdAt;
  await f.connect();
  assert.deepEqual((await f.state()).tasks, []);
  const original = f.adapter.observatoryInstances;
  // 空缺后续页使分页不完整，即便首批包含精确目标也不能认领。
  f.adapter.observatoryInstances = async options => options.pageIndex === 1 ? { ...(await original(options)), result_total: 4 } : { list: [], result_total: 4 };
  assert.equal((await f.request('/api/observatory/overview', {})).status, 200);
  assert.equal(exact.ownerId, undefined);
  assert.equal((await f.state()).account.unclaimedCount, 4);
  f.adapter.observatoryInstances = original;
  assert.equal((await f.request('/api/observatory/overview', {})).status, 200);
  const state = await f.state();
  assert.deepEqual(new Set(state.tasks.map(task => task.id)), new Set([exact.id, receipt.id]));
  assert.deepEqual(state.notifications.map(item => item.taskId), [exact.id]);
  assert.equal(state.account.unclaimedCount, 2);
  assert.equal(exact.ownerId, ACCOUNT_A.ownerId);
  assert.equal(exact.ownerClaim.evidence, 'result');
  assert.equal(receipt.ownerClaim.evidence, 'receipt');
  assert.equal(prefix.ownerId, undefined);
  assert.equal(sourceOnly.ownerId, undefined);
  assert.equal(other.ownerId, ACCOUNT_B.ownerId);
  assert.equal(exact.state, 'completed');
  assert.equal(exact.createdAt, createdAt);
  assert.deepEqual(exact.result, originalResult);
  assert.deepEqual(exact.logs, originalLogs);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8'));
  assert.equal(saved.tasks.find(task => task.id === exact.id).ownerId, ACCOUNT_A.ownerId);
});

test('HTTP 跨账号任务命令和替换请求拒绝，不能返回或修改 A 任务', async t => {
  const f = await fixture(t);
  await f.connect();
  const taskA = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'paused' });
  const legacy = f.seedTask({ state: 'paused' });
  await f.connect(ACCOUNT_B);
  const original = structuredClone(taskA);
  for (const command of ['pause', 'resume', 'cancel', 'attach', 'verify-data', 'recheck']) {
    const result = await f.request(`/api/tasks/${taskA.id}/${command}`, { instanceId: OBSERVATORY_INSTANCE_ID, confirmed: true });
    assert.equal(result.status, 409, command);
    assert.equal(result.body.error, 'ACCOUNT_MISMATCH');
    assert.equal(result.body.task, undefined);
  }
  assert.deepEqual(taskA, original);
  assert.equal((await f.request(`/api/tasks/${legacy.id}/resume`, {})).body.error, 'ACCOUNT_UNCLAIMED');
  const replaced = await f.request('/api/tasks', configInput({ replaceTaskId: taskA.id }));
  assert.equal(replaced.status, 409);
  assert.equal(replaced.body.error, 'ACCOUNT_MISMATCH');
  assert.equal(f.app.store.tasks().length, 2);
  const own = await f.request('/api/tasks', configInput());
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.task.ownerId, ACCOUNT_B.ownerId);
});

test('HTTP 身份读取失败不会回显旧身份或缓存，重新连接 B 后仍不可见 A', async t => {
  const f = await fixture(t);
  await f.connect();
  const taskA = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  f.app.store.enqueueNotification(taskA, 'found', '账号 A 消息');
  await f.cache();
  f.setIdentityError(new AppError('ACCOUNT_IDENTITY', '合成身份查询失败', { status: 409 }));
  const failed = await f.request('/api/browser/check', {});
  assert.equal(failed.status, 409);
  assert.equal(failed.body.account, undefined);
  const hidden = await f.state();
  assertPrivateHidden(hidden);
  assert.match(hidden.account.error, /身份查询失败/);
  assert.equal((await f.request('/api/tasks', configInput())).status, 409);
  f.setIdentityError(null);
  await f.connect(ACCOUNT_B);
  assert.deepEqual((await f.state()).tasks, []);
  assert.equal(taskA.state, 'paused');
});

test('真实 Engine.step 在未确认账号、错误账号及身份失效时暂停且不 probe', async t => {
  const f = await fixture(t);
  const noIdentity = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  await f.app.engine.step(noIdentity);
  assert.equal(noIdentity.state, 'paused');
  assert.equal(noIdentity.attempts, 0);
  await f.connect(ACCOUNT_B);
  for (const mode of ['create', 'boot']) {
    const wrong = f.seedTask({ ownerId: ACCOUNT_A.ownerId, mode });
    await f.app.engine.step(wrong);
    assert.equal(wrong.state, 'paused');
    assert.equal(wrong.attempts, 0);
    assert.match(wrong.lastError, /所属账号不同/);
  }
  const failed = f.seedTask({ ownerId: ACCOUNT_B.ownerId });
  f.setIdentityError(new AppError('ACCOUNT_IDENTITY', '合成身份请求失败', { status: 409 }));
  await f.app.engine.step(failed);
  assert.equal(failed.state, 'paused');
  assert.equal(failed.attempts, 0);
  assertPrivateHidden(await f.state());
  assert.equal(f.probes, 0);
});

test('切换账号和清除凭据推进通知配置修订，旧页面不能恢复先前的通知配置', async t => {
  const f = await fixture(t); await f.connect();
  const saved = await f.request('/api/notifications/settings', { expectedRevision: 0,
    wechatEnabled: true, wechatToken: 'synthetic-account-notification-token', rememberCredentials: false });
  assert.equal(saved.body.notificationSettingsRevision, 1);
  await f.connect(ACCOUNT_B);
  assert.equal((await f.state()).notificationSettingsRevision, 2);
  const stale = await f.request('/api/notifications/settings', { ...saved.body.settings, expectedRevision: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'NOTIFICATION_SETTINGS_CHANGED');
  assert.equal(f.app.store.data.settings.wechatEnabled, false);
  await f.request('/api/browser/logout', { clearCredentials: true });
  assert.equal((await f.state()).notificationSettingsRevision, 3);
  await f.connect(ACCOUNT_A);
  assert.equal((await f.state()).notificationSettingsRevision, 4);
  const oldTest = await f.request('/api/notifications/test', { channel: 'wechat', expectedRevision: 1 });
  assert.equal(oldTest.status, 409); assert.deepEqual(f.delivered, []);
});

test('通知读取和发送只处理当前账号，断开会话时不外发旧通知', async t => {
  const f = await fixture(t);
  await f.connect();
  const a = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'completed' });
  const b = f.seedTask({ ownerId: ACCOUNT_B.ownerId, state: 'completed' });
  const legacy = f.seedTask({ state: 'completed' });
  for (const task of [a, b, legacy]) f.app.store.enqueueNotification(task, 'completed', `合成通知 ${task.id}`);
  f.app.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.invalid/notification' };
  await f.app.engine.notifier.flush();
  assert.deepEqual(f.delivered.map(message => message.taskId), [a.id]);
  assert.equal((await f.request('/api/notifications/read', {})).status, 200);
  assert.deepEqual(f.app.store.data.notifications.filter(n => n.read).map(n => n.taskId), [a.id]);
  await f.connect(ACCOUNT_B);
  assert.equal(f.app.store.data.settings.webhookEnabled, false);
  f.app.store.data.settings.webhookEnabled = true;
  f.setSession({ state: 'expired', browserOpen: true });
  await f.app.engine.notifier.flush();
  assert.deepEqual(f.delivered.map(message => message.taskId), [a.id]);
  await f.connect(ACCOUNT_B);
  await f.app.engine.notifier.flush();
  assert.deepEqual(f.delivered.map(message => message.taskId), [a.id, b.id]);
  assert.equal((await f.request('/api/notifications/read', {})).status, 200);
  assert.equal(f.app.store.data.notifications.find(n => n.taskId === legacy.id).read, false);
});

test('HTTP 身份服务失效时退出仍可清除专用会话和缓存', async t => {
  const f = await fixture(t);
  await f.connect();
  const task = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  await f.cache();
  f.setIdentityError(new AppError('ACCOUNT_IDENTITY', '合成身份服务暂不可用', { status: 409 }));
  const result = await f.request('/api/browser/logout', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.logouts, 1);
  assert.equal(task.state, 'paused');
  assertPrivateHidden(await f.state());
});

test('HTTP 会话失效后的任务控制不能返回私有任务或标记旧账号通知', async t => {
  const f = await fixture(t);
  await f.connect();
  const task = f.seedTask({ ownerId: ACCOUNT_A.ownerId });
  f.app.store.enqueueNotification(task, 'found', '已断开账号的通知');
  f.setSession({ state: 'expired', browserOpen: true });
  for (const command of ['pause', 'cancel']) {
    const result = await f.request(`/api/tasks/${task.id}/${command}`, {});
    assert.equal(result.status, 409, command);
    assert.equal(result.body.task, undefined);
  }
  await f.request('/api/notifications/read', {});
  assert.equal(f.app.store.data.notifications[0].read, false);
});

test('通知发送等待期间切换账号，B 消息不能沿用 A 的通知渠道', async t => {
  const f = await fixture(t);
  await f.connect();
  const a = f.seedTask({ ownerId: ACCOUNT_A.ownerId, state: 'completed' });
  const b = f.seedTask({ ownerId: ACCOUNT_B.ownerId, state: 'completed' });
  f.app.store.enqueueNotification(a, 'completed', '账号 A 消息');
  f.app.store.enqueueNotification(b, 'completed', '账号 B 消息');
  f.app.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.invalid/account-a' };
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const sent = [];
  f.app.engine.notifier.fetch = async (url, options) => {
    sent.push({ url, taskId: JSON.parse(options.body).taskId });
    if (sent.length === 1) { entered(); await pending; }
    return new Response('{}');
  };
  // 通知请求不占用浏览器操作锁，真实用户可在外部渠道回执尚未到达时切换账号。
  const flushing = f.app.engine.notifier.flush();
  await started;
  try { await f.connect(ACCOUNT_B); }
  finally { release(); await flushing; }
  assert.deepEqual(sent, [{ url: 'https://synthetic.invalid/account-a', taskId: a.id }]);
  assert.equal(f.app.store.data.notifications.find(n => n.taskId === b.id).deliveries.webhook, undefined);
});
