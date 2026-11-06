import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { fixture } from './helpers.mjs';

// 全部使用合成实例及隔离 Store，不启动浏览器、不访问 AutoDL 或发送通知。
function unresolved(f, state = 'paused') {
  const operation = { id: 'synthetic-unresolved-operation', stage: 'click_started',
    at: f.clock() - 180000, clickedAt: f.clock() - 180000,
    baselineIds: ['synthetic-existing'], quote: { host: { number: '合成922机' } } };
  f.store.patch(f.task, { state, operation });
  return operation;
}

test('人工核对失败或仍有新增实例时保留原提交，不写入未创建证据', async t => {
  const f = fixture(t), operation = unresolved(f);
  f.adapter.recheckSubmission = async () => { throw new AppError('INSTANCE_SCAN', '合成读取失败'); };
  await assert.rejects(f.engine.recheck(f.task), /合成读取失败/);
  assert.equal(f.task.operation, operation);
  f.adapter.recheckSubmission = async () => ({ extra: [{ id: 'synthetic-new' }] });
  assert.equal((await f.engine.recheck(f.task)).cleared, false);
  assert.equal(f.task.operation, operation);
  assert.equal(f.task.submitRejections?.length || 0, 0);
});

test('人工确认未创建后恢复，迟到实例仍触发延迟创建保护而不会再次租用', async t => {
  const f = fixture(t), operation = unresolved(f);
  assert.equal((await f.engine.recheck(f.task)).cleared, true);
  f.engine.control(f.task, 'resume');
  const browser = new AutoDLBrowserAdapter('unused-isolated-review-profile');
  const prepare = f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare = async (task, ...args) => {
    browser.lateCreation(task, [{ id: 'synthetic-late', region: task.config.regions[0],
      gpuModel: task.config.gpuModel, gpuCount: task.config.gpuCount }]);
    return prepare(task, ...args);
  };
  await f.engine.tick();
  assert.equal(f.submissions, 0);
  assert.equal(f.task.state, 'attention');
  assert.match(f.task.lastError, /可能是延迟创建/);
  assert.deepEqual(f.task.submitRejections.at(-1).baselineIds, operation.baselineIds);
  assert.equal(f.task.submitRejections.at(-1).operationId, operation.id);
});

test('人工绑定也拒绝其他任务已经绑定的同一实例', async t => {
  const f = fixture(t); unresolved(f);
  const adapter = new AutoDLBrowserAdapter('unused-isolated-review-profile');
  adapter.claimedIds = () => new Set(['synthetic-claimed']);
  adapter.instances = async () => [{ id: 'synthetic-claimed', region: f.task.config.regions[0],
    gpuModel: f.task.config.gpuModel, gpuCount: f.task.config.gpuCount }];
  await assert.rejects(adapter.attach(f.task, 'synthetic-claimed'), error => error.code === 'INSTANCE' && /其他任务/.test(error.message));
});

test('旧提交人工绑定成功后重新等待运行确认，不立即按旧点击时间超时', async t => {
  const f = fixture(t); unresolved(f);
  f.advance(35 * 60000);
  await f.engine.attach(f.task, 'synthetic-manual');
  await f.engine.tick();
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.task.verifySince, f.clock());
  assert.equal(f.submissions, 0);
});

test('人工清除未绑定的旧受理记录后，新提交不沿用旧核对计时', async t => {
  const f = fixture(t), operation = unresolved(f);
  f.store.patch(f.task, { verifySince: f.clock() - 35 * 60000,
    operation: { ...operation, stage: 'accepted', receipt: { acceptedAt: operation.clickedAt, instanceId: null } } });
  await f.engine.recheck(f.task);
  f.engine.control(f.task, 'resume');
  await f.engine.tick();
  await f.due();
  assert.equal(f.submissions, 1);
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.task.lastError, null);
});

test('已取消任务经人工核对清除提交后仍停止，并保留前后两次延迟创建证据', async t => {
  const f = fixture(t), operation = unresolved(f, 'cancelled');
  const previous = { at: f.clock() - 1000, operationId: 'synthetic-previous', baselineIds: ['synthetic-older'] };
  f.store.patch(f.task, { submitRejections: [previous] });
  await f.engine.recheck(f.task);
  assert.equal(f.task.state, 'cancelled');
  assert.equal(f.task.operation, null);
  assert.deepEqual(f.task.submitRejections.map(item => item.operationId), [previous.operationId, operation.id]);
  assert.deepEqual(f.task.submitRejections.at(-1).baselineIds, operation.baselineIds);
  await f.due();
  assert.equal(f.submissions, 0);
});
