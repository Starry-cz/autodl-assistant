import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostRow,parseInstanceRow,parseQuoteText } from '../src/adapters/dom.mjs';
// 以下全部是隔离的合成测试数据，不对应真实账号或交易。
test('Element 表格解析活动价格而不是划线原价',()=>{
  const row={id:'synthetic-host',disabled:false,cells:['','测试922机','RTX 4090\n24GB','1 / 8','CPU：25核\n内存：90GB','合成CPU','数据盘：50GB\n可扩容：220GB','驱动：550.1 CUDA：12.8','￥1.98 /时\n￥2.08/时']};
  const host=parseHostRow(row,'北京B区');
  assert.equal(host.price,1.98);assert.equal(host.available,1);assert.equal(host.expandableGB,220);assert.equal(host.gpuModel,'RTX 4090');
});
test('未知驱动CUDA占位保持未知；不伪造默认价格',()=>{
  const host=parseHostRow({id:'synthetic-host',cells:['RTX 4090\n24GB','0 / 8','可扩容：0GB','驱动：- CUDA：99']},'北京B区');
  assert.equal(host.driver,'-');assert.equal(host.maxCuda,'99');assert.equal(host.price,null);
});
test('主机身份格以A系列外形开头时，不与真实GPU型号形成歧义',()=>{
  const id='a1bc22de33';
  const host=parseHostRow({id,cells:[id,'合成170机','Tesla T4\n16GB','0 / 4','CPU：8核\n内存：56GB',
    '合成CPU','数据盘：50GB\n可扩容：200GB','驱动：550.90.07\nCUDA：12.4','￥0.78/时\n￥0.82/时']},'佛山区','Tesla T4');
  assert.equal(host.gpuModel,'Tesla T4');
  assert.equal(host.available,0);
  assert.equal(host.price,0.78);
});
test('实例解析数量、停机、运行和释放倒计时',()=>{
  const i=parseInstanceRow('北京B区 / 999机 synthetic001-abcdef01\n已关机\nRTX 4090 * 1卡\n14天01小时55分后释放');
  assert.equal(i.id,'synthetic001-abcdef01');assert.equal(i.gpuCount,1);assert.equal(i.stopped,true);assert.equal(i.running,false);assert.equal(i.releaseDays,14);
  assert.equal(parseInstanceRow('无真实实例'),null);
});
test('不能把无卡运行当GPU开机，也不把复制失败当成功',()=>{
  const common='北京B区 synthetic001-abcdef01 RTX 4090 * 1卡';
  assert.equal(parseInstanceRow(common+'运行中（无卡模式）').running,false);
  assert.equal(parseInstanceRow(common+'运行中 数据盘复制失败').copyFailed,true);
  assert.equal(parseInstanceRow(common+'运行中 数据盘复制完成').copyComplete,true);
  assert.equal(parseInstanceRow(common+'开机中').running,false);
});
test('结算费用跨换行可解析，未找到则保持null',()=>{
  assert.deepEqual(parseQuoteText('日常费用： ￥ 1.46 /日\n配置费用： ￥ 1.98 /时'),{hourly:1.98,storageDaily:1.46});
  assert.deepEqual(parseQuoteText('加载中'),{hourly:null,storageDaily:null});
});

