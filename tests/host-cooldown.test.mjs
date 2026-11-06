import test from 'node:test';
import assert from 'node:assert/strict';
import { coolHost, isCooled, activeCooldowns, cooldownNote, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS } from '../src/host-cooldown.mjs';
// 纯函数：按任务记录被平台拒绝下单的主机，暂时不选。合成主机，不访问平台。
const host = { id: 'synthetic-host-311', number: '311机', region: '北京B区' };
const storage = '平台拒绝创建：“当前主机存储库存已满，请更换其它主机或联系客服处理后创建”；两次核对实例列表均无新实例';
test('存储、维护等原因：这台主机 30 分钟内不选，原因取平台原文', () => {
  const { list, record } = coolHost([], host, storage, 1000);
  assert.equal(record.until - 1000, COOLDOWN_MAX_MS); assert.equal(record.reason, '当前主机存储库存已满，请更换其它主机或联系客服处理后创建');
  assert.equal(isCooled(list, host, 1000 + COOLDOWN_MAX_MS - 1), true); assert.equal(isCooled(list, host, 1000 + COOLDOWN_MAX_MS), false);
  for (const text of ['服务器下架维护', '镜像的CUDA版本高于主机支持的最高CUDA版本，将导致无法开机', '该主机暂时不支持，请更换其他主机'])
    assert.equal(coolHost([], host, text, 0).record.until, COOLDOWN_MAX_MS, text);
});
test('已租满、没有识别出结果等：从 2 分钟起，同一台再被拒绝时加倍，最长 30 分钟', () => {
  let list = [], at = 0;
  const durations = [];
  for (let i = 0; i < 6; i++) { const result = coolHost(list, host, '平台拒绝创建：“该主机已租满，请更换主机重新创建实例”', at); list = result.list; durations.push(result.record.until - at); at = result.record.until; }
  assert.deepEqual(durations.map(ms => ms / 60000), [2, 4, 8, 16, 30, 30]); assert.equal(COOLDOWN_BASE_MS, 2 * 60000);
  assert.equal(list.length, 1);
});
test('按主机 ID 或“同地区的主机编号”识别同一台；其他主机、其他地区的同号主机不受影响', () => {
  const { list } = coolHost([], host, storage, 0);
  assert.equal(isCooled(list, { id: 'synthetic-host-311' }, 1), true);
  assert.equal(isCooled(list, { number: '311机', region: '北京B区' }, 1), true);
  assert.equal(isCooled(list, { id: 'synthetic-host-312', number: '312机', region: '北京B区' }, 1), false);
  assert.equal(isCooled(list, { number: '311机', region: '西北B区' }, 1), false);
  assert.equal(isCooled(list, {}, 1), false);
  assert.equal(coolHost(list, {}, storage, 1).record, null);
});
test('只保留最近一小时内的记录且最多 20 条；提示写明哪台、约几分钟后再试和原因', () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = coolHost(list, { id: 'h' + i, number: i + '机', region: '北京B区' }, '合成：已租满', i).list;
  assert.equal(list.length, 20); assert.equal(list[0].hostId, 'h24');
  const later = coolHost(list, host, storage, 2 * 3600000).list;
  assert.deepEqual(later.map(r => r.hostId), ['synthetic-host-311']);
  assert.equal(activeCooldowns(later, 2 * 3600000 + 60000).length, 1);
  assert.match(cooldownNote(later, 2 * 3600000 + 60000), /311机（约 29 分钟后再试，原因：当前主机存储库存已满/);
  assert.equal(cooldownNote([], 0), '');
});

