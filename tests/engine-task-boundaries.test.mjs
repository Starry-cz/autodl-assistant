import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { fixture, gate } from './helpers.mjs';

test('克隆受理但尚未绑定实例时，不能人工确认数据盘', async t => {
  const f = fixture(t, { mode: 'clone' });
  f.adapter.submit = async (_task, _quote, mark) => {
    mark();
    return { acceptedAt: f.clock(), instanceId: null };
  };
  await f.engine.tick();
  assert.equal(f.task.state, 'verifying');
  assert.throws(() => f.engine.control(f.task, 'verify-data', { confirmed: true }), /绑定目标实例/);
});

test('新租已受理但实例 ID 晚到，重启只读核对后可以接回原实例', async t => {
  const f = fixture(t);
  f.adapter.submit = async (_task, _quote, mark) => {
    mark();
    return { acceptedAt: f.clock(), instanceId: null, evidence: 'accepted-navigation-only' };
  };
  await f.engine.tick();
  const host = f.task.operation.quote.host;
  const adapter = new AutoDLBrowserAdapter('unused-synthetic-profile');
  let reads = 0;
  adapter.instances = async () => {
    reads++;
    return [{ id: 'synthetic-after-restart', hostNumber: host.number, region: host.region,
      gpuModel: host.gpuModel, gpuCount: 1, running: true }];
  };
  const recovered = new Engine(f.store, { autodl: adapter }, f.notifier, { clock: f.clock });
  t.after(() => recovered.stop());
  await recovered.tick();
  assert.equal(reads, 1);
  assert.equal(f.task.operation.receipt.instanceId, 'synthetic-after-restart');
  assert.equal(f.task.state, 'completed');
});

test('换绑另一台实例后，原目标的数据盘人工核验不能使新目标提前完成', async t => {
  const f = fixture(t, { mode: 'clone' });
  await f.engine.tick();
  f.engine.control(f.task, 'verify-data', { confirmed: true });
  f.engine.control(f.task, 'pause');
  await f.engine.attach(f.task, 'synthetic-replacement');
  f.adapter.reconcile = async () => ({ instance: { id: 'synthetic-replacement', running: true, gpuVerified: true } });
  await f.engine.tick();
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.store.data.notifications.some(n => n.event === 'completed'), false);
  // 另一窗口仍显示换绑前的目标，其勾选也不能转给新目标。
  assert.throws(() => f.engine.control(f.task, 'verify-data', { confirmed: true, instanceId: 'synthetic-old' }),
    error => error.code === 'TASK_CHANGED');
  f.engine.control(f.task, 'verify-data', { confirmed: true, instanceId: 'synthetic-replacement' });
  await f.engine.tick();
  assert.equal(f.task.state, 'completed');
});

test('仅提醒模式的报价跨过等待截止时间，不能把任务标记为找到资源', async t => {
  const f = fixture(t, { action: 'observe', timeoutMinutes: 1 });
  const prepare = f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare = async (...args) => { f.advance(60001); return prepare(...args); };
  await f.engine.tick();
  assert.equal(f.task.state, 'expired');
  assert.equal(f.store.data.notifications.some(n => n.event === 'found'), false);
});

test('原机仅提醒模式的库存读取跨过截止时间，不报告发现资源', async t => {
  const f = fixture(t, { mode: 'boot', action: 'observe', timeoutMinutes: 1 });
  f.adapter.inspectBoot = async () => {
    f.advance(60001);
    return { id: f.task.config.sourceId, gpuModel: f.task.config.gpuModel, region: f.task.config.regions[0],
      gpuCount: 1, stopped: true, gpuAvailable: true };
  };
  await f.engine.tick();
  assert.equal(f.task.state, 'expired');
  assert.equal(f.store.data.notifications.some(n => n.event === 'found'), false);
});

test('无库存时在最长等待时间唤醒，已提交时允许跨过同一时限核对回执', async t => {
  const waiting = fixture(t, { availableAfter: 100, timeoutMinutes: 1 });
  waiting.advance(55000);
  await waiting.engine.tick();
  assert.equal(waiting.task.nextCheckAt, waiting.task.deadlineAt);
  await waiting.due(5000);
  assert.equal(waiting.task.state, 'expired');
  const accepted = fixture(t, { timeoutMinutes: 1 });
  await accepted.engine.tick();
  await accepted.due(61000);
  assert.equal(accepted.task.state, 'completed');
  assert.equal(accepted.submissions, 1);
});

test('停止监控后才返回的余额预检不能发出新的余额提醒', async t => {
  const f = fixture(t, { balanceGuard: true, availableAfter: 100 });
  const entered = gate(), release = gate();
  f.engine.wallet = { recentBalance: async () => {
    entered.resolve(); await release.promise;
    return { balance: 0, vouchers: 0, checkedAt: f.clock() };
  } };
  const checking = f.engine.tick();
  await entered.promise;
  f.engine.control(f.task, 'cancel');
  release.resolve();
  await checking;
  assert.equal(f.task.state, 'cancelled');
  assert.equal(f.store.data.notifications.some(n => n.event === 'balance-low'), false);
  assert.ok(!f.task.balanceLow);
});
