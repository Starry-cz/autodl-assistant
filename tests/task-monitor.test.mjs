import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/store.mjs';
import { AppError } from '../src/errors.mjs';
import { marketSample, bootSample, failedSample, emptyMonitor } from '../src/task-monitor.mjs';
import { fixture, gate } from './helpers.mjs';

const config = { gpuModel: 'RTX 4090', regions: ['北京B区'] };
const host = (extra = {}) => ({ id: 'synthetic-host', gpuModel: 'RTX 4090', region: '北京B区', available: 0, total: 8, ...extra });
const source = (extra = {}) => ({ id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1,
  stopped: true, running: false, starting: false, cardless: false, failed: false, gpuAvailable: false, ...extra });

test('市场采样仅统计目标型号/地区并去重，完整范围才有完整库存数字', () => {
  const sample = marketSample(config, { complete: true, hosts: [host({ available: 2 }), host({ available: 2 }),
    host({ id: 'synthetic-second', available: 3, total: 4 }), host({ id: 'synthetic-wrong-model', gpuModel: 'RTX 4090D', available: 99 }),
    host({ id: 'synthetic-other-region', region: '佛山区', available: 99 })] }, { at: 100, scope: 'full' });
  assert.equal(sample.hostCount, 2);
  assert.equal(sample.available, 5); assert.equal(sample.knownAvailable, 5); assert.equal(sample.total, 12);
  assert.equal(sample.complete, true); assert.equal(sample.status, 'ok');
  assert.equal(sample.kind, 'market'); assert.equal(sample.scope, 'full'); assert.equal(sample.gpuAvailable, null);
  assert.match(sample.note, /任务所选型号和地区/);
});

test('首页或提前命中只保留已知小计；未知库存不补零，完整空列表才可记零', () => {
  for (const scope of ['first-page', 'full']) {
    const sample = marketSample(config, { complete: false, hosts: [host({ available: 3 }), host({ id: 'unknown-stock', available: null })] }, { at: 100, scope });
    assert.equal(sample.available, null); assert.equal(sample.total, null);
    assert.equal(sample.knownAvailable, 3); assert.equal(sample.hostCount, 2); assert.equal(sample.complete, false);
    assert.match(sample.note, /已读范围/);
  }
  const unknown = marketSample(config, { complete: true, hosts: [host({ available: null, total: null })] }, { at: 100, scope: 'full' });
  assert.equal(unknown.available, null); assert.equal(unknown.total, null); assert.equal(unknown.knownAvailable, null);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.complete, false);
  const ambiguous = marketSample(config, { complete: true, hosts: [host({ gpuModel: '' })] }, { at: 100, scope: 'full' });
  assert.equal(ambiguous.available, null); assert.equal(ambiguous.complete, false);
  const empty = marketSample(config, { complete: true, hosts: [] }, { at: 100, scope: 'full' });
  assert.equal(empty.available, 0); assert.equal(empty.total, 0); assert.equal(empty.knownAvailable, 0); assert.equal(empty.complete, true);
  assert.equal(marketSample(config, { complete: false, hosts: [] }, { at: 100, scope: 'first-page' }).available, null);
});

test('型号汇总零空闲保留已知总卡数，未读取主机列表绝不记为零台主机', () => {
  for (const scope of ['full', 'first-page']) for (const total of [24, null]) {
    const sample = marketSample(config, { hosts: [], complete: true, catalogOnly: true, catalogTotal: total }, { at: 100, scope });
    assert.equal(sample.available, 0); assert.equal(sample.knownAvailable, 0); assert.equal(sample.total, total);
    assert.equal(sample.hostCount, null); assert.equal(sample.complete, true); assert.equal(sample.status, 'ok');
    assert.equal(sample.scope, scope); assert.match(sample.note, /型号汇总确认全部目标地区无空闲/);
    assert.match(sample.note, /未读取主机列表，主机数未知/);
    assert.doesNotMatch(sample.note, /0 台主机|已完整读取.*主机/);
    if (total === null) assert.match(sample.note, /总卡数未知/);
  }
});

test('现有时间序列渲染将汇总零空闲画为真实零点，说明来源且不伪造零总量', () => {
  // 只执行现有展示函数：不用浏览器、不改前端，也不会执行导出或网络请求。
  const sandbox = { window: {}, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    time: value => String(value) };
  vm.runInNewContext(fs.readFileSync(new URL('../public/task-monitor.js', import.meta.url), 'utf8'), sandbox);
  for (const total of [24, null]) {
    const sample = marketSample(config, { hosts: [], complete: true, catalogOnly: true, catalogTotal: total }, { at: 100, scope: 'full' });
    const task = { id: 'synthetic-catalog-only', config: { mode: 'create' }, monitor: { ...emptyMonitor(), samples: [sample], lastCheckedAt: 100 } };
    const html = sandbox.window.taskMonitor.history(task);
    assert.match(html, total === null ? /空闲 0 张/ : /空闲 0 \/ 24 张/);
    assert.match(html, /class="task-sample-point"[^>]+cy="150"/);
    assert.match(html, /型号汇总确认全部目标地区无空闲；未读取主机列表，主机数未知/);
    assert.doesNotMatch(html, /class="task-sample-gap"|class="task-sample-point task-sample-partial"|空闲 0 \/ 0 张|0 台主机/);
  }
});

test('原实例布尔库存与错误缺口从不伪造数字', () => {
  for (const value of [true, false, null]) {
    const sample = bootSample(source({ gpuAvailable: value }), 123);
    for (const key of ['available', 'total', 'knownAvailable', 'hostCount']) assert.equal(sample[key], null);
    assert.equal(sample.gpuAvailable, value); assert.equal(sample.scope, 'target');
    assert.equal(sample.status, value === null ? 'unknown' : 'ok');
  }
  const failed = failedSample('market', 'full', Error('合成请求失败 token=synthetic-private'), 456);
  assert.equal(failed.status, 'error'); assert.equal(failed.complete, false);
  assert.equal(failed.available, null); assert.equal(failed.knownAvailable, null);
  assert.doesNotMatch(failed.note, /synthetic-private/);
});

// 使用真实 Engine/Store 与合成适配器，不连接 AutoDL；只有实际 probe/inspect 才生成检查点。
test('型号汇总零库存经引擎持久化为真实采样，日志说明没进入主机列表且不准备或提交', async t => {
  const f = fixture(t, { action: 'observe' });
  const summary = '型号汇总确认无空闲，本轮不进入主机列表';
  f.adapter.probe = async () => ({ source: null, hosts: [], complete: true, scope: 'full', catalogOnly: true, catalogTotal: 24, summary });
  f.adapter.prepare = async () => assert.fail('汇总零空闲不应准备报价');
  await f.engine.tick();
  const sample = f.task.monitor.samples[0];
  assert.equal(sample.available, 0); assert.equal(sample.total, 24); assert.equal(sample.hostCount, null);
  assert.equal(f.task.state, 'watching'); assert.equal(f.submissions, 0);
  assert.equal(f.task.lastScan.summary, summary); assert.equal(f.task.lastScan.count, 0, '这里记录本轮实际读取的主机行数');
  assert.ok(f.task.logs.some(log => log.message === summary));
  assert.ok(f.task.logs.every(log => !/0 台主机|已完整读取.*主机/.test(log.message)));
  const persisted = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).tasks[0].monitor.samples[0];
  assert.deepEqual(persisted, sample); assert.equal(persisted.hostCount, null);
});

test('新建和克隆记录真实 probe 的开始/结束，检查间隔保持原先轮次起点', async t => {
  for (const mode of ['create', 'clone']) {
    const f = fixture(t, { mode, action: 'observe', availableAfter: Infinity });
    assert.deepEqual(f.task.monitor, emptyMonitor());
    const original = f.adapter.probe.bind(f.adapter), started = f.clock();
    f.adapter.probe = async (...args) => {
      assert.equal(f.task.monitor.checking, true);
      assert.equal(f.task.monitor.lastCheckStartedAt, started);
      const result = await original(...args);
      f.advance(300);
      return { ...result, complete: true, hosts: result.hosts.map(row => ({ ...row, total: 8 })) };
    };
    await f.engine.tick();
    assert.equal(f.task.monitor.checking, false);
    assert.equal(f.task.monitor.lastCheckedAt, started + 300);
    assert.equal(f.task.monitor.samples.length, 1);
    assert.equal(f.task.monitor.samples[0].at, started + 300);
    assert.equal(f.task.monitor.samples[0].available, 0);
    assert.equal(f.task.nextCheckAt, started + 20000);
    assert.equal(f.task.state, 'watching'); assert.equal(f.submissions, 0);
  }
});

test('probe 失败留下缺口并沿用原有退避；后续成功不会补造失败库存', async t => {
  const f = fixture(t, { action: 'observe', availableAfter: Infinity });
  const original = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async (...args) => ({ ...(await original(...args)), complete: true });
  await f.engine.tick();
  f.adapter.probe = async () => { throw new AppError('NETWORK', '合成库存读取失败', { retryable: true }); };
  await f.due(25000);
  const failed = f.task.monitor.samples.at(-1);
  assert.equal(failed.status, 'error'); assert.equal(failed.kind, 'market'); assert.equal(failed.scope, 'full');
  assert.equal(failed.available, null); assert.equal(failed.knownAvailable, null); assert.equal(failed.hostCount, null);
  assert.equal(f.task.monitor.checking, false); assert.equal(f.task.monitor.lastCheckedAt, f.clock());
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.nextCheckAt, f.clock() + 40000);
  f.adapter.probe = original;
  await f.due(50000);
  assert.equal(f.task.monitor.samples.length, 3);
  assert.equal(f.task.monitor.samples[1].status, 'error');
  assert.equal(f.task.monitor.samples[2].status, 'ok');
  assert.equal(f.submissions, 0);
});

test('配置报价阶段失败不伪造成一次库存检查失败', async t => {
  const f = fixture(t, { action: 'observe' });
  f.adapter.prepare = async () => { throw new AppError('QUOTE', '合成报价不匹配'); };
  await f.engine.tick();
  assert.equal(f.task.state, 'attention'); assert.equal(f.task.monitor.samples.length, 1);
  assert.equal(f.task.monitor.samples[0].status, 'ok'); assert.equal(f.task.monitor.checking, false);
  assert.equal(f.submissions, 0);
});

test('原实例检查只用已有布尔证据，身份错误与 inspect 失败记录缺口', async t => {
  const f = fixture(t, { mode: 'boot', action: 'observe' });
  let current = source({ gpuAvailable: null });
  f.adapter.inspectBoot = async () => current;
  f.adapter.boot = async () => assert.fail('仅监测不能点击开机');
  await f.engine.tick();
  current = source({ gpuAvailable: false }); await f.due();
  current = source({ gpuAvailable: true }); await f.due();
  assert.deepEqual(f.task.monitor.samples.map(sample => sample.gpuAvailable), [null, false, true]);
  assert.ok(f.task.monitor.samples.every(sample => sample.available === null && sample.total === null));
  assert.equal(f.task.state, 'found'); assert.equal(f.submissions, 0);
  for (const bad of [async () => source({ id: 'synthetic-wrong' }), async () => { throw new AppError('NETWORK', '合成检查失败', { retryable: true }); }]) {
    const g = fixture(t, { mode: 'boot', action: 'observe' }); g.adapter.inspectBoot = bad;
    await g.engine.tick();
    assert.equal(g.task.monitor.samples[0].status, 'error');
    assert.equal(g.task.monitor.samples[0].kind, 'boot');
    assert.equal(g.task.monitor.samples[0].gpuAvailable, null);
    assert.equal(g.task.monitor.checking, false);
  }
});

test('暂停、取消和停止期间结束的 probe/inspect 只收尾，不新增采样或调度', async t => {
  for (const mode of ['create', 'boot']) for (const action of ['pause', 'cancel', 'stop']) {
    const f = fixture(t, { mode, action: 'observe' });
    const entered = gate(), release = gate(), next = f.task.nextCheckAt;
    const read = async () => {
      entered.resolve(); await release.promise;
      if (action === 'stop') throw new AppError('NETWORK', '停止后的迟到错误', { retryable: true });
      return mode === 'boot' ? source() : { hosts: [host()], complete: true };
    };
    if (mode === 'boot') f.adapter.inspectBoot = read; else f.adapter.probe = read;
    const checking = f.engine.tick(); await entered.promise;
    assert.equal(f.task.monitor.checking, true);
    if (action === 'stop') f.engine.stopping = true; else f.engine.control(f.task, action);
    release.resolve(); await checking;
    assert.equal(f.task.monitor.checking, false);
    assert.equal(f.task.monitor.lastCheckedAt, null); assert.deepEqual(f.task.monitor.samples, []);
    assert.equal(f.task.nextCheckAt, next); assert.equal(f.task.errors, 0); assert.equal(f.submissions, 0);
    assert.equal(f.task.state, action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'watching');
  }
});

test('账号核验期间暂停不会开始资源检查或制造采样', async t => {
  const f = fixture(t, { action: 'observe' }), entered = gate(), release = gate();
  f.engine.verifyOwner = async () => { entered.resolve(); await release.promise; };
  f.adapter.probe = async () => assert.fail('暂停后不能再启动 probe');
  const pending = f.engine.tick(); await entered.promise;
  f.engine.control(f.task, 'pause'); release.resolve(); await pending;
  assert.deepEqual(f.task.monitor, emptyMonitor());
  assert.equal(f.task.attempts, 0);
});

test('真实检查历史持久化为最近60点，重启清除 checking，旧任务不补造历史', async t => {
  const f = fixture(t, { action: 'observe', availableAfter: Infinity });
  for (let i = 0; i < 65; i++) await f.due();
  assert.equal(f.task.monitor.samples.length, 60);
  const persisted = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).tasks[0].monitor;
  assert.equal(persisted.samples.length, 60);
  assert.equal(persisted.samples.at(-1).at, f.clock());
  f.task.monitor.checking = true; f.store.save();
  const loaded = new Store(f.dir);
  assert.equal(loaded.get(f.task.id).monitor.checking, false);
  assert.deepEqual(loaded.get(f.task.id).monitor.samples, persisted.samples);
  delete loaded.get(f.task.id).monitor; loaded.save();
  const legacy = new Store(f.dir);
  assert.deepEqual(legacy.get(f.task.id).monitor, emptyMonitor());
});
