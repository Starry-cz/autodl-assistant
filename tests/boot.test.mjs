import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, gate } from './helpers.mjs';
import { Engine } from '../src/engine.mjs';
import { AppError } from '../src/errors.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { publicInstance, validateBootSource } from '../src/instances.mjs';
import { parseInstanceRow } from '../src/adapters/dom.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { blocksTask } from '../src/task-conflicts.mjs';

// 全部使用合成实例和页面，不登录真实账号，也不调用付费接口。
const source = (extra = {}) => ({ id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
  stopped: true, running: false, starting: false, cardless: false, failed: false, gpuAvailable: true, ...extra });
function bootFixture(t, input = {}) {
  const f = fixture(t, { mode: 'boot', ...input });
  f.adapter.current = source(); f.adapter.boots = 0;
  f.adapter.inspectBoot = async () => f.adapter.current;
  f.adapter.boot = async (_t, mark) => { mark(); f.adapter.boots++; return {}; };
  return f;
}

test('原实例开机不要求新租参数，并且需要费用授权', () => {
  const input = { mode: 'boot', sourceId: 'synthetic-source', gpuModel: 'RTX 4090', gpuCount: 1, regions: ['北京B区'] };
  const config = normalizeConfig(input);
  assert.equal(config.pollSeconds, 10); assert.equal(config.action, 'observe'); assert.deepEqual(config.imagePath, []);
  assert.throws(() => normalizeConfig({ ...input, action: 'execute' }), /费用/);
  assert.throws(() => normalizeConfig({ ...input, sourceId: 'pro-123456789' }), /Pro/);
});

test('开机只提交一次并等待有卡运行，不进入新建流程', async t => {
  const f = bootFixture(t); await f.engine.tick();
  assert.equal(f.adapter.boots, 1); assert.equal(f.submissions, 0); assert.equal(f.task.state, 'verifying');
  assert.equal(f.task.operation.receipt.instanceId, f.task.config.sourceId);
  await f.due(); assert.equal(f.adapter.boots, 1); assert.equal(f.task.state, 'verifying');
  f.adapter.current = source({ stopped: false, starting: true }); await f.due(); assert.equal(f.task.state, 'verifying');
  f.adapter.current = source({ stopped: false, running: true }); await f.due();
  assert.equal(f.task.state, 'completed'); assert.equal(f.task.result.gpuVerified, true); assert.equal(f.adapter.boots, 1);
});

test('平台明确缺卡才清除提交记录并重试', async t => {
  const f = bootFixture(t);
  f.adapter.boot = async (_t, mark) => { mark(); f.adapter.boots++; return { noStock: true, message: '当前主机 GPU 不足' }; };
  await f.engine.tick(); assert.equal(f.task.state, 'watching'); assert.equal(f.task.operation, null);
  await f.due(); assert.equal(f.adapter.boots, 2);
});

test('开机结果不明时保留原实例回执，恢复后仍只核对', async t => {
  const f = bootFixture(t);
  f.adapter.boot = async (_t, mark) => { mark(); f.adapter.boots++; throw new Error('响应丢失'); };
  await f.engine.tick(); assert.equal(f.task.state, 'verifying'); assert.ok(f.task.operation);
  const recovered = new Engine(f.store, { autodl: f.adapter }, f.notifier, { clock: f.clock, random: () => 0 });
  t.after(() => recovered.stop()); await recovered.tick(); f.advance(50000); await recovered.tick();
  assert.equal(f.adapter.boots, 1); assert.equal(f.task.state, 'verifying');
});

test('明确余额问题停止自动重试，未知弹窗仍只核对', async t => {
  const f = bootFixture(t);
  f.adapter.boot = async (_t, mark) => { mark(); f.adapter.boots++; return { rejected: true, message: '余额不足' }; };
  await f.engine.tick(); await f.due(); assert.equal(f.adapter.boots, 1); assert.equal(f.task.state, 'attention'); assert.equal(f.task.operation, null);
});

test('只提醒模式必须看到GPU充足，未知库存不报有货', async t => {
  const f = bootFixture(t, { action: 'observe' }); f.adapter.current = source({ gpuAvailable: null });
  await f.engine.tick(); assert.equal(f.task.state, 'watching'); assert.equal(f.adapter.boots, 0);
  f.adapter.current = source(); await f.due(); assert.equal(f.task.state, 'found'); assert.equal(f.adapter.boots, 0);
});

test('提交前开机监测按轮次起点调度，读取耗时不额外叠加到检查间隔', async t => {
  for (const [action, current] of [
    ['execute', source({ gpuAvailable: false })],
    ['observe', source({ gpuAvailable: null })],
    ['execute', source({ stopped: false, starting: true })],
  ]) for (const readMs of [2000, 15000]) {
    const f = bootFixture(t, { action, pollSeconds: 10 }), started = f.clock();
    f.adapter.inspectBoot = async () => { f.advance(readMs); return current; };
    await f.engine.tick();
    assert.equal(f.task.nextCheckAt, Math.max(started + 10000, f.clock()));
    assert.equal(f.task.state, 'watching');
    assert.equal(f.adapter.boots, 0); assert.equal(f.task.operation, null);
  }
});

test('开机读取错误仍按完成时间退避，已提交回执仍只读核对并保留原等待间隔', async t => {
  const failed = bootFixture(t, { pollSeconds: 10 });
  failed.adapter.inspectBoot = async () => {
    failed.advance(2000);
    throw new AppError('NETWORK', '合成读取失败', { retryable: true });
  };
  await failed.engine.tick();
  assert.equal(failed.task.nextCheckAt, failed.clock() + 20000);
  assert.equal(failed.adapter.boots, 0);
  const submitted = bootFixture(t, { pollSeconds: 10 });
  await submitted.engine.tick();
  const receipt = structuredClone(submitted.task.operation.receipt);
  submitted.adapter.inspectBoot = async () => { submitted.advance(2000); return source({ gpuAvailable: false }); };
  await submitted.due(11000);
  assert.equal(submitted.task.nextCheckAt, submitted.clock() + 10000);
  assert.deepEqual(submitted.task.operation.receipt, receipt);
  assert.equal(submitted.task.state, 'verifying'); assert.equal(submitted.adapter.boots, 1);
});

test('已经有卡运行直接完成，无卡运行拒绝并且不会关机', async t => {
  const f = bootFixture(t); f.adapter.current = source({ stopped: false, running: true });
  await f.engine.tick(); assert.equal(f.task.state, 'completed'); assert.equal(f.adapter.boots, 0);
  const g = bootFixture(t); g.adapter.current = source({ stopped: false, cardless: true });
  await g.engine.tick(); assert.equal(g.task.state, 'attention'); assert.match(g.task.lastError, /手动关机/); assert.equal(g.adapter.boots, 0);
});

test('原实例身份变化不会点击其他配置', async t => {
  const f = bootFixture(t); f.adapter.current = source({ gpuCount: 2 });
  await f.engine.tick(); assert.equal(f.task.state, 'attention'); assert.equal(f.adapter.boots, 0);
  assert.throws(() => validateBootSource(f.task.config, source({ id: 'synthetic-other' })), /已变化/);
});

test('明确可重试的列表加载错误退避读取，不发开机请求', async t => {
  const f = bootFixture(t);
  f.adapter.inspectBoot = async () => { throw new AppError('LIST_LOADING', '列表加载中', { retryable: true, maxRetries: 1 }); };
  await f.engine.tick(); assert.equal(f.task.state, 'watching'); assert.equal(f.adapter.boots, 0);
  await f.due(60000); assert.equal(f.task.state, 'attention'); assert.equal(f.adapter.boots, 0);
});

test('确认前暂停阻止点击，确认后取消保留提交回执', async t => {
  const f = bootFixture(t), entered = gate(), release = gate();
  f.adapter.boot = async (_t, mark) => { entered.resolve(); await release.promise; mark(); f.adapter.boots++; return {}; };
  const work = f.engine.tick(); await entered.promise; f.engine.control(f.task, 'pause'); release.resolve(); await work;
  assert.equal(f.task.state, 'paused'); assert.equal(f.adapter.boots, 0); assert.equal(f.task.operation, null);
  const g = bootFixture(t), afterClick = gate(), finish = gate();
  g.adapter.boot = async (_t, mark) => { mark(); afterClick.resolve(); await finish.promise; return {}; };
  const ongoing = g.engine.tick(); await afterClick.promise; g.engine.control(g.task, 'cancel'); finish.resolve(); await ongoing;
  assert.equal(g.task.state, 'cancelled'); assert.ok(g.task.operation.receipt);
});

test('等待时限停止提交；已提交在独立核对时限结束后保留记录待处理', async t => {
  const f = bootFixture(t, { timeoutMinutes: 1 }); f.adapter.current = source({ gpuAvailable: false });
  await f.engine.tick(); await f.due(60001); assert.equal(f.task.state, 'expired'); assert.equal(f.adapter.boots, 0);
  const g = bootFixture(t, { timeoutMinutes: 1 }); await g.engine.tick(); await g.due(30 * 60000);
  assert.equal(g.task.state, 'attention'); assert.ok(g.task.operation); assert.equal(g.adapter.boots, 1);
});

test('开机在等待截止前提交，截止后仍读取原实例并确认运行，不重复开机', async t => {
  const f = bootFixture(t, { timeoutMinutes: 1 });
  f.advance(55000); await f.engine.tick();
  assert.equal(f.adapter.boots, 1);
  f.adapter.current = source({ stopped: false, running: true });
  await f.due(f.task.nextCheckAt - f.clock());
  assert.equal(f.task.state, 'completed');
  assert.equal(f.task.result.gpuVerified, true);
  assert.equal(f.adapter.boots, 1);
});

test('恢复已提交开机任务后给予独立核对时限，不被原监测分钟数提前截断', async t => {
  const f = bootFixture(t, { timeoutMinutes: 1 });
  await f.engine.tick();
  f.engine.control(f.task, 'pause'); f.advance(35 * 60000);
  f.engine.control(f.task, 'resume');
  const resumed = f.clock(), operationId = f.task.operation.id;
  await f.due(60001);
  assert.equal(f.task.state, 'verifying');
  assert.equal(f.task.operation.id, operationId);
  await f.due(resumed + 30 * 60000 - f.clock());
  assert.equal(f.task.state, 'attention');
  assert.equal(f.task.operation.id, operationId);
  assert.equal(f.adapter.boots, 1);
});

test('开机准备期间越过等待时限，无付费点击时应标记已到期', async t => {
  const f = bootFixture(t, { timeoutMinutes: 1 });
  f.adapter.boot = async (_task, mark) => { f.advance(60001); mark(); f.adapter.boots++; return {}; };
  await f.engine.tick();
  assert.equal(f.task.state, 'expired');
  assert.equal(f.task.operation, null);
  assert.equal(f.adapter.boots, 0);
});

test('原实例任务按ID去重，同型号不同实例不互相阻挡', async t => {
  const f = bootFixture(t);
  assert.equal(blocksTask(f.task, { ...f.task.config }), true);
  assert.equal(blocksTask(f.task, { ...f.task.config, sourceId: 'synthetic-other' }), false);
});

test('DOM区分无卡状态与无卡模式开机菜单，并保留未知库存', () => {
  const base = '北京B区\nsynthetic001-abcdef01\nRTX 4090 * 1卡\n';
  const stopped = parseInstanceRow(base + '已关机\n开机\n无卡模式开机');
  assert.equal(stopped.cardless, false); assert.equal(stopped.stopped, true); assert.equal(stopped.gpuAvailable, null);
  assert.equal(parseInstanceRow(base + '已关机\nGPU充足').gpuAvailable, true);
  const cardless = parseInstanceRow(base + '运行中\n无卡模式'); assert.equal(cardless.cardless, true); assert.equal(cardless.running, false);
  assert.equal(publicInstance(cardless).bootable, false);
  assert.equal(parseInstanceRow(base + '开机中').starting, true);
});

function adapterPage({ message = null, afterText = '开机中', confirmError = null } = {}) {
  let marked = false, confirmed = false;
  const button = click => ({ count: async () => 1, isEnabled: async () => true, click });
  const confirm = button(async () => { assert.equal(marked, true); confirmed = true; if (confirmError) throw confirmError; });
  const dialog = { filter() { return this; }, waitFor: async () => {}, count: async () => 1,
    getByRole: (_role, { name }) => { assert.equal(name, '确定'); return confirm; } };
  const row = { getByRole: (_role, { name }) => { assert.equal(name, '开机'); return button(async () => {}); },
    evaluateAll: async () => [{ text: '北京B区\nsynthetic-source\nRTX 4090 * 1卡\n' + afterText, instanceId: 'synthetic-source', identityColumn: 0 }] };
  const adapter = Object.create(AutoDLBrowserAdapter.prototype);
  adapter.findInstanceRow = async () => ({ row, info: source() });
  adapter.page = { locator: selector => { assert.equal(selector, '.el-message-box:visible'); return dialog; } };
  adapter.markClickSignals = async () => {};
  adapter.clickSignals = async () => ({ toasts: message ? [message] : [], dialogs: [] });
  const task = { config: normalizeConfig({ mode: 'boot', sourceId: 'synthetic-source', gpuModel: 'RTX 4090', regions: ['北京B区'] }) };
  return { adapter, task, mark: () => { marked = true; }, get confirmed() { return confirmed; } };
}

test('浏览器适配器只点击开机确认，付费按钮前调用mark', async () => {
  const f = adapterPage(); assert.deepEqual(await f.adapter.boot(f.task, f.mark), {}); assert.equal(f.confirmed, true);
});

test('浏览器适配器把明确GPU不足与其它拒绝区分开', async () => {
  const f = adapterPage({ message: '当前空闲GPU不足，无法开机' }); assert.equal((await f.adapter.boot(f.task, f.mark)).noStock, true);
  const g = adapterPage({ message: '余额不足，无法开机' }); assert.equal((await g.adapter.boot(g.task, g.mark)).rejected, true);
  const u = adapterPage({ message: '服务器异常' }); await assert.rejects(u.adapter.boot(u.task, u.mark), e => e instanceof AppError && e.code === 'BOOT_UNCLEAR');
});

test('浏览器适配器重新核对目标身份，无卡或错误ID均不能进入确认', async () => {
  for (const extra of [{ id: 'synthetic-other' }, { stopped: false, cardless: true }, { gpuCount: 2 }]) {
    const f = adapterPage(); f.adapter.findInstanceRow = async () => ({ row: null, info: source(extra) });
    await assert.rejects(f.adapter.boot(f.task, f.mark), /变化|手动关机/);
    assert.equal(f.confirmed, false);
  }
});
