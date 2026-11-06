import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Wallet } from '../src/wallet.mjs';
import { Notifier } from '../src/notifications.mjs';
import { AppError } from '../src/errors.mjs';
import { normalizeNotifications } from '../src/config.mjs';
import { candidateReasons } from '../src/matching.mjs';
import { blocksTask } from '../src/task-conflicts.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { testConfig } from './fixtures/config.mjs';
import { fixture } from './helpers.mjs';
// 2026-10-30 代码审查发现的问题的回归测试。全部为内存合成数据与临时目录，不访问 AutoDL、不发送通知。
const ok = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 'Success', data: { assets: 100000000, voucher_balance: 0 } }) });
const reopen = f => { const store = new Store(f.dir, { clock: f.clock }); new Engine(store, { autodl: f.adapter }, f.notifier, { clock: f.clock, random: () => 0 }); return store; };

test('恢复或重建任务不清除 30 分钟内的拒绝证据；只放过延迟创建保护停下时已核对的那几台实例', t => {
  const f = fixture(t);
  f.store.patch(f.task, { state: 'attention', lastError: '合成：延迟创建', lateInstanceIds: ['synthetic-late0001'],
    submitRejections: [{ at: f.clock() - 60000, baselineIds: ['synthetic-old00001'], hostNumber: '922机' }, { at: f.clock() - 31 * 60000, baselineIds: [], hostNumber: '923机' }] });
  f.engine.control(f.task, 'resume');
  assert.equal(f.task.submitRejections.length, 1); assert.deepEqual(f.task.submitRejections[0].baselineIds, ['synthetic-old00001', 'synthetic-late0001']); assert.equal(f.task.lateInstanceIds, null);
  const adapter = new AutoDLBrowserAdapter('unused-isolated-review-profile'); adapter.verifyIdentity = () => true;
  const late = { id: 'synthetic-late0001', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1 };
  assert.doesNotThrow(() => adapter.lateCreation(f.task, [late]));
  assert.throws(() => adapter.lateCreation(f.task, [late, { ...late, id: 'synthetic-late0002' }]), e => e.code === 'SUBMIT_LATE' && e.lateIds[0] === 'synthetic-late0002');
  // 重建：新任务沿用旧任务未过期的拒绝证据与暂不选择的主机。
  f.store.patch(f.task, { state: 'attention', hostCooldowns: [{ hostId: 'h', hostNumber: '922机', region: '北京B区', at: f.clock(), until: f.clock() + 60000, count: 1, reason: '合成' }] });
  const next = f.store.create(f.task.config, { replaces: f.task });
  assert.equal(next.submitRejections.length, 1); assert.equal(next.hostCooldowns.length, 1);
});
test('提交前暂停、进程被强行结束后重启：残留的操作意图被清除，任务保持暂停或已停止，可恢复或新建同型号任务', t => {
  // 磁盘上的状态等同于“意图已落盘、尚未点击时用户点了暂停，随后进程被强行结束”。
  const f = fixture(t);
  f.store.patch(f.task, { state: 'paused', operation: { id: 'synthetic-op', stage: 'intent', at: f.clock() } });
  let store = reopen(f), task = store.get(f.task.id);
  assert.equal(task.state, 'paused'); assert.equal(task.operation, null); assert.ok(task.logs.some(l => /尚未进入点击/.test(l.message)));
  const engine = new Engine(store, { autodl: f.adapter }, f.notifier, { clock: f.clock, random: () => 0 });
  assert.doesNotThrow(() => engine.control(task, 'resume')); assert.equal(task.state, 'watching');
  store.patch(task, { state: 'cancelled', operation: { id: 'synthetic-op2', stage: 'intent', at: f.clock() } });
  store = reopen(f); task = store.get(f.task.id);
  assert.equal(task.state, 'cancelled'); assert.equal(task.operation, null);
  assert.equal(blocksTask(task, task.config), false);
});
test('点击前余额接口偶发失败：有限次退避后继续监测，不转人工；没有连接 Token 时监测阶段就提醒一次，不停止', async t => {
  let calls = 0;
  const f = fixture(t, { balanceGuard: true });
  const wallet = new Wallet({ store: f.store, clock: f.clock, fetchImpl: async () => { calls++; if (calls === 2) throw new TypeError('fetch failed'); return ok(); } });
  wallet.setToken('synthetic-wallet-token'); f.engine.wallet = wallet;
  f.adapter.submit = async (task, q, mark, beforeClick) => { f.advance(16000); await beforeClick(q); mark(); return { instanceId: 'synthetic-x', acceptedAt: f.clock() }; };
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.match(f.task.lastError, /第 1\/5 次自动重试/); assert.equal(f.store.data.notifications.some(n => n.event === 'attention'), false);
  f.advance(60000); await f.engine.tick(); assert.equal(f.task.state, 'verifying');
  const g = fixture(t, { balanceGuard: true, availableAfter: 3 });
  g.engine.wallet = new Wallet({ store: g.store, clock: g.clock, fetchImpl: async () => ok() });
  await g.engine.tick(); assert.equal(g.task.state, 'watching'); assert.equal(g.store.data.notifications.filter(n => n.event === 'balance-low').length, 1);
  assert.match(g.task.balanceLow.message, /没有连接 AutoDL 开发者 Token/);
  for (let i = 0; i < 3; i++) await g.due(20000);
  assert.equal(g.task.state, 'watching'); assert.equal(g.submissions, 0); assert.equal(g.store.data.notifications.filter(n => n.event === 'balance-low').length, 1);
  g.engine.wallet.setToken('synthetic-wallet-token'); await g.due(20000);
  assert.equal(g.task.balanceLow, null); assert.equal(g.task.state, 'verifying');
});
test('正常停止后台恰好在点击之前：不转“需要处理”、不发通知，重启后继续监测', async t => {
  const f = fixture(t); let stopping;
  f.adapter.submit = async (task, quote, mark) => { stopping = f.engine.stop(); await new Promise(resolve => setTimeout(resolve, 10)); mark(); return { instanceId: 'x', acceptedAt: f.clock() }; };
  await f.engine.tick(); await stopping;
  assert.notEqual(f.task.state, 'attention'); assert.equal(f.task.operation, null); assert.deepEqual(f.store.data.notifications, []);
  assert.equal(reopen(f).get(f.task.id).state, 'watching');
});
test('点击结果不明的自动核对从实际点击时算起 2 分钟，不从意图落盘时算起', async t => {
  const f = fixture(t);
  f.adapter.submit = async (task, quote, mark) => { f.advance(40000); mark(); throw new AppError('SUBMIT_UNCLEAR', '合成：按钮仍在加载'); };
  await f.engine.tick();
  assert.equal(f.task.operation.clickedAt - f.task.operation.at, 40000); assert.equal(f.task.nextCheckAt, f.task.operation.clickedAt + 120000);
  const adapter = new AutoDLBrowserAdapter('unused-isolated-review-profile');
  const status = await adapter.reconcileUnclear({ ...f.task, operation: { ...f.task.operation, at: Date.now() - 150000, clickedAt: Date.now() - 100000 } });
  assert.equal(status.pending, true);
});
test('数据盘复制超过 30 分钟转“需要处理”后恢复：重新等待 30 分钟，复制完成后自动完成', async t => {
  const f = fixture(t, { mode: 'clone' });
  await f.engine.tick();
  const id = f.task.operation.receipt.instanceId; let copied = false;
  f.adapter.reconcile = async () => ({ instance: { id, running: true, gpuVerified: true, copyComplete: copied, progress: copied ? '数据盘复制完成' : '数据盘复制中' } });
  f.advance(31 * 60000); await f.engine.tick(); assert.equal(f.task.state, 'attention');
  f.engine.control(f.task, 'resume'); f.advance(1000); await f.engine.tick();
  assert.equal(f.task.state, 'verifying'); assert.equal(f.store.data.notifications.filter(n => n.event === 'verify-timeout').length, 1);
  copied = true; f.advance(60000); await f.engine.tick(); assert.equal(f.task.state, 'completed');
});
test('旧价格上限策略按分比较：1.1 × 3 等于上限 3.3 时仍合格', () => {
  const config = testConfig({ gpuCount: 3, maxGpuHourly: 1.1, maxTotalHourly: 3.3 });
  const host = { id: 'h', region: '北京B区', gpuModel: 'RTX 4090', available: 3, driver: '550', maxCuda: '12.8', price: 1.1, expandableGB: 300 };
  assert.deepEqual(candidateReasons(host, config), []);
  assert.ok(candidateReasons({ ...host, price: 1.11 }, config).includes('价格不符'));
});
test('通知 Token 不能含换行等控制字符；发送失败的报错原文中的 Token 写入状态前被隐藏', async t => {
  assert.throws(() => normalizeNotifications({ webhookEnabled: true, webhookUrl: 'https://example.test/x', webhookToken: 'SECRET-abc\nX: y' }), /不能包含/);
  assert.throws(() => normalizeNotifications({ wechatEnabled: true, wechatToken: 'WX-SECRET\r\nz' }), /不能包含/);
  const f = fixture(t);
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://example.test/notify', webhookToken: 'synthetic-secret-token-123' };
  f.store.enqueueNotification(f.task, 'found', '合成消息');
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { throw Error('Headers.append: "Bearer synthetic-secret-token-123" is an invalid header value.'); } });
  await notifier.flush();
  const error = f.store.data.notifications[0].deliveries.webhook.error;
  assert.equal(error.includes('synthetic-secret-token-123'), false); assert.match(error, /已隐藏/);
});
test('起租卡数不符的主机 30 分钟内不选，下一轮改选其他主机', async t => {
  const f = fixture(t), prepare = f.adapter.prepare.bind(f.adapter); let attempts = 0; f.adapter.alternate = true;
  f.adapter.prepare = async (task, host, ...rest) => { if (++attempts === 1) throw new AppError('GPU_COUNT', '选中这台主机后 GPU 数量不再是 1 卡（该主机可能有起租卡数要求，如“2卡起租”）；未提交，改试其他主机', { race: true, hostProblem: true }); return prepare(task, host, ...rest); };
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.hostCooldowns[0].hostId, 'synthetic-target-host'); assert.equal(f.task.hostCooldowns[0].until - f.clock(), 30 * 60000);
  assert.ok(f.task.logs.some(l => /合成922机约 30 分钟内不再选择/.test(l.message)));
  await f.due(20000); assert.equal(f.task.state, 'verifying'); assert.equal(f.task.operation.quote.host.id, 'synthetic-other-host');
});
test('租多卡时钱包余额（不含代金券）需大于 10 元：不足时不核验、不提交，继续监测；充值后恢复', async t => {
  const f = fixture(t, { balanceGuard: true, gpuCount: 2 });
  const w = { snapshot: { balance: 5, vouchers: 100, checkedAt: f.clock() }, calls: 0,
    recentBalance: async () => { w.calls++; w.snapshot = { ...w.snapshot, checkedAt: f.clock() }; return w.snapshot; },
    refresh: async () => w.snapshot, check: async () => ({ requiredMilli: 1, checkedAt: f.clock() }), confirm: () => {} };
  f.engine.wallet = w; f.adapter.probe = async task => ({ source: null, summary: '合成：有空闲', hosts: [{ id: 'h', number: '922机', region: '北京B区', gpuModel: 'RTX 4090', available: 8, driver: '595', maxCuda: '13.2', price: 1.98, expandableGB: 4096 }] });
  await f.engine.tick();
  assert.equal(f.task.state, 'watching'); assert.equal(f.submissions, 0); assert.match(f.task.balanceLow.message, /多卡实例时钱包余额需大于 10 元/);
  w.snapshot = { ...w.snapshot, balance: 20 }; await f.due(20000);
  assert.equal(f.task.balanceLow, null); assert.equal(f.submissions, 1);
});
test('日志脱敏覆盖 Bearer、JSON 中的 token 与 x-api-key 等常见写法', async () => {
  const { redact } = await import('../src/errors.mjs');
  for (const raw of ['Authorization: Bearer secret-value-123', '{"token":"secret-value-123"}', 'x-api-key: secret-value-123', 'token=secret-value-123', 'key sk-secretvalue123456'])
    assert.equal(redact(raw).includes('secret'), false, raw);
});

