import test from 'node:test';
import assert from 'node:assert/strict';
import { marketHostQuery } from '../src/adapters/autodl-market.mjs';
import { REGIONS } from '../src/config.mjs';

// 查询参数边界与读取实现分离；库存行为已迁移到 inventory-api.test.mjs。
test('至少限定型号或地区，不对整个市场意外扫描', () => {
  for (const query of [{}, {model:' ',region:''}, {model:42}, {region:false}, {model:'x'.repeat(121)},
    { model: 'RTX 4090', region: '不支持地区' }])
    assert.throws(() => marketHostQuery(query), error => error.code === 'CONFIG');
  assert.deepEqual(marketHostQuery({ model: ' RTX 4090 ', region: '北京B区' }), { model: 'RTX 4090', region: '北京B区' });
  assert.deepEqual(marketHostQuery({model:'RTX 4090'}),{model:'RTX 4090',region:''});
  for (const region of REGIONS) assert.deepEqual(marketHostQuery({region}),{model:'',region});
});
