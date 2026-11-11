import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { fixture } from './helpers.mjs';

// 使用确定性的合成时钟检查调度顺序，不依赖机器快慢，也不打开浏览器或访问 AutoDL。
function scheduler(t, count = 1) {
  let now = 10000, serial = 0;
  const timers = new Map(), tasks = Array.from({ length: count }, (_, id) => ({ id,
    config: { provider: 'autodl', pollSeconds: 1 }, state: 'watching', nextCheckAt: now, operation: null }));
  t.mock.method(globalThis, 'setTimeout', (run, delay) => {
    const id = ++serial; timers.set(id, { run, at: now + delay }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const store = { tasks: () => tasks, patch: (task, changes) => Object.assign(task, changes), log() {} };
  let notifications = 0;
  const engine = new Engine(store, {}, { flush: async () => { notifications++; } }, { clock: () => now, random: () => 0 });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].run(); await flush();
    }
    now = until;
  }
  async function runNext() {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, '应当存在下一次调度');
    timers.delete(next[0]); now = next[1].at; next[1].run(); await flush();
  }
  t.after(() => { engine.stopping = true; timers.clear(); });
  return { engine, tasks, advance, runNext, flush, now: () => now, notifications: () => notifications,
    pending: () => timers.size, nextDelay: () => Math.min(...[...timers.values()].map(timer => timer.at - now)) };
}

test('同时到期任务连续串行运行，不再为每个任务增加 500ms 等待', async t => {
  const f = scheduler(t, 12), starts = []; let concurrent = 0, peak = 0;
  f.engine.step = async task => {
    concurrent++; peak = Math.max(peak, concurrent); starts.push(f.now());
    await Promise.resolve(); f.engine.schedule(task, { from: f.now() }); concurrent--;
  };
  f.engine.start(); f.engine.start();
  assert.equal(f.pending(), 1, '重复启动不能生成多个定时器');
  await f.advance(0);
  assert.equal(starts.length, 12); assert.equal(new Set(starts).size, 1); assert.equal(peak, 1);
  await f.advance(999); assert.equal(starts.length, 12, '仍遵守每个任务的正常检查间隔');
  await f.advance(1); assert.equal(starts.length, 24);
});

test('调度按 nextCheckAt 唤醒，保留抖动与错误退避，不提前抢跑', async t => {
  const f = scheduler(t), starts = [];
  f.engine.random = () => 0.5;
  f.engine.step = async task => { starts.push(f.now()); task.errors = 1; f.engine.schedule(task, { error: true }); };
  f.engine.start(); await f.advance(0);
  assert.equal(f.tasks[0].nextCheckAt, 12120);
  await f.advance(2119); assert.deepEqual(starts, [10000]);
  await f.advance(1); assert.deepEqual(starts, [10000, 12120]);
});

test('页面锁等待者优先取得交接机会，释放后立即继续到期任务', async t => {
  const f = scheduler(t), starts = [];
  f.engine.step = async task => { starts.push(f.now()); f.engine.schedule(task, { from: f.now() }); };
  f.engine.browserWaiters = 1;
  f.engine.start(); await f.advance(500); assert.equal(starts.length, 0);
  f.engine.browserWaiters = 0; f.engine.busy = true; f.engine.wake();
  assert.equal(f.nextDelay(), 500, '忙碌时保持心跳，不形成零延迟自旋');
  await f.advance(500); assert.equal(starts.length, 0, '用户操作期间不重入页面');
  f.engine.busy = false; f.engine.wake(); await f.advance(0);
  assert.deepEqual(starts, [11000]);
});

test('无活动任务时通知仍可重试；停止会清除调度，不再后台唤醒', async t => {
  const f = scheduler(t, 0);
  f.engine.start(); await f.advance(1000); assert.equal(f.notifications(), 2);
  await f.engine.stop(); assert.equal(f.pending(), 0);
  f.engine.wake(); await f.advance(2000); assert.equal(f.notifications(), 2);
});

test('未 start 的手动 tick 和外部 wake 不会悄悄启动后台计时器', async t => {
  const f = scheduler(t);
  f.engine.step = async task => f.engine.schedule(task, { from: f.now() });
  await f.engine.tick(); f.engine.wake();
  assert.equal(f.pending(), 0); assert.equal(f.engine.started, false);
});

test('人工恢复任务会取消远期等待并唤醒；暂停后不会因旧计时器执行', async t => {
  const f = scheduler(t), task = f.tasks[0], starts = [];
  Object.assign(task, { state: 'paused', deadlineAt: 70000, config: { ...task.config, timeoutMinutes: 5 } });
  f.engine.step = async current => { starts.push(f.now()); f.engine.schedule(current, { from: f.now() }); };
  f.engine.start(); f.engine.control(task, 'resume'); await f.advance(0);
  assert.deepEqual(starts, [10000]);
  f.engine.control(task, 'pause'); await f.advance(2000); assert.equal(starts.length, 1);
});

test('未捕获的轮次异常按 500ms 节流，外部唤醒不能造成忙循环，恢复后立即交接', async t => {
  const f = scheduler(t, 2), starts = []; let broken = true;
  t.mock.method(console, 'error', () => {});
  f.engine.step = async task => {
    starts.push([task.id, f.now()]);
    if (broken) throw new Error('合成持久化失败');
    task.state = 'found';
  };
  f.engine.start();
  // 固定次数推进，若节流回归不会让测试陷入同一时间点的无限循环。
  for (let turn = 0; turn < 4; turn++) {
    await f.runNext();
    f.engine.wake();
    assert.equal(f.nextDelay(), 500, '页面请求结束等外部唤醒仍须保留失败节流');
  }
  assert.deepEqual(starts, [[0, 10000], [0, 10500], [0, 11000], [0, 11500]]);
  broken = false;
  await f.runNext(); await f.runNext();
  assert.deepEqual(starts.slice(-2), [[0, 12000], [1, 12000]], '故障恢复后的成功轮次不增加等待');
});

test('操作意图保存失败不会调用付费提交，持续磁盘异常也遵守轮次节流', async t => {
  const f = fixture(t), save = f.store.save.bind(f.store); let broken = false, failedSaves = 0;
  // 在真实 Store 的提交意图保存边界模拟磁盘故障，后续错误记录也无法保存。
  t.mock.method(f.store, 'save', () => {
    broken ||= f.task.operation?.stage === 'intent';
    if (broken) { failedSaves++; throw new Error('合成磁盘写入失败'); }
    save();
  });
  await assert.rejects(f.engine.tick(), /合成磁盘写入失败/);
  assert.equal(f.submissions, 0); assert.equal(f.engine.busy, false);
  const firstFailures = failedSaves;
  await f.engine.tick();
  assert.equal(failedSaves, firstFailures, '失败后同一时刻不能再次执行轮次');
  f.advance(500);
  await assert.rejects(f.engine.tick(), /合成磁盘写入失败/);
  assert.ok(failedSaves > firstFailures); assert.equal(f.submissions, 0);
});
