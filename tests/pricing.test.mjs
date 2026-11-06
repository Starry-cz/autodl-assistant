import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig as normalizeConfig } from './fixtures/config.mjs';
import { candidateReasons, verifyQuote, assessCudaCompatibility, cudaCompatible } from '../src/matching.mjs';
import { previewPricing, pricingKey } from '../src/pricing.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
const config=(extra={})=>normalizeConfig({gpuModel:'RTX 4090',pricePolicy:'official',...extra});
test('CUDA 12.8遇到13.0驱动覆盖门槛，12.6仅条件兼容且自动匹配拒绝',()=>{
  assert.equal(assessCudaCompatibility('13.0','12.8').state,'driver_supported');assert.equal(cudaCompatible('13.0','12.8'),true);
  assert.equal(assessCudaCompatibility('12.6','12.8').state,'conditional');assert.equal(cudaCompatible('12.6','12.8'),false);
  assert.equal(assessCudaCompatibility('11.8','12.8').state,'unsupported');assert.equal(assessCudaCompatibility('unknown','12.8').state,'unknown');
});
test('官方策略不使用预设上限，仍拒绝未知价格和磁盘日费；旧任务上限仍生效',async()=>{
  const adapter=new SyntheticAdapter(),c=config(),t={config:c,attempts:99},o=await adapter.probe(t),q=await adapter.prepare(t,o.hosts[0]);q.host.price=10;q.hourly=10;q.storageDaily=20;
  assert.equal(c.maxGpuHourly,null);assert.deepEqual(verifyQuote(q,c),[]);assert.ok(verifyQuote({...q,hourly:null},c).length);assert.ok(verifyQuote({...q,storageDaily:null},c).length);assert.ok(candidateReasons({...q.host,price:NaN},c).length);
  const old=config({pricePolicy:'limits'});assert.ok(candidateReasons(q.host,old).includes('价格不符'));assert.ok(verifyQuote(q,old).length);
});
test('报价预览只探测配置，不提交；来源标识与配置覆盖数据盘和镜像',async()=>{
  const adapter=new SyntheticAdapter();adapter.submit=()=>{throw Error('预览禁止提交');};const c=config({mode:'clone'}),p=await previewPricing(adapter,c,{clock:()=>1234});assert.equal(p.checkedAt,1234);assert.equal(p.source,'AutoDL 官方页面');assert.equal(p.quote.hourly,1.98);assert.equal(p.quote.storageDaily,0.66);
  assert.notEqual(pricingKey(c),pricingKey(config({mode:'clone',copyDataDisk:false})));assert.notEqual(pricingKey(c),pricingKey({...c,cuda:'12.8'}));
});
test('无库存仅显示已读主机单价，不生成配置总价或磁盘日费',async()=>{
  const adapter=new SyntheticAdapter(),probe=adapter.probe.bind(adapter);adapter.probe=async t=>{const o=await probe(t);o.hosts[0].available=0;return o;};adapter.prepare=()=>{throw Error('无库存禁止准备');};const p=await previewPricing(adapter,config());assert.equal(p.quote,null);assert.equal(p.listed[0].price,1.98);assert.equal(p.available,false);
});
test('完整报价的资源、镜像证据、复制选项或费用无效时不能成为有效预览',async()=>{
  for(const patch of [{imageVerified:false},{gpuCount:2},{storageDaily:null},{hourly:0}]){const adapter=new SyntheticAdapter(),prepare=adapter.prepare.bind(adapter);adapter.prepare=async(...args)=>({...await prepare(...args),...patch});await assert.rejects(previewPricing(adapter,config()),e=>['PRICE_CONFIG','PRICE_UNKNOWN'].includes(e.code));}
});


test('无库存、条件不匹配与未读取到主机分别返回原因，不伪造完整报价',async()=>{
  for(const kind of ['no_stock','no_match','empty']){
    const adapter=new SyntheticAdapter(),probe=adapter.probe.bind(adapter);
    adapter.probe=async task=>{const o=await probe(task);if(kind==='empty')o.hosts=[];else if(kind==='no_stock')o.hosts[0].available=0;else o.hosts[0].maxCuda='11.8';return o;};
    adapter.prepare=()=>{throw Error('不匹配资源不能进入结算配置');};
    const p=await previewPricing(adapter,config());assert.equal(p.availability.status,kind);assert.equal(p.quote,null);assert.equal(p.available,false);
    assert.equal(p.availability.scannedHosts,kind==='empty'?0:1);
    if(kind==='no_stock'){assert.equal(p.availability.matchingHosts,1);assert.ok(p.availability.reasons.some(r=>r.reason==='库存不足'));}
    if(kind==='no_match'){assert.equal(p.listed.length,0);assert.ok(p.availability.reasons.some(r=>/CUDA/.test(r.reason)));}
  }
});
test('配置页面未返回报价时明确报读取失败，不冒充无库存',async()=>{
  const adapter=new SyntheticAdapter();adapter.prepare=async()=>null;
  await assert.rejects(previewPricing(adapter,config()),e=>e.code==='PRICE_UNKNOWN');
});

