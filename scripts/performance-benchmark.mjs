import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Engine } from '../src/engine.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { testConfig } from '../tests/fixtures/config.mjs';

// 纯合成调度基准：内存任务、即时空库存响应；不读 .runtime、不联网、不创建浏览器或付费实例。
// 对照组重现旧版 500ms setInterval，新版使用 Engine.start；两组使用相同引擎与任务路径。
async function measureScheduler(legacy) {
  const due = Date.now(), starts = [], count = 12;
  const config = normalizeConfig({ provider: 'autodl', action: 'observe', gpuModel: 'RTX 4090',
    imagePath: ['PyTorch', '2.1.0', '3.10(ubuntu22.04)', '12.1'], pollSeconds: 60,
    maxGpuHourly: 3, maxTotalHourly: 4, maxStorageDaily: 5 });
  const tasks = Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index}`, config,
    state: 'watching', nextCheckAt: due, deadlineAt: due + 600000, attempts: 0, errors: 0,
    logs: [], operation: null }));
  const store = { tasks: () => tasks, patch: (task, changes) => Object.assign(task, changes), log() {}, enqueueNotification() {} };
  let finish, reject;
  const completed = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const begin = performance.now();
  const adapter = { probe: async () => {
    starts.push(performance.now() - begin);
    if (starts.length === count) finish();
    return { hosts: [], scope: 'full', complete: true, summary: '合成空库存' };
  } };
  const engine = new Engine(store, { autodl: adapter }, { flush: async () => {} }, { random: () => 0 });
  const timeout = setTimeout(() => reject(new Error('合成调度基准超过 20 秒，未完成全部任务')), 20000);
  let oldTimer;
  try {
    if (legacy) oldTimer = setInterval(() => void engine.tick().catch(reject), 500);
    else engine.start();
    await completed;
    return { scheduler: legacy ? '旧版 500ms 周期' : '新版按到期时间唤醒', tasks: count,
      firstStartMs: +starts[0].toFixed(2), lastStartMs: +starts.at(-1).toFixed(2),
      meanGapMs: +((starts.at(-1) - starts[0]) / (count - 1)).toFixed(2) };
  } finally {
    clearTimeout(timeout); clearInterval(oldTimer); await engine.stop();
  }
}

const results = [await measureScheduler(true), await measureScheduler(false)];
console.table(results);
console.log('仅衡量 12 个同时到期、即时读取任务的本地调度等待；不代表真实网络耗时或抢卡成功率。');
console.log('结果随电脑负载变化，仅用于对比，不作为 CI 的绝对时间阈值。');

// 对两种模式使用相同的库存延迟和候选复核过程，记录“仅提醒”任务真正进入 found 的时刻。
async function measureSecondTask(mode) {
  const due = Date.now();
  const tasks = ['slow', 'fast'].map(id => ({
    id, ownerId:'bench-owner', config:testConfig({pollSeconds:60}), state:'watching',
    nextCheckAt:due, deadlineAt:due+60000, attempts:0, errors:0, logs:[], operation:null,
  }));
  const empty = {hosts:[], scope:'full', complete:true, summary:'合成空库存'};
  let foundAt;
  const store = {
    data:{taskScheduling:{mode}}, tasks:() => tasks, log() {}, enqueueNotification() {},
    patch(task, changes) {
      Object.assign(task, changes);
      if (task.id === 'fast' && changes.state === 'found') foundAt = performance.now();
    },
  };
  const adapter = new SyntheticAdapter();
  const inspect = async task => {
    await sleep(task.id === 'slow' ? 180 : 25);
    return task.id === 'fast';
  };
  const readHost = adapter.probe.bind(adapter);
  adapter.isolatedPrecheck = async task => ({
    verdict:await inspect(task) ? 'candidate' : 'empty', kind:'market', ownerId:task.ownerId, taskId:task.id,
    observation:empty, checkedAt:Date.now(),
  });
  adapter.probe = async (task, {precheck} = {}) => {
    if (!precheck && !await inspect(task)) return empty;
    await sleep(15);
    return readHost(task);
  };
  const engine = new Engine(store, {autodl:adapter}, {flush:async () => {}}, {random:() => 0});
  const start = performance.now();
  try {
    for (let i=0; i<tasks.length && !foundAt; i++) await engine.tick();
    if (!foundAt) throw Error('合成候选未通过核验');
    return foundAt-start;
  } finally { await engine.stop(); }
}
const times = {serial:[], parallel:[]};
for (let run=0; run<7; run++) {
  for (const mode of run%2 ? ['parallel','serial'] : ['serial','parallel']) times[mode].push(await measureSecondTask(mode));
}
console.table(Object.entries(times).map(([mode, samples]) => ({
  mode, samples:samples.length, medianFoundMs:+samples.sort((a,b) => a-b)[3].toFixed(1),
})));
console.log('两个任务同时到期，第一项 180ms 无卡，第二项 25ms 返回候选并额外花 15ms 读取主机。计时到第二项复核完成。');
