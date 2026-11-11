import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { testConfig } from './fixtures/config.mjs';
import { gate } from './helpers.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

// 预筛内部两路读取使用显式屏障；服务、锁、暂停和关闭均走真实代码，不启动浏览器或外部请求。
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-parallel-isolation-'));
  const adapter = new SyntheticAdapter(), started = gate(), lanes = [gate(), gate()];
  const calls = { probes: 0, readers: 0, peakReaders: 0, prepares: 0, submits: 0, refreshes: 0, logouts: 0, closes: 0 };
  const probe = adapter.probe.bind(adapter), prepare = adapter.prepare.bind(adapter), submit = adapter.submit.bind(adapter);
  Object.assign(adapter, {
    sessionStatus: () => ({ state: 'ready', browserOpen: true }),
    probe: async task => {
      calls.probes++;
      if (calls.probes === 1) {
        await Promise.all(lanes.map(async lane => {
          calls.readers++; calls.peakReaders = Math.max(calls.peakReaders, calls.readers);
          if (calls.readers === 2) started.resolve();
          try { await lane.promise; } finally { calls.readers--; }
        }));
      }
      return probe(task);
    },
    prepare: async (...args) => {
      assert.equal(calls.readers, 0, '所有读取已结束才能导航和准备表单');
      calls.prepares++; return prepare(...args);
    },
    submit: async (...args) => {
      assert.equal(calls.readers, 0, '并行读取不能与提交共享未结束批次');
      calls.submits++; return submit(...args);
    },
    marketHosts: async () => { calls.refreshes++; return { rows: [], complete: true, checkedAt: Date.now() }; },
    logout: async () => { calls.logouts++; return { session: { state: 'not_open', browserOpen: false } }; },
    close: async () => { calls.closes++; },
  });
  const forbidden = async () => { throw Error('隔离测试禁止外部请求'); };
  const app = createApplication({ runtimeDir: dir, startEngine: false, adapters: { autodl: adapter },
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden }, updatesOptions: { fetchImpl: forbidden } });
  await app.ready;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    lanes.forEach(lane => lane.resolve());
    await app.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-parallel-isolation-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const task = app.store.create(testConfig({ action: 'execute', paidConsent: true }));
  const request = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'X-Local-Token': app.token,
      'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, task, calls, lanes, entered: started.promise, request };
}

test('预筛两路并行期间，其他任务及用户刷新/退出不能同时占用工作页面', async t => {
  const f = await fixture(t);
  const first = f.app.engine.tick(); await f.entered;
  const second = f.app.store.create(testConfig({ action: 'execute', paidConsent: true }));
  await f.app.engine.tick();
  assert.equal(f.calls.peakReaders, 2); assert.equal(f.calls.probes, 1);
  for (const [route, body] of [['/api/market/hosts', { model: 'RTX 4090' }], ['/api/browser/logout', {}]]) {
    const result = await f.request(route, body);
    assert.equal(result.status, 409); assert.equal(result.body.error, 'BUSY');
  }
  assert.equal(f.calls.refreshes, 0); assert.equal(f.calls.logouts, 0);
  f.lanes[0].resolve(); await turn();
  assert.equal(f.calls.readers, 1); assert.equal(f.calls.prepares, 0); assert.equal(f.app.engine.busy, true);
  f.lanes[1].resolve(); await first;
  assert.equal(f.calls.prepares, 1); assert.equal(f.calls.submits, 1); assert.equal(second.attempts, 0);
  await f.app.engine.tick();
  assert.equal(f.calls.probes, 2); assert.equal(f.calls.submits, 2);
  assert.ok(f.task.operation.receipt.instanceId); assert.ok(second.operation.receipt.instanceId);
  assert.notEqual(f.task.operation.receipt.instanceId, second.operation.receipt.instanceId);
});

test('两路预筛未完成时暂停任务，迟到的候选不会进入准备或付费提交', async t => {
  const f = await fixture(t), checking = f.app.engine.tick(); await f.entered;
  assert.equal((await f.request(`/api/tasks/${f.task.id}/pause`)).status, 200);
  f.lanes.forEach(lane => lane.resolve()); await checking;
  assert.equal(f.task.state, 'paused'); assert.equal(f.task.monitor.checking, false);
  assert.equal(f.calls.prepares, 0); assert.equal(f.calls.submits, 0); assert.equal(f.task.operation, null);
  assert.equal(f.app.engine.busy, false);
});

test('后台正常关闭等待已开始的读取批次收尾，再关闭浏览器且不继续准备', async t => {
  const f = await fixture(t), checking = f.app.engine.tick(); await f.entered;
  let closed = false;
  const closing = f.app.close().then(() => { closed = true; }); await turn();
  assert.equal(f.app.engine.stopping, true); assert.equal(closed, false); assert.equal(f.calls.closes, 0);
  f.lanes[0].resolve(); await turn();
  assert.equal(f.calls.readers, 1); assert.equal(f.calls.closes, 0);
  f.lanes[1].resolve(); await Promise.all([checking, closing]);
  assert.equal(closed, true); assert.equal(f.calls.closes, 1);
  assert.equal(f.calls.prepares, 0); assert.equal(f.calls.submits, 0); assert.equal(f.task.operation, null);
  assert.equal(f.task.monitor.checking, false);
});
