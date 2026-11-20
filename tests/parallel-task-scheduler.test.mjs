import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, gate } from './helpers.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { AppError } from '../src/errors.mjs';

// 所有读取、账号、实例和付费确认均为合成对象；不打开浏览器，不连接 AutoDL。
function setup(t, { count = 2, maxParallel = 2, config = {} } = {}) {
  const f = fixture(t, config);
  f.store.patch(f.task, { ownerId: 'synthetic-owner' });
  for (let i = 1; i < count; i++) f.store.create({ ...f.task.config, name: `任务 ${i}` }, { ownerId: 'synthetic-owner' });
  const tasks = f.store.tasks();
  f.engine.setSchedulingMode('parallel', maxParallel);
  const reads = new Map(), entered = gate(), calls = { active: 0, peak: 0, total: 0, probes: 0 };
  f.adapter.isolatedPrecheck = (snapshot, { signal, maxParallel:limit }) => {
    assert.equal(limit, f.engine.maxParallel);
    calls.total++; calls.active++; calls.peak = Math.max(calls.peak, calls.active);
    const response = gate();
    const abort = () => response.resolve({ error: new AppError('PRECHECK_CANCELLED', '合成预检已结束') });
    signal.addEventListener('abort', abort, { once: true });
    reads.set(snapshot.id, { snapshot, signal, resolve: response.resolve });
    if (reads.size === limit) entered.resolve();
    return response.promise.then(result => { if (result.error) throw result.error; return result; })
      .finally(() => { calls.active--; signal.removeEventListener('abort', abort); });
  };
  const probe = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async (...args) => { calls.probes++; return probe(...args); };
  const candidate = task => ({ verdict: 'candidate', kind: 'market', ownerId: task.ownerId, taskId: task.id, checkedAt: f.clock() });
  const empty = task => ({ ...candidate(task), verdict: 'empty', observation: { source: null, hosts: [], scope: 'full', complete: true,
    catalogOnly: true, catalogTotal: 8, summary: '合成型号汇总无空闲' } });
  return { ...f, tasks, reads, entered, calls, candidate, empty, get submissions() { return f.submissions; },
    async start() { const pending = f.engine.tick(); await entered.promise; return { pending }; },
    resolve(task, result) { reads.get(task.id).resolve(result); } };
}

test('旧数据默认串行，策略保存后重启保留；保存失败不切换或污染设置', async t => {
  const f = fixture(t);
  assert.deepEqual(f.engine.schedulingState(), { mode: 'serial', maxParallel: 2, maxSupportedParallel: 3 });
  f.engine.setSchedulingMode('parallel');
  const store = new Store(f.dir, { clock: f.clock });
  const reloaded = new Engine(store, { autodl: f.adapter }, f.notifier, { clock: f.clock });
  t.after(() => reloaded.stop());
  assert.equal(reloaded.schedulingState().mode, 'parallel');
  const previous = f.store.data.taskScheduling;
  t.mock.method(f.store, 'save', () => { throw new Error('合成保存失败'); });
  assert.throws(() => f.engine.setSchedulingMode('serial'), /合成保存失败/);
  assert.equal(f.engine.schedulingState().mode, 'parallel'); assert.equal(f.store.data.taskScheduling, previous);
  assert.throws(() => f.engine.setSchedulingMode('unlimited'), /调度方式无效/);
});

test('预检数独立于串行或并行模式保存，旧偏好仍按两路，非法值不能提高上限', async t => {
  const f = fixture(t);
  const restore = store => {
    const engine = new Engine(store, {autodl:f.adapter}, f.notifier, {clock:f.clock});
    t.after(() => engine.stop()); return engine;
  };
  const previous = {mode:'parallel'};
  f.store.data.taskScheduling = previous;
  const fromOld = restore(f.store);
  assert.equal(fromOld.schedulingState().maxParallel, 2);
  for (const bad of [null, '3', 1, 2.5, 4]) {
    assert.throws(() => fromOld.setSchedulingMode('parallel', bad), {code:'CONFIG'});
    assert.equal(f.store.data.taskScheduling, previous);
  }
  fromOld.setSchedulingMode('parallel', 3);
  fromOld.setSchedulingMode('serial');
  const reloaded = new Store(f.dir, {clock:f.clock});
  const restarted = restore(reloaded);
  assert.deepEqual(restarted.setSchedulingMode('parallel'), {mode:'parallel',maxParallel:3,maxSupportedParallel:3});
  const state = reloaded.data.taskScheduling;
  t.mock.method(reloaded, 'save', () => { throw new Error('存储失败'); });
  assert.doesNotThrow(() => restarted.setSchedulingMode('parallel', 3));
  assert.throws(() => restarted.setSchedulingMode('parallel', 2), /存储失败/);
  assert.equal(restarted.maxParallel, 3); assert.equal(reloaded.data.taskScheduling, state);
});

test('三路预检同时在途，先完成的任务让出一路给第四项', async t => {
  const f = setup(t, {count:4,maxParallel:3}), [a,b,c,d] = f.tasks;
  const {pending} = await f.start();
  assert.equal(f.calls.active, 3); assert.equal(f.reads.has(d.id), false);
  f.resolve(c, f.empty(c));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.has(d.id), true); assert.equal(f.calls.active, 3);
  for (const task of [d,b,a]) f.resolve(task, f.empty(task));
  await pending;
  assert.equal(f.calls.peak, 3); assert.equal(f.calls.probes, 0);
  assert.ok(f.tasks.every(task => task.attempts === 1 && task.monitor.samples.length === 1));
});

test('三路同时发现候选也只逐一提交，每项各自绑定不同实例', async t => {
  const f = setup(t, {count:3,maxParallel:3}), submit = f.adapter.submit.bind(f.adapter);
  let active = 0, peak = 0;
  f.adapter.submit = async (...args) => {
    active++; peak = Math.max(peak,active);
    try { await new Promise(resolve => setImmediate(resolve)); return await submit(...args); }
    finally { active--; }
  };
  const {pending} = await f.start();
  for (const task of f.tasks) f.resolve(task, f.candidate(task));
  await pending;
  assert.equal(f.calls.peak, 3); assert.equal(peak, 1); assert.equal(f.submissions, 3);
  assert.equal(new Set(f.tasks.map(task => task.operation.receipt.instanceId)).size, 3);
});

test('从三路缩为两路会清理旧读取，缩容后按两路重新分配', async t => {
  const f = setup(t, {count:3,maxParallel:3}), [a,b,c] = f.tasks;
  const {pending} = await f.start();
  f.engine.setSchedulingMode('parallel', 2);
  await pending;
  assert.equal(f.calls.active, 0); assert.equal(f.submissions, 0);
  assert.ok(f.tasks.every(task => !task.attempts && !task.monitor.samples.length));
  f.reads.clear();
  const next = f.engine.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.active, 2); assert.equal(f.reads.has(c.id), false);
  f.resolve(a,f.empty(a)); await new Promise(resolve => setImmediate(resolve));
  f.resolve(b,f.empty(b)); f.resolve(c,f.empty(c)); await next;
  assert.equal(f.calls.active,0); assert.ok(f.tasks.every(task => task.attempts === 1));
});

test('同到期任务真正并发读取，先完成的无卡快照立即记账，单轮峰值最多二个', async t => {
  const f = setup(t), [a, b] = f.tasks, { pending } = await f.start();
  assert.equal(f.calls.peak, 2); assert.equal(f.calls.total, 2); assert.equal(f.engine.busy, true);
  f.resolve(b, f.empty(b));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.attempts, 1); assert.equal(a.attempts, 0);
  assert.equal(b.monitor.samples.length, 1); assert.equal(b.monitor.samples[0].available, 0);
  f.resolve(a, f.empty(a)); await pending;
  assert.equal(f.calls.probes, 0); assert.equal(f.calls.active, 0); assert.equal(f.engine.busy, false);
  assert.equal(a.attempts, 1); assert.equal(f.submissions, 0);
});

test('A 慢读时 B 命中立即开始原提交路径，无需等待 A 完成，预检对象原样传递', async t => {
  const f = setup(t), [a, b] = f.tasks, submitted = gate(), originalSubmit = f.adapter.submit.bind(f.adapter);
  const result = f.candidate(b), originalProbe = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async (task, options) => { assert.equal(options.precheck, result); return originalProbe(task, options); };
  f.adapter.submit = async (...args) => { const receipt = await originalSubmit(...args); submitted.resolve(); return receipt; };
  const { pending } = await f.start(); f.resolve(b, result); await submitted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.attempts, 0); assert.equal(f.calls.active, 1); assert.ok(b.operation?.receipt.instanceId);
  f.resolve(a, f.empty(a)); await pending;
  assert.equal(f.submissions, 1); assert.equal(a.operation, null);
});

test('两个候选仍串行核价提交，分别绑定各自回执，等待中的过期空快照重新读取', async t => {
  const f = setup(t), [a, b] = f.tasks, entered = gate(), release = gate();
  let submitting = 0, peak = 0;
  const submit = f.adapter.submit.bind(f.adapter);
  f.adapter.submit = async (...args) => {
    submitting++; peak = Math.max(peak, submitting);
    if (args[0] === a) { entered.resolve(); await release.promise; }
    const receipt = await submit(...args); submitting--; return receipt;
  };
  const { pending } = await f.start(); f.resolve(a, f.candidate(a)); await entered.promise;
  f.resolve(b, f.empty(b)); f.advance(30000); release.resolve(); await pending;
  assert.equal(peak, 1); assert.equal(f.submissions, 2); assert.equal(f.calls.probes, 2);
  assert.notEqual(a.operation.receipt.instanceId, b.operation.receipt.instanceId);
});

test('预检失败沿用原退避，不在同轮重新请求库存，其他任务可正常完成检查', async t => {
  const f = setup(t), [a, b] = f.tasks, { pending } = await f.start();
  f.resolve(a, { error: new AppError('INVENTORY_UNAVAILABLE', '合成 429 或网络超时', { retryable: true }) });
  f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.state, 'watching'); assert.equal(a.errors, 1);
  assert.equal(a.nextCheckAt, f.clock() + a.config.pollSeconds * 2000);
  assert.equal(a.monitor.samples[0].status, 'error'); assert.equal(b.errors, 0);
  assert.equal(f.calls.probes, 0); assert.equal(f.submissions, 0);
});

for (const action of ['pause', 'cancel', 'pause-resume']) test(`预检中 ${action} 后迟到结果不污染次数和样本，也不提交`, async t => {
  const f = setup(t), [a, b] = f.tasks, { pending } = await f.start();
  f.engine.control(a, action === 'pause-resume' ? 'pause' : action);
  if (action === 'pause-resume') f.engine.control(a, 'resume');
  f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.state, action === 'pause-resume' ? 'watching' : action === 'cancel' ? 'cancelled' : 'paused');
  assert.equal(a.attempts, 0); assert.equal(a.monitor.samples.length, 0); assert.equal(a.errors, 0);
  assert.equal(f.submissions, 0); assert.equal(f.reads.get(a.id).signal.aborted, true);
});

test('切换回串行会终止两条在途读取且不记样本，下一轮沿用串行路径', async t => {
  const f = setup(t), { pending } = await f.start();
  f.engine.setSchedulingMode('serial'); await pending;
  for (const task of f.tasks) { assert.equal(task.attempts, 0); assert.equal(task.monitor.samples.length, 0); }
  assert.equal(f.calls.active, 0); await f.engine.tick();
  assert.equal(f.calls.total, 2); assert.equal(f.calls.probes, 1);
});

test('停止等待独立读取全部退出，忙碌标记释放前不遗留请求或付费动作', async t => {
  const f = setup(t), { pending } = await f.start();
  await f.engine.stop(); await pending;
  assert.equal(f.calls.active, 0); assert.equal(f.engine.precheckBatch, null); assert.equal(f.engine.busy, false);
  assert.equal(f.submissions, 0); assert.ok(f.tasks.every(task => task.attempts === 0 && !task.monitor.samples.length));
});

test('页面请求等待时完成一个结果后交接，取消另一预检且不增加统计', async t => {
  const f = setup(t), [a, b] = f.tasks, { pending } = await f.start();
  f.engine.browserWaiters = 1; f.resolve(a, f.empty(a)); await pending;
  assert.equal(a.attempts, 1); assert.equal(b.attempts, 0); assert.equal(f.calls.active, 0);
  await f.engine.tick(); assert.equal(f.calls.total, 2);
  f.engine.browserWaiters = 0;
});

test('单任务、不同账号以及已提交任务均不进入预检批次', async t => {
  const single = setup(t, { count: 1 }); await single.engine.tick(); assert.equal(single.calls.total, 0);
  const mixed = setup(t); mixed.store.patch(mixed.tasks[1], { ownerId: 'synthetic-other-owner' });
  await mixed.engine.tick(); assert.equal(mixed.calls.total, 0);
  const submitted = setup(t); submitted.engine.setSchedulingMode('serial'); await submitted.engine.tick();
  submitted.engine.setSchedulingMode('parallel'); submitted.advance(25000);
  // 更早到期的另一个任务仍优先；批次不能跳过已经提交、等待核对的任务。
  await submitted.engine.tick(); assert.equal(submitted.calls.total, 0);
});

for (const wrong of ['ownerId', 'taskId']) test(`不同 ${wrong} 的预检结果不能提交或被当作本任务无卡`, async t => {
  const f = setup(t), [a, b] = f.tasks, { pending } = await f.start();
  f.resolve(a, { ...f.empty(a), [wrong]: 'synthetic-wrong' }); f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.state, 'attention'); assert.equal(a.monitor.samples[0].status, 'error');
  assert.equal(f.calls.probes, 0); assert.equal(f.submissions, 0);
});

test('同一批次迟到的旧账号结果在任务归属变更后丢弃', async t => {
  const f = setup(t), [a, b] = f.tasks, original = f.empty(a), { pending } = await f.start();
  f.store.patch(a, { ownerId: 'synthetic-new-owner' }); f.resolve(a, original); f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.attempts, 0); assert.equal(a.monitor.samples.length, 0); assert.equal(f.submissions, 0);
});

test('三个到期任务轮流推进，长耗时批次不会让已处理任务饿死尚未检查的任务', async t => {
  const f = setup(t, { count: 3 }), [a, b, c] = f.tasks, { pending } = await f.start();
  f.advance(30000); f.resolve(b, f.empty(b));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.reads.has(c.id), 'B 完成后 C 补位，不等待 A 慢读');
  f.resolve(c, f.empty(c)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.attempts, 1); assert.equal(a.attempts, 0);
  f.resolve(a, f.empty(a)); await pending;
  assert.equal(f.calls.peak, 2); assert.equal(a.attempts, 1); assert.equal(b.attempts, 1);
});

test('错峰任务不提前读取，在第一路慢读期间到期后立即使用第二路', async t => {
  const f = setup(t), [a, b] = f.tasks;
  f.store.patch(b, { nextCheckAt: f.clock() + 200 });
  // 独立推进调度时钟及定时器，验证真实的 200ms 唤醒，而不是手动调用第二次 tick。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.engine.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.total, 1); assert.ok(f.reads.has(a.id));
  f.advance(199); t.mock.timers.tick(199); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.total, 1);
  f.advance(1); t.mock.timers.tick(1); await f.entered.promise;
  assert.equal(f.calls.peak, 2); f.resolve(b, f.empty(b));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(b.attempts, 1); assert.equal(a.attempts, 0);
  f.resolve(a, f.empty(a)); await pending;
});

for (const action of ['stop', 'serial']) test(`第二任务远未来到期时 ${action} 立即结束等待且不提前查询`, async t => {
  const f = setup(t), [a, b] = f.tasks;
  f.store.patch(b, { nextCheckAt: f.clock() + 3600000 });
  const pending = f.engine.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.total, 1); assert.ok(f.reads.has(a.id));
  if (action === 'stop') await f.engine.stop(); else f.engine.setSchedulingMode('serial');
  await pending; assert.equal(f.calls.active, 0); assert.equal(b.attempts, 0); assert.equal(f.engine.busy, false);
});

test('第一任务已完成时不空等未来任务，尽快交出页面锁', async t => {
  const f = setup(t), [a, b] = f.tasks;
  f.store.patch(b, { nextCheckAt: f.clock() + 3600000 });
  const pending = f.engine.tick(); await new Promise(resolve => setImmediate(resolve));
  f.resolve(a, f.empty(a)); await pending;
  assert.equal(f.calls.total, 1); assert.equal(f.engine.busy, false); assert.equal(b.attempts, 0);
});

test('账号检查等待后负快照过期，使用位置重新读取且限制目录为单路', async t => {
  const f = setup(t, { config: { action: 'observe' } }), [a, b] = f.tasks;
  const results = new Map([[a.id, f.empty(a)], [b.id, f.empty(b)]]), probe = f.adapter.probe.bind(f.adapter);
  f.engine.verifyOwner = async task => { if (task === a) f.advance(6000); };
  f.adapter.probe = async (task, options) => { assert.equal(options.catalogConcurrency, 1); return probe(task, options); };
  const { pending } = await f.start(); f.resolve(a, results.get(a.id)); f.resolve(b, results.get(b.id)); await pending;
  assert.equal(f.calls.probes, 2); assert.equal(a.state, 'found'); assert.equal(b.state, 'found');
  assert.notEqual(a.monitor.samples[0].available, 0); assert.equal(a.lastScan.at, f.clock());
});

test('复用新鲜负快照保留真正读取时间，不把消费时刻当作库存时间', async t => {
  const f = setup(t), [a, b] = f.tasks, result = f.empty(a), { pending } = await f.start();
  f.advance(2000); f.resolve(a, result); f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.monitor.samples[0].at, result.checkedAt); assert.equal(a.lastScan.at, result.checkedAt);
  assert.equal(f.calls.probes, 0);
});

test('缺少读取时间的负快照不能省略原库存检查', async t => {
  const f = setup(t, { config: { action: 'observe' } }), [a, b] = f.tasks, { pending } = await f.start();
  f.resolve(a, { ...f.empty(a), checkedAt: undefined }); f.resolve(b, f.empty(b)); await pending;
  assert.equal(f.calls.probes, 1); assert.equal(a.state, 'found'); assert.equal(b.state, 'watching');
});

test('切换策略时已进入原提交路径正常收尾，未消费的另一预检被终止', async t => {
  const f = setup(t), [a, b] = f.tasks, entered = gate(), release = gate(), prepare = f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  const { pending } = await f.start(); f.resolve(b, f.candidate(b)); await entered.promise;
  f.engine.setSchedulingMode('serial'); release.resolve(); await pending;
  assert.equal(f.submissions, 1); assert.ok(b.operation.receipt.instanceId); assert.equal(a.attempts, 0);
  assert.equal(f.calls.active, 0); assert.equal(f.engine.schedulingState().mode, 'serial');
});

test('在途预检期间回执核对到期优先使用共享工作页，保留独立读页进度', async t => {
  const f = setup(t, { count: 3 }), [a, b, submitted] = f.tasks;
  f.store.patch(submitted, { state: 'verifying', operation: { stage: 'accepted', at: f.clock(),
    receipt: { instanceId: 'synthetic-existing', acceptedAt: f.clock() } }, nextCheckAt: f.clock() + 200 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reconciled = false; const reconcile = f.adapter.reconcile.bind(f.adapter);
  f.adapter.reconcile = async task => { assert.equal(task, submitted); reconciled = true; return reconcile(task); };
  const { pending } = await f.start();
  f.advance(200); t.mock.timers.tick(200); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconciled, true); assert.equal(f.calls.active, 2); assert.equal(a.attempts, 0); assert.equal(b.attempts, 0);
  f.resolve(a, f.empty(a)); f.resolve(b, f.empty(b)); await pending;
  assert.equal(f.calls.total, 2); assert.equal(f.calls.active, 0);
});

test('组合预检仅确认原机无卡时仍检查同区克隆，不把它误当作整项任务无卡', async t => {
  const f = setup(t, { config: { mode: 'clone', raceBoot: true, pricePolicy: 'official', balanceGuard: false,
    maxGpuHourly: null, maxTotalHourly: null, maxStorageDaily: null, action: 'observe' } });
  const [a, b] = f.tasks, { pending } = await f.start();
  f.adapter.inspectBoot = async () => assert.fail('新鲜原机预检不必重复读取');
  for (const task of [a, b]) f.resolve(task, { ...f.empty(task), kind: 'boot', observation: undefined,
    instance: { id: task.config.sourceId, region: task.config.regions[0], gpuModel: task.config.gpuModel,
      gpuCount: task.config.gpuCount, stopped: true, running: false, starting: false, gpuAvailable: false } });
  await pending;
  assert.equal(f.calls.probes, 2); assert.equal(a.raceWinner, 'clone'); assert.equal(b.raceWinner, 'clone');
  assert.equal(a.state, 'found'); assert.equal(b.state, 'found'); assert.equal(f.submissions, 0);
});

test('身份核验暂时失败按退避重试，截止时间到达后停止新提交', async t => {
  const f = fixture(t), start = f.clock();
  f.engine.verifyOwner = async () => { throw new AppError('ACCOUNT_NETWORK', '合成身份接口 429', { retryable: true }); };
  f.store.patch(f.task, { deadlineAt: start + 25000 });
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.errors, 1); assert.equal(f.submissions, 0);
  assert.equal(f.task.nextCheckAt, Math.min(start + 25000, start + f.task.config.pollSeconds * 2000));
  f.advance(25000); await f.engine.tick();
  assert.equal(f.task.state, 'expired'); assert.equal(f.submissions, 0);
});

test('已点击任务身份核验短暂失败保留回执，到核对期限后转处理且不再提交', async t => {
  const f = fixture(t); await f.engine.tick();
  const operation = f.task.operation;
  f.engine.verifyOwner = async () => { throw new AppError('ACCOUNT_NETWORK', '合成身份网络中断', { retryable: true }); };
  await f.due(25 * 60000);
  assert.equal(f.task.state, 'verifying'); assert.equal(f.task.operation, operation); assert.equal(f.submissions, 1);
  await f.due(5 * 60000);
  assert.equal(f.task.state, 'attention'); assert.equal(f.task.operation, operation); assert.equal(f.submissions, 1);
});

test('身份读取恢复后才能继续原提交路径，真实登录失效仍暂停', async t => {
  const f = fixture(t); let transient = true;
  f.engine.verifyOwner = async () => { if (transient) throw new AppError('ACCOUNT_NETWORK', '合成暂时断网', { retryable: true }); };
  await f.engine.tick(); assert.equal(f.submissions, 0);
  transient = false; await f.due(60000); assert.equal(f.submissions, 1);
  f.engine.verifyOwner = async () => { throw new AppError('LOGIN_CHECK_REQUIRED', '合成登录失效'); };
  await f.due(); assert.equal(f.task.state, 'paused'); assert.equal(f.submissions, 1);
});

test('并行候选进入原读取后暂停再恢复，不记录旧轮次的采样或执行点击', async t => {
  const f = setup(t), [a, b] = f.tasks, entered = gate(), release = gate(), probe = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async (...args) => { entered.resolve(); await release.promise; return probe(...args); };
  const { pending } = await f.start(); f.resolve(a, f.candidate(a)); await entered.promise;
  f.engine.control(a, 'pause'); f.engine.control(a, 'resume'); release.resolve(); f.resolve(b, f.empty(b)); await pending;
  assert.equal(a.monitor.samples.length, 0); assert.equal(a.monitor.checking, false); assert.equal(a.operation, null);
  assert.equal(a.state, 'watching'); assert.equal(f.submissions, 0);
});

test('消费结果时磁盘持续故障会排空独立读取并释放锁，失败轮次仍节流', async t => {
  const f = setup(t), [a] = f.tasks, { pending } = await f.start();
  t.mock.method(f.store, 'save', () => { throw new Error('合成磁盘持续故障'); });
  f.resolve(a, f.empty(a)); await assert.rejects(pending, /合成磁盘持续故障/);
  assert.equal(f.calls.active, 0); assert.equal(f.engine.busy, false); assert.equal(f.engine.precheckBatch, null);
  assert.equal(f.submissions, 0); assert.equal(f.engine.failedTickUntil, f.clock() + 500);
  await f.engine.tick(); assert.equal(f.calls.total, 2);
});

test('并行候选不绕过逐任务最终余额检查，余额不足的任务没有付费点击', async t => {
  const f = setup(t, { config: { balanceGuard: true } }), [a, b] = f.tasks, checked = [];
  f.engine.wallet = { check: async config => { checked.push(config.name); throw new AppError('BALANCE_INSUFFICIENT', '合成余额不足'); },
    confirm: () => assert.fail('余额不足不能到达确认') };
  const { pending } = await f.start(); f.resolve(a, f.candidate(a)); f.resolve(b, f.candidate(b)); await pending;
  assert.equal(checked.length, 2); assert.equal(f.submissions, 0);
  for (const task of [a, b]) { assert.equal(task.operation, null); assert.equal(task.state, 'watching'); assert.ok(task.balanceLow); }
});

test('每秒核对回执不会反复重启数秒的慢预检，慢任务最终仍取得结果', async t => {
  const f = setup(t, { count: 3 }), [a, b, submitted] = f.tasks;
  f.store.patch(submitted, { config: { ...submitted.config, pollSeconds: 1 }, state: 'verifying',
    operation: { stage: 'accepted', at: f.clock(), receipt: { instanceId: 'synthetic-existing', acceptedAt: f.clock() } },
    nextCheckAt: f.clock() + 1000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0; const reconcile = f.adapter.reconcile.bind(f.adapter);
  f.adapter.reconcile = async task => { checks++; return reconcile(task); };
  const { pending } = await f.start(); f.resolve(b, f.empty(b));
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    f.advance(1000); t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reads.get(a.id).signal.aborted, false); assert.equal(f.calls.total, 2);
  }
  assert.equal(checks, 3); f.resolve(a, f.empty(a)); await pending;
  assert.equal(a.attempts, 1); assert.equal(a.monitor.samples.length, 1); assert.equal(f.submissions, 0);
});
