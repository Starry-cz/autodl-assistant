import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMarket, Market } from '../src/market.mjs';
import { SYNTHETIC_GPU_CATALOG } from './fixtures/gpu-catalog.mjs';

const fixture = () => structuredClone(SYNTHETIC_GPU_CATALOG);

test('按地区型号汇总目录库存，型号后缀不同不合并，不产生主机数量', () => {
  const data = aggregateMarket(fixture());
  assert.equal(data.complete, true);
  assert.equal(data.summary.available, 11);
  assert.equal(data.summary.total, 96);
  assert.equal(data.summary.modelCount, 6);
  assert.equal(data.summary.regionCount, 6);
  assert.equal(data.models.find(row => row.model === 'RTX 4090').total, 40);
  assert.equal(data.models.find(row => row.model === 'RTX 4090D').total, 8);
  assert.equal(data.models.find(row => row.model === 'A100').total, 8);
  assert.equal(data.models.find(row => row.model === 'A100 80GB').total, 16);
  assert.equal(data.summary.machineCount, undefined);
  assert.match(data.scope, /非去重物理总量/);
});

test('同地区格式别名只计一次，跨地区相同型号按目录相加', () => {
  const catalog = fixture();
  catalog.regions[0].models.push({ model: 'rtx-4090', available: 2, total: 8 });
  const data = aggregateMarket(catalog);
  assert.equal(data.models.find(row => row.key === 'RTX4090').available, 3);
  assert.equal(data.summary.available, 11);
});

test('缺失地区与缺失数字不充作零，总量未知但已知小计保留', () => {
  const catalog = fixture();
  catalog.regions[0].models[0].available = null;
  catalog.regions[1] = { region: catalog.regions[1].region, models: [], error: '合成读取失败' };
  const data = aggregateMarket(catalog);
  assert.equal(data.complete, false);
  assert.equal(data.summary.available, null);
  assert.equal(data.summary.total, null);
  assert.equal(data.summary.availabilityPct, null);
  assert.equal(data.summary.knownAvailable, 6);
  assert.equal(data.summary.knownTotal, 72);
  assert.equal(data.issues.length, 2);
  assert.equal(data.heatmap.cells.find(cell => cell.key === 'RTX4090' && cell.region === '北京B区').available, null);
});

test('热力图分清真实零库存、未列型号与矛盾数字', () => {
  const catalog = fixture();
  catalog.regions[0].models[0] = { model: 'RTX 4090', available: 9, total: 8, disabled: false };
  const data = aggregateMarket(catalog);
  const zero = data.heatmap.cells.find(cell => cell.key === 'RTX4090D' && cell.region === '北京B区');
  assert.equal(zero.available, 0); assert.equal(zero.complete, true);
  const absent = data.heatmap.cells.find(cell => cell.key === 'RTX4090D' && cell.region === '佛山区');
  assert.equal(absent.available, null); assert.equal(absent.listed, false);
  const invalid = data.heatmap.cells.find(cell => cell.key === 'RTX4090' && cell.region === '北京B区');
  assert.equal(invalid.available, null); assert.equal(invalid.total, null);
});

test('只有主动成功完整读取产生数值采样，旧目录展示与缺口不制造历史', () => {
  const market = new Market({ clock: () => 3000 });
  const first = fixture(); first.checkedAt = 1000;
  assert.equal(market.publicState(first).history.length, 0);
  market.record(first); market.record(first);
  const second = fixture(); second.checkedAt = 2000; second.regions[0].models[0].available = null;
  market.record(second); market.recordGap('合成查询失败');
  const fourth = fixture(); fourth.checkedAt = 4000;
  market.record(fourth);
  const { history } = market.publicState(fourth);
  assert.equal(history.length, 4);
  assert.deepEqual(history.map(point => point.complete), [true, false, false, true]);
  assert.deepEqual(history.map(point => point.available), [11, null, null, 11]);
  assert.deepEqual(history.map(point => point.at), [1000, 2000, 3000, 4000]);
  history[0].available = 999;
  assert.equal(market.publicState(fourth).history[0].available, 11);
});

test('趋势只留有限本会话样本，清除后不恢复旧历史', () => {
  const market = new Market({ maxSamples: 2 });
  for (const at of [1000, 2000, 3000]) { const catalog = fixture(); catalog.checkedAt = at; market.record(catalog); }
  assert.deepEqual(market.publicState(fixture()).history.map(point => point.at), [2000, 3000]);
  market.clear(); assert.equal(market.publicState(fixture()).history.length, 0);
  assert.equal(aggregateMarket(null), null);
});
