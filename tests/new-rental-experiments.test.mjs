import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXPERIMENT_SLOTS } from '../src/config.mjs';
import { sameTaskResource, blocksTask } from '../src/task-conflicts.mjs';
import { testConfig } from './fixtures/config.mjs';
import { fixture } from './helpers.mjs';

test('新租实验编号独立于单机 GPU 数量，每个实验各自验证费用授权', () => {
  assert.equal(MAX_EXPERIMENT_SLOTS, 3);
  assert.equal(testConfig({gpuCount:3}).experimentSlot, 1);
  const third = testConfig({experimentSlot:'3', gpuCount:1});
  assert.equal(third.experimentSlot, 3);
  assert.equal(third.gpuCount, 1);
  assert.match(third.name, /实验 3/);
  assert.equal(testConfig({experimentSlot:3, name:'细胞分割'}).name, '细胞分割');
  for (const slot of [1,2,3]) {
    assert.throws(() => testConfig({action:'execute', experimentSlot:slot}), {code:'CONSENT'});
    assert.equal(testConfig({action:'execute', paidConsent:true, experimentSlot:slot}).paidConsent, true);
  }
  for (const invalid of [0,4,1.5,true,[2]]) assert.throws(() => testConfig({experimentSlot:invalid}), {code:'CONFIG'});
  for (const mode of ['boot','clone']) {
    assert.throws(() => testConfig({mode, experimentSlot:2}), {code:'CONFIG'});
    assert.equal('experimentSlot' in testConfig({mode, experimentSlot:1}), false);
  }
});

test('旧新租任务占用实验 1，修改名称、地区或每台卡数不能冒充新的实验', () => {
  const config = testConfig({});
  delete config.experimentSlot;
  const old = {config, state:'paused', operation:null};
  assert.equal(blocksTask(old, testConfig({experimentSlot:1, gpuModel:'rtx4090', gpuCount:3, regions:['西北B区'], name:'其他名称'})), true);
  assert.equal(sameTaskResource(old, testConfig({experimentSlot:2})), false);
  assert.equal(sameTaskResource({config:testConfig({experimentSlot:3})}, testConfig({experimentSlot:3})), true);
  assert.equal(sameTaskResource({config:testConfig({experimentSlot:3})}, testConfig({experimentSlot:2})), false);
});

test('重建暂停的任务只可使用原实验编号', t => {
  const f = fixture(t, {experimentSlot:2});
  f.engine.control(f.task, 'pause');
  assert.throws(() => f.store.create(testConfig({experimentSlot:3}), {replaces:f.task}), {code:'TASK_CHANGED'});
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.task.state, 'paused');
  const replacement = f.store.create(testConfig({experimentSlot:2}), {replaces:f.task});
  assert.equal(replacement.replacesTaskId, f.task.id);
  assert.equal(f.task.state, 'cancelled');
});

test('同规格实验不能越过旧任务待核对的提交；绑定迟到回执后各自取得独立实例', async t => {
  const f = fixture(t), old = f.task, ownerId = 'synthetic-owner';
  delete old.config.experimentSlot;
  f.store.patch(old, {ownerId, state:'cancelled', operation:{id:'synthetic-op', stage:'click_started', at:f.clock(), baselineIds:[]}});
  const others = [2,3].map(experimentSlot => f.store.create(testConfig({experimentSlot, action:'execute', paidConsent:true}), {ownerId}));
  for (const task of others) {
    await f.engine.step(task);
    assert.equal(task.state, 'watching');
    assert.equal(task.operation, null);
    assert.equal(f.engine.pendingOverlap(task)?.id, old.id);
  }
  assert.equal(old.operation.stage, 'click_started'); assert.equal(f.submissions, 0);

  // 通过既有人工绑定入口模拟平台迟到的唯一回执，释放跨实验的待核对保护。
  await f.engine.attach(old, 'synthetic-late');
  for (const task of others) {
    assert.equal(f.engine.pendingOverlap(task), null);
    assert.ok(f.adapter.claimedIds(task).has('synthetic-late'));
    await f.engine.step(task);
    assert.equal(task.state, 'verifying');
  }
  assert.equal(f.submissions, 2);
  assert.equal(new Set([old,...others].map(task => task.operation.receipt.instanceId)).size, 3);
  assert.equal(f.store.data.notifications.filter(note => note.event === 'submitted').length, 2);
});

test('第三个新租实验的仅提醒模式找到卡即结束，不付费', async t => {
  const f = fixture(t, {experimentSlot:3, action:'observe'});
  await f.engine.tick();
  assert.equal(f.task.state, 'found'); assert.equal(f.submissions, 0); assert.equal(f.task.operation, null);
});
