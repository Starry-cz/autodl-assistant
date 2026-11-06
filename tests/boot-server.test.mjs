import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';

const requestConfig = (extra = {}) => ({
  provider: 'autodl', mode: 'boot', sourceId: 'synthetic-source',
  gpuModel: 'RTX 4090', gpuCount: 1, regions: ['北京B区'],
  action: 'execute', paidConsent: true, pollSeconds: 10, timeoutMinutes: 60,
  name: '合成原实例开机任务', ...extra,
});

// 测试只启动本机 HTTP 服务；实例、会话及开机回执全部来自内存合成适配器。
async function fixture(t, source = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-boot-http-'));
  const row = { id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090',
    gpuCount: 1, stopped: true, running: false, cardless: false,
    starting: false, gpuAvailable: true, ...source };
  const adapter = Object.assign(new SyntheticAdapter(), {
    instances: async () => [row],
    inspectBoot: async () => ({ ...row }),
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '合成会话' }),
  });
  let bootCalls = 0;
  adapter.boot = async (_task, mark) => {
    mark(); bootCalls++;
    Object.assign(row, { stopped: false, starting: true });
    return {};
  };
  let createCalls = 0;
  // 开机任务不能误入新建、报价或克隆链路。
  for (const method of ['probe', 'prepare', 'submit']) adapter[method] = async () => {
    createCalls++; throw Error('原实例开机不应调用新建流程');
  };
  const forbidden = async () => { throw Error('本测试不允许外部请求'); };
  const app = createApplication({ runtimeDir: dir, adapters: { autodl: adapter }, startEngine: false,
    aiOptions: { fetchImpl: forbidden }, walletOptions: { fetchImpl: forbidden } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, data) => fetch(base + url, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Local-Token': app.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  t.after(async () => {
    await app.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-boot-http-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { app, adapter, row, request, get createCalls() { return createCalls; }, get bootCalls() { return bootCalls; } };
}

test('HTTP 原实例开机无需镜像、CUDA、新租报价和余额 Token', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/tasks', requestConfig());
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.task.config.mode, 'boot');
  assert.equal(data.task.config.sourceId, f.row.id);
  assert.deepEqual(data.task.config.imagePath, []);
  assert.equal(data.task.config.balanceGuard, false);
  assert.equal(data.task.operation, null);
  assert.equal(f.createCalls, 0);
});

test('HTTP 原实例开机须确认费用，未确认时不落任务', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/tasks', requestConfig({ paidConsent: false }));
  assert.equal(response.status, 400);
  assert.equal(f.app.store.tasks().length, 0);
});

test('HTTP 无卡运行实例不能被任务自动关机再抢卡', async t => {
  const f = await fixture(t, { stopped: false, running: false, cardless: true });
  const response = await f.request('/api/tasks', requestConfig());
  const data = await response.json();
  assert.equal(response.status, 409, JSON.stringify(data));
  assert.match(data.message, /无卡|关机/);
  assert.equal(f.app.store.tasks().length, 0);
  assert.equal(f.createCalls, 0);
});

test('HTTP 开机按实例身份去重，并拒绝不存在或配置不符的目标', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/tasks', requestConfig({ sourceId: 'synthetic-missing' }))).status, 409);
  assert.equal((await f.request('/api/tasks', requestConfig({ gpuCount: 2 }))).status, 409);
  assert.equal((await f.request('/api/tasks', requestConfig())).status, 201);
  assert.equal((await f.request('/api/tasks', requestConfig({ name: '同实例重复任务' }))).status, 409);
  assert.equal(f.app.store.tasks().length, 1);
});

test('HTTP 暂停、恢复和停止开机任务不改变云端实例状态', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/tasks', requestConfig());
  const { task } = await response.json();
  assert.equal(response.status, 201);
  for (const [action, state] of [['pause', 'paused'], ['resume', 'watching'], ['cancel', 'cancelled']]) {
    const result = await f.request(`/api/tasks/${task.id}/${action}`, {});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).task.state, state);
  }
  assert.equal(f.row.stopped, true);
  assert.equal(f.createCalls, 0);
});

test('HTTP 实例同步提供原实例开机可用性及无卡原因', async t => {
  const f = await fixture(t);
  let response = await f.request('/api/autodl/instances', {});
  assert.equal(response.status, 200);
  let [instance] = (await response.json()).instances;
  assert.equal(instance.bootable, true);
  assert.equal(instance.gpuAvailable, true);
  Object.assign(f.row, { stopped: false, running: false, cardless: true });
  response = await f.request('/api/autodl/instances', {});
  [instance] = (await response.json()).instances;
  assert.equal(instance.bootable, false);
  assert.match(instance.bootReason, /无卡/);
});

test('HTTP 建立的原实例任务只开机一次，查询确认 GPU 运行后完成', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/tasks', requestConfig());
  const { task: created } = await response.json();
  assert.equal(response.status, 201);
  const task = f.app.store.get(created.id);
  await f.app.engine.step(task);
  assert.equal(f.bootCalls, 1);
  assert.equal(task.state, 'verifying');
  await f.app.engine.step(task);
  assert.equal(f.bootCalls, 1);
  assert.notEqual(task.state, 'completed');
  Object.assign(f.row, { starting: false, running: true, stopped: false });
  await f.app.engine.step(task);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.tasks[0].state, 'completed');
  assert.equal(f.bootCalls, 1);
  assert.equal(f.createCalls, 0);
});
