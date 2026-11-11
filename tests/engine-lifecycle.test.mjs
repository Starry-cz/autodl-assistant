import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { fixture, gate } from './helpers.mjs';

// 只使用合成账号核验和任务，精确控制人工操作与迟到响应的先后关系。
for (const mode of ['create', 'boot']) for (const action of ['pause', 'cancel', 'stop']) test(`${mode}：账号核验期间 ${action} 后，迟到的身份错误不能覆盖人工状态`, async t => {
  const f = fixture(t, { mode }), entered = gate(), release = gate();
  f.engine.verifyOwner = async () => {
    entered.resolve(); await release.promise;
    throw new AppError('LOGIN_CHECK_REQUIRED', '合成账号核验失败');
  };
  f.adapter.probe = f.adapter.inspectBoot = async () => assert.fail('取消后不能读取资源');
  const pending = f.engine.tick(); await entered.promise;
  let stopping;
  if (action === 'stop') stopping = f.engine.stop(); else f.engine.control(f.task, action);
  const expected = f.task.state;
  const logs = f.task.logs.length, next = f.task.nextCheckAt;
  release.resolve(); await pending; await stopping;
  assert.equal(f.task.state, expected);
  assert.equal(f.task.logs.length, logs, '停止或暂停后不追加与该轮核验有关的错误');
  assert.equal(f.task.nextCheckAt, next);
  assert.equal(f.task.attempts, 0); assert.equal(f.submissions, 0);
});

test('后台在准备配置时停止，迟到的准备错误不把任务改为需要处理', async t => {
  const f = fixture(t), entered = gate(), release = gate();
  f.adapter.prepare = async () => {
    entered.resolve(); await release.promise;
    throw new AppError('BROWSER_CLOSED', '合成准备页面已关闭');
  };
  const pending = f.engine.tick(); await entered.promise;
  const stopping = f.engine.stop(), state = f.task.state;
  release.resolve(); await pending; await stopping;
  assert.equal(f.task.state, state, '没有付费点击，保留活动任务供正常重启恢复');
  assert.equal(f.task.lastError, null);
  assert.equal(f.task.operation, null); assert.equal(f.submissions, 0);
  assert.equal(f.store.data.notifications.length, 0);
  const reopened = new Store(f.dir, { clock: f.clock });
  const restarted = new Engine(reopened, { autodl: f.adapter }, f.notifier, { clock: f.clock });
  assert.equal(reopened.get(f.task.id).state, 'watching', '重新读取持久化数据后自动恢复监测');
  await restarted.stop();
});

test('后台在点击后停止，迟到错误仍保留提交记录并进入结果核对', async t => {
  const f = fixture(t), entered = gate(), release = gate();
  f.adapter.submit = async (task, quote, mark) => {
    mark(); entered.resolve(); await release.promise;
    throw new AppError('BROWSER_CLOSED', '合成点击后页面已关闭');
  };
  const pending = f.engine.tick(); await entered.promise;
  const stopping = f.engine.stop(), operationId = f.task.operation.id;
  release.resolve(); await pending; await stopping;
  assert.equal(f.task.operation.id, operationId);
  assert.equal(f.task.operation.stage, 'click_started');
  assert.equal(f.task.state, 'verifying');
  assert.ok(f.task.nextCheckAt > f.clock());
});

// 同一轮中的库存读取成功不代表后续准备成功；连续网络失败必须逐次退避，空库存成功轮次才清零。
for (const mode of ['create', 'boot']) test(`${mode}：连续准备失败累积退避，完整成功轮次后重置`, async t => {
  const f = fixture(t, { mode, pollSeconds: 10 });
  let available = true;
  const probe = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async task => available ? probe(task) : { hosts: [], complete: true };
  f.adapter.inspectBoot = async () => ({ id: f.task.config.sourceId, region: f.task.config.regions[0],
    gpuModel: f.task.config.gpuModel, gpuCount: f.task.config.gpuCount, stopped: true, gpuAvailable: available });
  f.adapter.prepare = f.adapter.boot = async () => { throw new AppError('NETWORK', '合成准备失败', { retryable: true }); };
  for (let failures = 1; failures <= 3; failures++) {
    await f.due(Math.max(0, f.task.nextCheckAt - f.clock()));
    assert.equal(f.task.state, 'watching'); assert.equal(f.task.errors, failures);
    assert.equal(f.task.nextCheckAt, f.clock() + 10000 * 2 ** failures);
    assert.equal(f.task.operation, null);
  }
  available = false;
  await f.due(f.task.nextCheckAt - f.clock());
  assert.equal(f.task.errors, 0); assert.equal(f.task.nextCheckAt, f.clock() + 10000);
  available = true;
  await f.due(10000);
  assert.equal(f.task.errors, 1); assert.equal(f.task.nextCheckAt, f.clock() + 20000);
  assert.equal(f.submissions, 0);
});

test('原实例开机准备的有限重试不会被前置状态读取成功重置', async t => {
  const f = fixture(t, { mode: 'boot', pollSeconds: 10 });
  f.adapter.inspectBoot = async () => ({ id: f.task.config.sourceId, region: f.task.config.regions[0],
    gpuModel: f.task.config.gpuModel, gpuCount: f.task.config.gpuCount, stopped: true, gpuAvailable: true });
  f.adapter.boot = async () => { throw new AppError('LIST_LOADING', '合成开机准备列表错误', { retryable: true, maxRetries: 1 }); };
  await f.engine.tick(); assert.equal(f.task.state, 'watching');
  await f.due(20000);
  assert.equal(f.task.state, 'attention'); assert.equal(f.task.errors, 2); assert.equal(f.task.operation, null);
  f.engine.control(f.task, 'resume');
  assert.equal(f.task.errors, 0);
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.errors, 1);
  assert.equal(f.submissions, 0);
});
