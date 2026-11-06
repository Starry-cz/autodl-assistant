import { REGIONS } from './config.mjs';
import { normalizeGpuCatalog } from './gpu-catalog.mjs';
import { gpuKey } from './matching.mjs';

// 这里汇总的是账号可见的型号目录，不含物理主机身份，不能推算主机数或物理去重总量。
const SOURCE_SCOPE = '账号可见的按量计费 GPU 型号目录；非去重物理总量';
const sumKnown = (rows, field) => rows.reduce((sum, row) => sum + (Number.isFinite(row[field]) ? row[field] : 0), 0);
function totals(rows, complete = true) {
  const knownAvailable = sumKnown(rows, 'available'), knownTotal = sumKnown(rows, 'total');
  const available = complete && rows.every(row => row.available !== null) ? knownAvailable : null;
  const total = complete && rows.every(row => row.total !== null) ? knownTotal : null;
  return { available, total, knownAvailable, knownTotal, complete: complete && available !== null && total !== null };
}

export function aggregateMarket(input) {
  const catalog = normalizeGpuCatalog(input);
  if (!catalog) return null;
  const entries = [], regions = [], issues = [];
  for (const region of REGIONS) {
    const row = catalog.regions.find(item => item.region === region);
    const status = !row ? '未读取' : row.error ? '读取失败' : row.missing ? '页面未列出' : row.disabled ? '当前不可选' : !row.models.length ? '未读到型号' : '已读取';
    const readable = status === '已读取';
    const models = (row?.models || []).map(item => {
      // 空闲数大于总数无法解释为可信库存；缺失仍保留未知，不转为零。
      const contradictory = item.available !== null && item.total !== null && item.available > item.total;
      const available = readable && !contradictory ? item.available : null;
      const total = readable && !contradictory ? item.total : null;
      return { key: gpuKey(item.model), model: item.model, region, available, total, disabled: item.disabled,
        complete: available !== null && total !== null, listed: true,
        reason: !readable ? status : contradictory ? '库存数字无法确认' : available === null || total === null ? '目录未提供完整库存数字' : '' };
    });
    const values = totals(models, readable);
    const current = { region, ...values, modelCount: models.length, status: values.complete ? status : readable ? '库存数字未完整' : status };
    regions.push(current); entries.push(...models);
    if (!current.complete) issues.push(region + '：' + current.status);
  }
  const fullCoverage = regions.every(region => region.complete);
  const models = [];
  for (const key of new Set(entries.map(entry => entry.key))) {
    const rows = entries.filter(entry => entry.key === key);
    models.push({ key, model: rows[0].model, ...totals(rows, fullCoverage), regionCount: rows.length });
  }
  models.sort((a, b) => b.knownAvailable - a.knownAvailable || b.knownTotal - a.knownTotal || a.model.localeCompare(b.model));
  const summary = { ...totals(entries, fullCoverage), modelCount: models.length,
    regionCount: regions.filter(region => region.complete).length, expectedRegions: REGIONS.length };
  summary.availabilityPct = summary.complete && summary.total > 0 ? summary.available / summary.total * 100 : null;
  const cells = models.flatMap(model => REGIONS.map(region => entries.find(entry => entry.key === model.key && entry.region === region)
    || { key: model.key, model: model.model, region, available: null, total: null, complete: false, listed: false, disabled: false,
      reason: regions.find(row => row.region === region).complete ? '该地区目录未列出此型号' : '该地区目录未完整读取' }));
  return { checkedAt: catalog.checkedAt, source: catalog.source, scope: SOURCE_SCOPE, complete: summary.complete,
    issues, summary, models, regions, heatmap: { models: models.map(({ key, model }) => ({ key, model })), regions: [...REGIONS], cells } };
}

export class Market {
  constructor({ clock = () => Date.now(), maxSamples = 120 } = {}) {
    this.clock = clock; this.maxSamples = maxSamples; this.clear();
  }
  clear() { this.history = []; this.lastCatalogAt = null; }
  append(point) {
    this.history.push(point);
    this.history = this.history.slice(-this.maxSamples);
  }
  record(catalog) {
    const snapshot = aggregateMarket(catalog);
    if (!snapshot || snapshot.checkedAt === this.lastCatalogAt) return;
    this.lastCatalogAt = snapshot.checkedAt;
    if (!snapshot.complete) { this.recordGap('本次目录未完整读取', snapshot.checkedAt); return; }
    const { available, total, availabilityPct } = snapshot.summary;
    this.append({ at: snapshot.checkedAt, available, total, availabilityPct, complete: true });
  }
  recordGap(reason = '本次同步未完成', at = this.clock()) {
    // 失败只留下缺口标记，没有库存数值；折线必须在这里断开。
    this.append({ at, available: null, total: null, availabilityPct: null, complete: false, reason });
  }
  publicState(catalog) {
    return { snapshot: aggregateMarket(catalog), history: this.history.map(point => ({ ...point })) };
  }
}
