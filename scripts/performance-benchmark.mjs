import { performance } from 'node:perf_hooks';
import { Engine } from '../src/engine.mjs';
import { normalizeConfig } from '../src/config.mjs';

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
