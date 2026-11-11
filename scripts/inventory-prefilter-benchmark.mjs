import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { REGIONS } from '../src/config.mjs';
import { readAutodlInventory, inventoryRegions, catalogRegionHasNoStock, readTaskGpuCatalogApi } from '../src/adapters/autodl-inventory.mjs';

// 用真实页面查询函数和本地合成 fetch 比较“上一轮串行早停”与“本轮并发 2”。
// VM 没有真实 fetch、浏览器资料或账号；每次只使用人工延迟和虚构的目录数据。
const requestLatencyMs = 100, model = 'RTX 4090';
const regionRows = REGIONS.map((region, i) => ({ data_center: String(i), region_name: region, region_sign: String(i) }));
const scenarios = [
  { name: 'first-region-available', firstAvailable: 0 },
  { name: 'third-region-available', firstAvailable: 2 },
  { name: 'slow-first-fast-second-available', firstAvailable: 1, firstRegionMs: 800 },
  { name: 'all-zero', firstAvailable: -1 },
];

function fixture(scenario) {
  const stats = { requests: 0, peakConcurrent: 0, cancelled: 0, active: 0 };
  const values = { token: 'synthetic-token', user: '{}', app_version: '{"version":"synthetic"}' };
  const context = vm.createContext({ URL, AbortController, AbortSignal,
    location: { origin: 'https://www.autodl.com' },
    localStorage: { getItem: key => values[key] ?? null },
    fetch: (address, options) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://www.autodl.com');
      assert.ok(['/api/v1/region/list', '/api/v1/machine/region/gpu_type'].includes(url.pathname), '合成环境仅允许目录读取');
      const regionRequest = url.pathname.endsWith('/region/list');
      const index = regionRequest ? null : Number(JSON.parse(options.body).region_sign_list[0]);
      const delay = index === 0 ? scenario.firstRegionMs ?? requestLatencyMs : requestLatencyMs;
      stats.requests++; stats.active++; stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.active);
      return new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = aborted => {
          if (settled) return;
          settled = true; clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); stats.active--;
          if (aborted) { stats.cancelled++; reject(options.signal.reason); return; }
          const data = regionRequest ? regionRows
            : [{ [model]: { idle_gpu_num: index === scenario.firstAvailable ? 1 : 0, total_gpu_num: 8 } }];
          resolve(new Response(JSON.stringify({ code: 'Success', data }), { status: 200 }));
        };
        const onAbort = () => finish(true);
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) finish(true);
        else timer = setTimeout(() => finish(false), delay);
      });
    },
  });
  const adapter = { session: { state: 'ready' }, setSession(state) { this.session.state = state; },
    page: { isClosed: () => false, url: () => 'https://www.autodl.com/create',
      async evaluate(fn, input) {
        context.input = input;
        const result = await vm.runInContext(`(${fn.toString()})(input)`, context);
        return JSON.parse(JSON.stringify(result));
      },
    },
  };
  return { adapter, stats };
}

// 对照组严格重现上一轮按地区读取、首个非明确零即停止的路径；不拿全量看板查询作对照。
async function serialEarlyStop(adapter) {
  const groups = inventoryRegions(await readAutodlInventory(adapter, 'regions'), REGIONS), rows = [];
  for (const group of groups) {
    const data = await readAutodlInventory(adapter, 'gpus', { region_sign_list: group.signs });
    // 夹具保证非负整数库存；两组经过同一个真实页面读取和白名单投影。
    const row = { region: group.region, models: data.flatMap(item => Object.entries(item)
      .map(([name, stock]) => ({ model: name, available: stock.idle_gpu_num, total: stock.total_gpu_num }))) };
    rows.push(row);
    if (!catalogRegionHasNoStock(row, model)) break;
  }
  return { regions: rows };
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const scenario of scenarios) {
  const samples = { serial: [], parallel: [] };
  for (let sample = 0; sample < 3; sample++) for (const mode of ['serial', 'parallel']) {
    const f = fixture(scenario), started = performance.now();
    const result = mode === 'serial' ? await serialEarlyStop(f.adapter)
      : await readTaskGpuCatalogApi(f.adapter, REGIONS, model);
    const elapsedMs = performance.now() - started;
    assert.equal(f.stats.active, 0, '返回时必须已完成或取消本批请求');
    assert.ok(f.stats.peakConcurrent <= (mode === 'serial' ? 1 : 2), '实际并发不能超过配置');
    if (scenario.firstAvailable === -1) {
      assert.equal(result.regions.length, REGIONS.length, '全部无卡需要完整地区证据');
      assert.ok(result.regions.every(row => catalogRegionHasNoStock(row, model)));
    } else assert.ok(result.regions.some(row => row.region === REGIONS[scenario.firstAvailable]
      && !catalogRegionHasNoStock(row, model)), '两组都必须读到本场景有卡的地区');
    samples[mode].push({ elapsedMs, ...f.stats });
  }
  const summary = Object.fromEntries(Object.entries(samples).map(([mode, measured]) => [mode, {
    medianMs: Math.round(median(measured.map(sample => sample.elapsedMs))),
    medianRequests: median(measured.map(sample => sample.requests)),
    peakConcurrent: Math.max(...measured.map(sample => sample.peakConcurrent)),
    medianCancelled: median(measured.map(sample => sample.cancelled)),
    remainingActive: Math.max(...measured.map(sample => sample.active)),
  }]));
  results.push({ scenario: scenario.name, firstRegionMs: scenario.firstRegionMs ?? requestLatencyMs, ...summary });
}
const report = { synthetic: true, baseline: 'serial-early-stop', candidate: 'bounded-parallel-2',
  requestLatencyMs, samples: 3, regions: REGIONS.length, results };
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('inventory-prefilter-benchmark.json', output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('纯合成比较，不代表真实抢卡耗时或成功率；实际计时受电脑负载影响，不设置绝对性能通过阈值。');
