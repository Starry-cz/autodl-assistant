import test from 'node:test';
import assert from 'node:assert/strict';
import { readInstanceRowElements, parseInstanceRow } from '../src/adapters/dom.mjs';

// 只模拟公开实例表的节点关系；备注即使包含另一实例 ID，也不是身份字段。
test('实例主键按表头对应的独立复制节点读取，忽略备注与其他列中的 ID', () => {
  const node = (text, cursor = '') => ({ innerText: text, style: { cursor }, childElementCount: 0 });
  const cells = [
    { querySelectorAll: () => [node('wrong001-abcdef01', 'pointer')] },
    { querySelectorAll: () => [node('actual01-abcdef01', 'pointer'), node('target01-abcdef01')] },
  ];
  const row = {
    innerText: 'wrong001-abcdef01\nactual01-abcdef01\ntarget01-abcdef01\n北京B区\nRTX 4090 × 1\n已关机',
    closest: () => ({ querySelectorAll: () => [{ innerText: '配置' }, { innerText: '实例ID /名称' }] }),
    querySelectorAll: () => cells,
  };
  const [raw] = readInstanceRowElements([row]);
  assert.equal(raw.instanceId, 'actual01-abcdef01');
  assert.equal(raw.identityColumn, 1);
  assert.deepEqual(parseInstanceRow(raw.text, '', raw.instanceId).ids, ['actual01-abcdef01']);
  // 同一身份列存在两个可复制主键时不能擅自选第一项。
  cells[1].querySelectorAll = () => [node('actual01-abcdef01', 'pointer'), node('target01-abcdef01', 'pointer')];
  assert.equal(readInstanceRowElements([row])[0].instanceId, '');
});
