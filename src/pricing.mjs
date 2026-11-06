import { candidateReasons, selectCandidate, verifyQuote } from './matching.mjs';
import { fail } from './errors.mjs';
export const QUOTE_MAX_AGE=60000;
export function pricingKey(c) { return JSON.stringify([c.provider,c.mode,c.gpuModel,c.gpuCount,c.regions,c.cuda,c.sourceId,c.imagePath,c.copyDataDisk,c.extraDiskGB,c.pricePolicy,c.maxGpuHourly,c.maxTotalHourly,c.maxStorageDaily]); }
// 预览只操作配置表单并读取可见报价，绝不调用提交动作。
export async function previewPricing(adapter,config,{clock=()=>Date.now()}={}) {
  const task={id:'price-preview',config,attempts:1};
  const observation=await adapter.probe(task), candidate=selectCandidate(observation.hosts,config,observation.source);
  const assessments=observation.hosts.map(host=>({host,reasons:candidateReasons(host,config,observation.source)}));
  const listed=assessments.filter(row=>row.reasons.every(reason=>reason==='库存不足')).map(row=>row.host);
  const reasons=new Map();
  for(const row of assessments) for(const reason of row.reasons) reasons.set(reason,(reasons.get(reason)||0)+1);
  const availability={
    status:candidate?'ready':listed.length?'no_stock':observation.hosts.length?'no_match':'empty',
    scannedHosts:observation.hosts.length,matchingHosts:listed.length,
    reasons:[...reasons].map(([reason,count])=>({reason,count})),
  };
  const quote=candidate?await adapter.prepare(task,candidate,observation.source):null;
  if(candidate && !quote)fail('PRICE_UNKNOWN','配置页面未返回完整官方报价，请重新读取；不会用列表单卡价估算');
  if(quote && (!(Number.isFinite(quote.hourly)&&quote.hourly>0) || !(Number.isFinite(quote.storageDaily)&&quote.storageDaily>=0)))
    fail('PRICE_UNKNOWN','无法读取完整官方配置报价与磁盘日费；不会用预设价格代替');
  if(quote && verifyQuote(quote,config,observation.source).length)fail('PRICE_CONFIG','配置报价与资源、环境或数据盘选项不一致，未作为有效预览');
  return {configKey:pricingKey(config),provider:config.provider,source:'AutoDL 官方页面',
    checkedAt:clock(),available:!!candidate,availability,summary:observation.summary,
    listed:listed.slice(0,100).map(h=>({id:h.id,region:h.region,gpuModel:h.gpuModel,available:h.available,price:h.price,maxCuda:h.maxCuda,driver:h.driver})),
    quote:quote?{unitHourly:quote.host.price,hourly:quote.hourly,storageDaily:quote.storageDaily,gpuCount:quote.gpuCount,region:quote.host.region,hostId:quote.host.id,image:quote.image}:null};
}

