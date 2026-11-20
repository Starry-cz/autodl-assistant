import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, gate } from './helpers.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { AppError } from '../src/errors.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

// 所有库存、实例和回执都是合成数据；只使用临时状态目录，不连接真实 AutoDL 或发送通知。
const original = (extra = {}) => ({ id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
  stopped: true, running: false, starting: false, cardless: false, failed: false, gpuAvailable: false, ...extra });

function raceFixture(t, input = {}) {
  const f = fixture(t, { mode: 'clone', raceBoot: true, pricePolicy: 'official', balanceGuard: false,
    maxGpuHourly: null, maxTotalHourly: null, maxStorageDaily: null, ...input });
  const calls = { inspections: 0, probes: 0, prepares: 0, bootClicks: 0, cloneClicks: 0 };
  f.adapter.current = original();
  f.adapter.inspectBoot = async () => { calls.inspections++; return { ...f.adapter.current }; };
  f.adapter.boot = async (_task, mark) => { mark(); calls.bootClicks++; return {}; };
  const probe = f.adapter.probe.bind(f.adapter), prepare = f.adapter.prepare.bind(f.adapter), submit = f.adapter.submit.bind(f.adapter);
  f.adapter.probe = async (...args) => { calls.probes++; return probe(...args); };
  f.adapter.prepare = async (...args) => { calls.prepares++; return prepare(...args); };
  f.adapter.submit = async (task, quote, mark, ...rest) => submit(task, quote, () => { mark(); calls.cloneClicks++; }, ...rest);
  return { ...f, calls };
}

// 重新从磁盘加载，验证分支凭据不是仅存在于当前进程里的临时变量。
function restart(t, f) {
  const store = new Store(f.dir, { clock: f.clock });
  const engine = new Engine(store, { autodl: f.adapter }, f.notifier, { clock: f.clock, random: () => 0 });
  t.after(() => engine.stop());
  return { store, engine, task: store.get(f.task.id) };
}

test('两边都有卡时只开原机，一轮只读取一次原机，持久化 boot 执行权', async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: true });
  await f.engine.tick();
  assert.equal(f.calls.inspections, 1); assert.equal(f.task.attempts, 1);
  assert.equal(f.calls.bootClicks, 1); assert.equal(f.calls.cloneClicks, 0);
  assert.equal(f.calls.probes, 0); assert.equal(f.calls.prepares, 0);
  assert.equal(f.task.raceWinner, 'boot'); assert.equal(f.task.operation.kind, 'boot');
  assert.equal(f.task.operation.receipt.instanceId, 'synthetic-source');
  f.adapter.current = original({ stopped: false, running: true }); await f.due();
  assert.equal(f.task.state, 'completed'); assert.equal(f.calls.bootClicks, 1); assert.equal(f.calls.cloneClicks, 0);
});

for (const gpuAvailable of [false, null]) test(`原机库存为 ${gpuAvailable} 时顺序查克隆，获胜后不再检查或点击原机`, async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable });
  const read = f.adapter.inspectBoot;
  let inspecting = false;
  f.adapter.inspectBoot = async () => { inspecting = true; await Promise.resolve(); const result = await read(); inspecting = false; return result; };
  const probe = f.adapter.probe;
  f.adapter.probe = async (...args) => { assert.equal(inspecting, false); return probe(...args); };
  await f.engine.tick();
  assert.equal(f.task.raceWinner, 'clone'); assert.equal(f.task.operation.kind, 'clone');
  assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1); assert.equal(f.task.attempts, 1);
  f.adapter.current = original({ gpuAvailable: true }); await f.due(70000);
  assert.equal(f.task.state, 'completed'); assert.equal(f.calls.inspections, 1);
  assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1);
});

test('两边都无卡时保留同一组合任务继续观察，没有执行权或付费点击', async t => {
  const f = raceFixture(t, { availableAfter: 100 });
  await f.engine.tick(); await f.due();
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.operation, null);
  assert.equal(f.task.raceWinner ?? null, null);
  assert.equal(f.calls.inspections, 2); assert.equal(f.calls.probes, 2);
  assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
});

for (const winner of ['boot', 'clone']) test(`仅提醒命中 ${winner} 后停止，恢复可重新观察且不保留旧选择`, async t => {
  const f = raceFixture(t, { action: 'observe' }); f.adapter.current = original({ gpuAvailable: winner === 'boot' });
  await f.engine.tick();
  assert.equal(f.task.state, 'found'); assert.equal(f.task.raceWinner, winner);
  assert.equal(f.task.operation, null); assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
  f.engine.control(f.task, 'resume'); assert.equal(f.task.raceWinner, null);
  assert.equal(f.task.result, null); assert.equal(f.task.lastProgress, null);
  f.adapter.current = original({ gpuAvailable: winner !== 'boot' }); await f.engine.tick();
  assert.equal(f.task.state, 'found'); assert.equal(f.task.raceWinner, winner === 'boot' ? 'clone' : 'boot');
});

test('原机已运行直接完成；观察外部启动时只等待，未提交且重新关机后可继续竞争', async t => {
  const running = raceFixture(t); running.adapter.current = original({ stopped: false, running: true });
  await running.engine.tick(); assert.equal(running.task.state, 'completed'); assert.equal(running.task.raceWinner, 'boot');
  assert.equal(running.calls.bootClicks + running.calls.cloneClicks, 0);
  const starting = raceFixture(t); starting.adapter.current = original({ stopped: false, starting: true });
  await starting.engine.tick(); assert.equal(starting.task.raceWinner, 'boot');
  await starting.due(); assert.equal(starting.calls.probes, 0); assert.equal(starting.calls.bootClicks + starting.calls.cloneClicks, 0);
  starting.adapter.current = original({ gpuAvailable: null }); await starting.due();
  assert.equal(starting.calls.probes, 1); assert.equal(starting.calls.bootClicks, 0); assert.equal(starting.calls.cloneClicks, 1);
  assert.equal(starting.task.raceWinner, 'clone');
  assert.equal(starting.task.result, null); assert.equal(starting.task.lastProgress, null);
});

for (const outcome of ['noStock', 'notSubmitted']) test(`原机明确 ${outcome} 后给克隆检查机会，不被陈旧有卡标记饿死`, async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: true });
  f.adapter.boot = async (_task, mark) => {
    if (outcome === 'noStock') { mark(); f.calls.bootClicks++; }
    return { [outcome]: true, message: '合成原机库存已变化' };
  };
  await f.engine.tick();
  assert.equal(f.task.operation, null); assert.equal(f.task.raceWinner, null); assert.equal(f.task.raceBootDeferred, true);
  assert.equal(f.task.result, null); assert.equal(f.task.lastProgress, null);
  await f.due();
  assert.equal(f.calls.inspections, 2); assert.equal(f.calls.cloneClicks, 1); assert.equal(f.task.raceWinner, 'clone');
  assert.equal(f.calls.bootClicks, outcome === 'noStock' ? 1 : 0);
  assert.equal(f.task.raceBootDeferred, false);
});

test('原机明确缺卡后若已在启动，下轮仍核对原机而不是执行获得机会的克隆', async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: true });
  f.adapter.boot = async (_task, mark) => { mark(); f.calls.bootClicks++; return { noStock: true }; };
  await f.engine.tick(); f.adapter.current = original({ stopped: false, starting: true }); await f.due();
  assert.equal(f.task.raceWinner, 'boot'); assert.equal(f.calls.probes, 0); assert.equal(f.calls.cloneClicks, 0);
});

test('原机明确账号拒绝转处理，不自动换成克隆', async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: true });
  f.adapter.boot = async (_task, mark) => { mark(); f.calls.bootClicks++; return { rejected: true, message: '合成余额不足' }; };
  await f.engine.tick(); await f.due();
  assert.equal(f.task.state, 'attention'); assert.equal(f.calls.bootClicks, 1); assert.equal(f.calls.probes, 0);
  assert.equal(f.task.raceBootDeferred, false);
});

test('克隆明确拒绝且确认未创建后可重新竞争，下一轮原机获胜', async t => {
  const f = raceFixture(t);
  f.adapter.submit = async (_task, _quote, mark) => { mark(); f.calls.cloneClicks++;
    throw new AppError('SUBMIT_REJECTED', '合成平台明确拒绝且两次核对未创建', { notCreated: true, race: true }); };
  await f.engine.tick();
  assert.equal(f.task.operation, null); assert.equal(f.task.raceWinner, null); assert.equal(f.task.state, 'watching');
  assert.equal(f.task.submitRejections.length, 1);
  f.adapter.current = original({ gpuAvailable: true }); await f.due();
  assert.equal(f.task.operation.kind, 'boot'); assert.equal(f.calls.bootClicks, 1); assert.equal(f.calls.cloneClicks, 1);
});

test('克隆确认前失败不锁死选择，下一轮可开原机', async t => {
  const f = raceFixture(t);
  f.adapter.submit = async () => { throw new AppError('RESOURCE_GONE', '合成候选在点击前消失', { race: true }); };
  await f.engine.tick();
  assert.equal(f.task.operation, null); assert.equal(f.task.raceWinner, null);
  f.adapter.current = original({ gpuAvailable: true }); await f.due();
  assert.equal(f.calls.bootClicks, 1); assert.equal(f.calls.cloneClicks, 0);
});

for (const kind of ['boot', 'clone']) test(`${kind} 已点击后结果不明，真实重载状态文件只核对该分支`, async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: kind === 'boot' });
  if (kind === 'boot') f.adapter.boot = async (_task, mark) => { mark(); f.calls.bootClicks++; throw new Error('合成响应丢失'); };
  else f.adapter.submit = async (_task, _quote, mark) => { mark(); f.calls.cloneClicks++; throw new Error('合成响应丢失'); };
  await f.engine.tick(); assert.equal(f.task.operation.kind, kind); assert.equal(f.task.operation.stage, 'click_started');
  const recovered = restart(t, f);
  f.adapter.current = original({ gpuAvailable: kind !== 'boot' }); f.advance(2 * 60000 + 1);
  if (kind === 'clone') f.adapter.reconcile = async () => ({ notCreated: true, reason: '合成两次完整列表尚无新增' });
  await recovered.engine.tick();
  assert.equal(recovered.task.operation.kind, kind); assert.equal(recovered.task.raceWinner, kind);
  assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 1);
  assert.equal(recovered.task.state, kind === 'boot' ? 'verifying' : 'reconciling');
});

test('已受理克隆重启后仍核对克隆，即使原机出现空卡也不再检查或开机', async t => {
  const f = raceFixture(t); await f.engine.tick();
  const recovered = restart(t, f); f.adapter.current = original({ gpuAvailable: true }); f.advance(70000);
  await recovered.engine.tick();
  assert.equal(recovered.task.state, 'completed'); assert.equal(recovered.task.raceWinner, 'clone');
  assert.equal(f.calls.inspections, 1); assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1);
});

for (const kind of ['boot', 'clone']) test(`${kind} 仅意图落盘后重启清除未点击选择并暂停`, async t => {
  const f = raceFixture(t);
  f.store.patch(f.task, { state: 'submitting', raceWinner: kind,
    operation: { id: 'synthetic-intent', kind, stage: 'intent', at: f.clock(), sourceId: f.task.config.sourceId } });
  const recovered = restart(t, f);
  assert.equal(recovered.task.state, 'paused'); assert.equal(recovered.task.operation, null); assert.equal(recovered.task.raceWinner, null);
  assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
});

test('模糊克隆回执的人工空列表核对保留执行权，不能借取消或恢复转为开原机', async t => {
  const f = raceFixture(t);
  f.adapter.submit = async (_task, _quote, mark) => { mark(); f.calls.cloneClicks++; throw new Error('合成未知返回'); };
  await f.engine.tick(); f.advance(2 * 60000 + 1); f.engine.control(f.task, 'cancel');
  const op = f.task.operation, result = await f.engine.recheck(f.task);
  assert.equal(result.cleared, false); assert.match(result.reason, /保留/); assert.equal(f.task.operation, op);
  assert.equal(f.task.state, 'cancelled'); assert.equal(f.task.raceWinner, 'clone');
  assert.throws(() => f.engine.control(f.task, 'resume'), /不能恢复/);
  f.adapter.current = original({ gpuAvailable: true }); await f.due();
  assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1);
});

test('模糊克隆回执可人工绑定真实目标继续核对，仍不开放原机分支', async t => {
  const f = raceFixture(t);
  f.adapter.submit = async (_task, _quote, mark) => { mark(); f.calls.cloneClicks++; throw new Error('合成未知返回'); };
  await f.engine.tick(); f.engine.control(f.task, 'pause');
  await f.engine.attach(f.task, 'synthetic-target');
  assert.equal(f.task.operation.kind, 'clone'); assert.equal(f.task.operation.receipt.instanceId, 'synthetic-target');
  f.adapter.current = original({ gpuAvailable: true }); await f.due(70000);
  assert.equal(f.task.state, 'completed'); assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1);
});

test('原机获胜后的取消恢复只核对原机，拒绝克隆人工绑定与数据盘确认', async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: true }); await f.engine.tick();
  f.engine.control(f.task, 'cancel'); f.engine.control(f.task, 'resume');
  await assert.rejects(f.engine.attach(f.task, 'synthetic-other'), /原实例开机已绑定/);
  assert.throws(() => f.engine.control(f.task, 'verify-data', { confirmed: true }), /仅可在绑定目标实例后/);
  f.adapter.current = original({ gpuAvailable: false }); await f.due();
  assert.equal(f.task.state, 'verifying'); assert.equal(f.calls.probes, 0); assert.equal(f.calls.bootClicks, 1);
});

for (const kind of ['boot', 'clone']) for (const resume of [false, true]) test(`${kind} 付费前暂停${resume ? '并立即恢复' : ''}使旧轮次失效`, async t => {
  const f = raceFixture(t), entered = gate(), release = gate();
  f.adapter.current = original({ gpuAvailable: kind === 'boot' });
  if (kind === 'boot') f.adapter.boot = async (_task, mark) => { entered.resolve(); await release.promise; mark(); f.calls.bootClicks++; return {}; };
  else f.adapter.submit = async (_task, _quote, mark) => { entered.resolve(); await release.promise; mark(); f.calls.cloneClicks++; return {}; };
  const ongoing = f.engine.tick(); await entered.promise;
  f.engine.control(f.task, 'pause'); if (resume) f.engine.control(f.task, 'resume');
  release.resolve(); await ongoing;
  assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0); assert.equal(f.task.operation, null); assert.equal(f.task.raceWinner, null);
  assert.equal(f.task.state, resume ? 'watching' : 'paused');
});

test('原机检查未返回时暂停并恢复，旧观察不能进入任一付费路径', async t => {
  const f = raceFixture(t), entered = gate(), release = gate();
  f.adapter.inspectBoot = async () => { entered.resolve(); await release.promise; return original({ gpuAvailable: true }); };
  const ongoing = f.engine.tick(); await entered.promise;
  f.engine.control(f.task, 'pause'); f.engine.control(f.task, 'resume'); release.resolve(); await ongoing;
  assert.equal(f.calls.probes, 0); assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0); assert.equal(f.task.state, 'watching');
});

test('克隆复制失败保留克隆回执，恢复后也不启动原实例', async t => {
  const f = raceFixture(t, { copyFailure: true }); await f.engine.tick(); await f.due(70000);
  assert.equal(f.task.state, 'attention'); assert.equal(f.task.operation.kind, 'clone');
  f.adapter.current = original({ gpuAvailable: true }); f.engine.control(f.task, 'resume'); await f.engine.tick();
  assert.equal(f.task.state, 'attention'); assert.equal(f.calls.bootClicks, 0); assert.equal(f.calls.cloneClicks, 1);
});

test('原机身份或规格变化时两条路径都停止，不进入克隆作为替代', async t => {
  for (const changed of [{ id: 'synthetic-other' }, { region: '重庆A区' }, { gpuModel: 'RTX 5090' }, { gpuCount: 2 }, { cardless: true }]) {
    const f = raceFixture(t); f.adapter.current = original(changed); await f.engine.tick();
    assert.equal(f.task.state, 'attention'); assert.equal(f.calls.probes, 0); assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
  }
});

test('组合适配器原机二次读取为未知库存时不打开确认弹窗', async t => {
  const f = raceFixture(t), adapter = Object.create(AutoDLBrowserAdapter.prototype);
  adapter.findInstanceRow = async () => ({ info: original({ gpuAvailable: null }), row: { getByRole: () => assert.fail('未知库存不能进入开机确认') } });
  const result = await adapter.boot(f.task, () => assert.fail('不能点击付费确认'));
  assert.equal(result.notSubmitted, true);
});

test('组合适配器转向原机前发现先前拒绝的迟到克隆，停止而不是开第二台', async t => {
  const f = raceFixture(t), adapter = Object.create(AutoDLBrowserAdapter.prototype);
  f.task.submitRejections = [{ at: Date.now(), baselineIds: ['synthetic-source'] }];
  adapter.claimedIds = () => new Set();
  adapter.instances = async () => [original({ gpuAvailable: true }), { ...original(), id: 'synthetic-late', hostNumber: '合成迟到机' }];
  adapter.findInstanceRow = async () => assert.fail('存在迟到克隆时不能继续原机');
  await assert.rejects(adapter.inspectBoot(f.task), error => error.code === 'SUBMIT_LATE');
});

for (const kind of ['boot', 'clone']) for (const stage of ['intent', 'click_started']) test(`${kind} 的 ${stage} 落盘失败时不越过付费点击，重启也不换支重提`, async t => {
  const f = raceFixture(t); f.adapter.current = original({ gpuAvailable: kind === 'boot' });
  const save = f.store.save.bind(f.store); let failed = false;
  // 在真实 Store 保存边界注入一次故障；计数位于 mark 返回之后，对应适配器实际确认按钮。
  t.mock.method(f.store, 'save', () => {
    if (!failed && f.task.operation?.stage === stage) { failed = true; throw new Error('合成磁盘写入失败'); }
    save();
  });
  await f.engine.tick();
  assert.equal(failed, true); assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
  assert.equal(stage === 'intent' ? f.task.operation : f.task.operation?.kind, stage === 'intent' ? null : kind);
  const recovered = restart(t, f);
  f.adapter.current = original({ gpuAvailable: kind !== 'boot' }); f.advance(2 * 60000 + 1);
  if (kind === 'clone') f.adapter.reconcile = async () => ({ notCreated: true, reason: '合成完整列表尚无新增' });
  await recovered.engine.tick();
  assert.equal(f.calls.bootClicks + f.calls.cloneClicks, 0);
  if (stage === 'click_started') assert.equal(recovered.task.operation.kind, kind);
  else assert.equal(recovered.task.state, 'attention');
});
