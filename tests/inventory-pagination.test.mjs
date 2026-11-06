import test from 'node:test';
import assert from 'node:assert/strict';
import { readInventoryInPage, readMarketHostsApi } from '../src/adapters/autodl-inventory.mjs';

// 用内存响应复现分页边界，不访问平台，也不读取真实浏览器资料。
const host = id => ({ machine_id: 'synthetic-' + id, gpu_name: 'RTX 4090', region_sign: 'synthetic-bj',
  gpu_number: 8, gpu_idle_num: 0, on_line: 2, max_instance_num: 80, binding_instance_num: 1, machine_sku_info: [] });
function fixture(pageData) {
  const pages = [];
  const adapter = { session: { state: 'ready' }, page: { isClosed: () => false,
    url: () => 'https://www.autodl.com/create', evaluate: async (fn, { kind, params }) => {
      assert.equal(fn, readInventoryInPage);
      if (kind === 'regions') return { data: [{ data_center: 'synthetic-center', region_name: '北京B区', region_sign: 'synthetic-bj' }] };
      if (kind === 'membership') return { data: { member_level: 'normal_user' } };
      assert.equal(kind, 'hosts'); pages.push(params.page_index);
      const data = pageData(params.page_index);
      assert.ok(data, '不能越过合成的最后一页');
      return { data };
    } } };
  return { pages, read: options => readMarketHostsApi(adapter, { region: '北京B区' }, options) };
}

test('已知 max_page 时，缺失总数的短页仍读取后续页', async () => {
  const f = fixture(page => ({ list: [host(page)], max_page: 2 }));
  const result = await f.read({ pageSize: 90 });
  assert.deepEqual(f.pages, [1, 2]); assert.equal(result.complete, true); assert.equal(result.rows.length, 2);
});

test('已读数量提前达到总数而页数仍有剩余时继续读，并标记冲突', async () => {
  const f = fixture(page => ({ list: [host(page)], result_total: 1, max_page: 2 }));
  const result = await f.read();
  assert.deepEqual(f.pages, [1, 2]); assert.equal(result.complete, false); assert.equal(result.rows.length, 2);
  assert.match(result.note, /未能完整确认/);
});

test('到达已知末页但未读足总数，不继续猜页也不宣称完整', async () => {
  const f = fixture(() => ({ list: [host(1)], result_total: 2, max_page: 1 }));
  const result = await f.read();
  assert.deepEqual(f.pages, [1]); assert.equal(result.complete, false);
});

test('已知分页提前或在末页变空均保留部分结果', async () => {
  for (const maxPage of [2, 3]) {
    const f = fixture(page => ({ list: page === 1 ? [host(1)] : [], max_page: maxPage }));
    const result = await f.read();
    assert.deepEqual(f.pages, [1, 2]); assert.equal(result.rows.length, 1); assert.equal(result.complete, false);
  }
});

test('页数增长或缩减意味着分页快照变化，读取所得不标完整', async () => {
  for (const pageCounts of [[2, 3, 3], [3, 2]]) {
    const f = fixture(page => ({ list: [host(page)], max_page: pageCounts[page - 1] }));
    const result = await f.read();
    assert.equal(result.pages, pageCounts.length); assert.equal(result.complete, false);
  }
});

test('初次空目录接受 0 或 1 个总页数，非空的 0 页响应为部分结果', async () => {
  for (const maxPage of [0, 1]) {
    const f = fixture(() => ({ list: [], result_total: 0, max_page: maxPage }));
    assert.equal((await f.read()).complete, true); assert.deepEqual(f.pages, [1]);
  }
  const f = fixture(() => ({ list: [host(1)], max_page: 0 }));
  assert.equal((await f.read()).complete, false);
});

test('总数和末页都未知时，短页或最终空页才结束', async () => {
  const short = fixture(() => ({ list: [host(1)] }));
  assert.equal((await short.read({ pageSize: 2 })).complete, true); assert.deepEqual(short.pages, [1]);
  const empty = fixture(page => ({ list: page === 1 ? [host(1)] : [] }));
  assert.equal((await empty.read({ pageSize: 1 })).complete, true); assert.deepEqual(empty.pages, [1, 2]);
});

test('仅总数已知时，短页不足总数继续读取到精确数量', async () => {
  const f = fixture(page => ({ list: [host(page)], result_total: 2 }));
  const result = await f.read({ pageSize: 90 });
  assert.deepEqual(f.pages, [1, 2]); assert.equal(result.complete, true);
});

test('已知末页大于读取上限时显示部分结果', async () => {
  const f = fixture(page => ({ list: [host(page)], max_page: 3 }));
  const result = await f.read({ maxPages: 2 });
  assert.deepEqual(f.pages, [1, 2]); assert.equal(result.complete, false); assert.match(result.note, /2 页读取上限/);
});
