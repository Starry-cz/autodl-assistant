import { testConfig } from './fixtures/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeNotifications } from '../src/config.mjs';
import { cudaCompatible, gpuKey, selectCandidate, candidateReasons, verifyQuote, assessInstance, archCudaProblem } from '../src/matching.mjs';
const config = overrides=>testConfig({action:'execute',paidConsent:true,...overrides});
const host = overrides=>({id:'synthetic-host',number:'合成主机',region:'北京B区',gpuModel:'RTX 4090',available:2,driver:'550.1',maxCuda:'12.8',price:1.98,expandableGB:300,...overrides});
test('CUDA 按版本元组而不是小数比较；拒绝99占位数据',()=>{
  assert.equal(cudaCompatible('12.10','12.9'),true);assert.equal(cudaCompatible('12.8','12.10'),false);
  assert.equal(cudaCompatible('13.0','12.8'),true);assert.equal(cudaCompatible('99','12.1'),false);
  assert.equal(cudaCompatible('','12.1'),false);
});
test('GPU 必须精确区分 4090、4090D、48GB',()=>{
  assert.equal(gpuKey('RTX4090'),gpuKey('RTX 4090'));
  for(const model of ['RTX 4090D','RTX 4090 48G','RTX 4090 48GB'])assert.ok(candidateReasons(host({gpuModel:model}),config()).includes('型号不符'));
});
test('资源选择同时检查价格、地区、GPU 数量和兼容性',()=>{
  const hosts=[host({id:'d',gpuModel:'RTX 4090D'}),host({id:'expensive',price:9}),host({id:'empty',available:0}),host({id:'old',maxCuda:'11.8'}),host({id:'wrong-region',region:'北京A区'}),host({id:'ok'})];
  assert.equal(selectCandidate(hosts,config()).id,'ok');
  assert.equal(selectCandidate([host({available:1})],config({gpuCount:2})),null);
});
test('未知价格、空闲数量、驱动不能当成符合',()=>{
  for(const patch of [{price:null},{price:0},{available:null},{driver:'-'},{maxCuda:'99'},{disabled:true}])assert.equal(selectCandidate([host(patch)],config()),null);
});
test('克隆排除源主机和不够源扩容的机器',()=>{
  const source={region:'北京B区',gpuModel:'RTX 4090',hostId:'old',extraDiskGB:220,sourceCuda:'12.1'};
  assert.equal(selectCandidate([host({id:'old'}),host({id:'small',expandableGB:100}),host({id:'ok'})],config({mode:'clone'}),source).id,'ok');
});
test('结算时还需总费用、磁盘日费、复制勾选和目标容量',()=>{
  const c=config({mode:'clone'}),source={region:'北京B区',gpuModel:'RTX 4090',extraDiskGB:220,sourceCuda:'12.1'};
  const q={host:host(),gpuCount:1,hourly:1.98,storageDaily:1.46,extraDiskGB:220,copyDataDisk:true,imageVerified:true};
  assert.deepEqual(verifyQuote(q,c,source),[]);
  assert.ok(verifyQuote({...q,copyDataDisk:false},c,source).includes('未确认复制数据盘'));
  assert.ok(verifyQuote({...q,extraDiskGB:0},c,source).includes('目标扩容小于源数据盘或未知'));
  assert.ok(verifyQuote({...q,hourly:8},c,source).includes('结算配置总价未知、无效或超限'));
  assert.ok(verifyQuote({...q,storageDaily:null},c,source).includes('磁盘日费未知、无效或超限'));
});
test('GPU运行但缺少数据复制证据时不能判定克隆成功',()=>{
  assert.equal(assessInstance({running:true,gpuVerified:true},'clone').state,'verifying');
  assert.equal(assessInstance({running:true,gpuVerified:true,copyComplete:true},'clone').state,'completed');
  assert.equal(assessInstance({running:true,gpuVerified:true,copyComplete:true,copyFailed:true},'clone').state,'attention');
  assert.equal(assessInstance({running:true,gpuVerified:false},'create').state,'verifying');
});
test('真实自动付费必须显式授权，限价模式必须配置预算',()=>{
  assert.throws(()=>normalizeConfig({provider:'autodl',action:'execute'}),/费用.*明确启用/);
  assert.throws(()=>normalizeConfig({provider:'autodl',gpuModel:'RTX 4090',action:'observe',imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1']}),/价格上限/);
});
test('真实模式允许轮询最低1秒；克隆只支持同地区',()=>{
  const live={gpuModel:'RTX 4090',provider:'autodl',action:'observe',mode:'clone',sourceId:'synthetic-source',maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5};
  assert.equal(normalizeConfig({...live,pollSeconds:1}).pollSeconds,1);
  assert.throws(()=>normalizeConfig({...live,pollSeconds:0}),/检查间隔/);
  assert.throws(()=>normalizeConfig({...live,regions:['北京A区','北京B区']}),/单个地区/);
  assert.equal(normalizeConfig(live).pollSeconds,10,'未填写时默认10秒');
});
test('无效配置、数量、版本和地区被拒绝',()=>{
  for(const patch of [{gpuCount:9},{cuda:'99'},{extraDiskGB:-1},{maxGpuHourly:NaN},{regions:['未知区']},{mode:'anything'}])assert.throws(()=>config(patch));
});
test('通知配置使用HTTPS，掩码输入保留原凭证',()=>{
  assert.throws(()=>normalizeNotifications({webhookEnabled:true,webhookUrl:'http://example.test'}),/HTTPS/);
  assert.throws(()=>normalizeNotifications({webhookEnabled:true,webhookUrl:'https://user:pwd@example.test'}),/用户名密码/);
  const stored={webhookUrl:'https://example.test/notify',webhookToken:'synthetic-test-token'};
  const result=normalizeNotifications({webhookEnabled:true,webhookUrl:'***',webhookToken:'***'},stored);
  assert.equal(result.webhookToken,stored.webhookToken);assert.equal(result.webhookUrl,stored.webhookUrl);
});

test('克隆通过源主机号排除原机器；目标 GPU 型号和数量可以与源实例不同',()=>{
  const source={region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'合成源机',extraDiskGB:0,sourceCuda:'12.1'};
  assert.ok(candidateReasons(host({number:'合成源机'}),config({mode:'clone'}),source).includes('源主机'));
  assert.deepEqual(candidateReasons(host({available:2}),config({mode:'clone',gpuCount:2}),source),[]);
  assert.deepEqual(candidateReasons(host({gpuModel:'RTX 3090'}),config({mode:'clone',gpuModel:'RTX 3090'}),source),[]);
  assert.ok(candidateReasons(host({region:'西北B区'}),config({mode:'clone'}),source).includes('不在源地区'));
  // 读不出主机号时无法确认不是源主机，不选
  assert.ok(candidateReasons(host({number:''}),config({mode:'clone'}),source).includes('主机号未知，无法确认不是源主机'));
});
test('克隆按源实例镜像的 CUDA 筛选宿主驱动，不使用任务里填写的 CUDA',()=>{
  const c=config({mode:'clone'});assert.equal(c.cuda,'');
  const source={region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,extraDiskGB:0,sourceCuda:'12.8'};
  assert.deepEqual(candidateReasons(host({maxCuda:'12.8'}),c,source),[]);
  assert.ok(candidateReasons(host({maxCuda:'12.4'}),c,source).includes('驱动/CUDA 不兼容或未知'));
  // 还没有读到源环境时不放行任何主机。
  assert.ok(candidateReasons(host(),c,{...source,sourceCuda:''}).includes('驱动/CUDA 不兼容或未知'));
  // 旧任务里手填的 13.2 不再阻止驱动为 12.8 的主机。
  assert.deepEqual(candidateReasons(host({maxCuda:'12.8'}),{...c,cuda:'13.2'},source),[]);
});
test('Blackwell 架构（如 50 系列）要求环境 CUDA 12.8 及以上，与 AutoDL 下单前提示一致',()=>{
  for(const model of ['RTX 5090','RTX 5090D','RTX 5090 D','RTX5080','RTX 5070 Ti','RTX PRO 6000 Blackwell','B200','GB200','RTX PRO 6000','PRO 6000 Max-Q','RTX PRO 5000'])
    assert.ok(archCudaProblem(model,'12.4'),model);
  for(const model of ['RTX 4090','RTX 3090','RTX A6000','RTX 6000 Ada','L20','H20','A100 80GB','B2000','RTX 6000D'])assert.equal(archCudaProblem(model,'12.1'),'',model);
  assert.equal(archCudaProblem('RTX 5090','12.8'),'');assert.equal(archCudaProblem('RTX 5090','13.0'),'');assert.equal(archCudaProblem('RTX 5090','12.10'),'');
  assert.equal(archCudaProblem('RTX 5090',''),'');
  // 新建：所选镜像 CUDA 低于 12.8 时建任务即拒绝；克隆：源环境 CUDA 低于 12.8 时该型号主机不作候选。
  assert.throws(()=>config({gpuModel:'RTX 5090'}),/Blackwell/);
  assert.equal(config({gpuModel:'RTX 5090',cuda:'12.8',imagePath:['PyTorch','2.8.0','3.12(ubuntu22.04)','12.8']}).gpuModel,'RTX 5090');
  const source={region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,extraDiskGB:0,sourceCuda:'12.1'};
  assert.ok(candidateReasons(host({gpuModel:'RTX 5090',maxCuda:'13.0'}),config({mode:'clone',gpuModel:'RTX 5090'}),source).includes('GPU 架构需要更高 CUDA'));
});
test('未知扩容和未经核实的镜像不能通过最终报价',()=>{
  const q={host:host(),gpuCount:1,hourly:1.98,storageDaily:0,extraDiskGB:0,imageVerified:true};
  assert.ok(verifyQuote({...q,extraDiskGB:null},config()).includes('目标扩容小于源数据盘或未知'));
  assert.ok(verifyQuote({...q,imageVerified:false},config()).includes('镜像/源环境未确认'));
});
test('真实新建镜像必须四级完整路径且CUDA一致',()=>{
  const c={gpuModel:'RTX 4090',provider:'autodl',action:'observe',maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5};
  assert.throws(()=>normalizeConfig({...c,imagePath:['PyTorch','12.1']}),/四级完整/);
  assert.throws(()=>normalizeConfig({...c,imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.8']}),/CUDA.*一致/);
});
test('页面解析：只保留已确认的实例主键、复制中优先于“复制完成后”、主机号与可扩容容量的多种写法；不需要扩容时不看容量；数字只接受数字或十进制字符串',async()=>{
  const { parseInstanceRow, parseHostRow } = await import('../src/adapters/dom.mjs');
  const text='stablediffusion-webui1\nabcd1234-ef5678\n北京B区 / 922机\nRTX 4090 × 1\n运行中\n数据盘复制中 数据盘复制完成后才能写入';
  assert.equal(parseInstanceRow(text),null);
  const row=parseInstanceRow(text,'','abcd1234-ef5678');
  assert.deepEqual(row.ids,['abcd1234-ef5678']);assert.equal(row.copyComplete,false);assert.equal(row.progress,'数据盘复制中');assert.equal(row.hostNumber,'922机');
  assert.equal(parseInstanceRow('abcd1234-ef5678\n数据盘复制完成').copyComplete,true);
  assert.equal(parseInstanceRow('abcd1234-ef5678\n4090机器测试').hostNumber,'');
  const hostRow=cells=>parseHostRow({id:'h1',cells},'北京B区');
  assert.equal(hostRow(['北京B区 922机','RTX 4090','1/8','可扩容：1.5TB']).number,'922机');
  assert.equal(hostRow(['922机','可扩容：1.5TB']).expandableGB,1536);assert.equal(hostRow(['922机','可扩容：1,024GB']).expandableGB,1024);
  assert.deepEqual(candidateReasons(host({expandableGB:null}),config({})),[]);
  assert.ok(candidateReasons(host({expandableGB:null}),config({extraDiskGB:50})).includes('数据盘容量不足'));
  for (const bad of [true,[5],'0x10','1e3']) assert.throws(()=>config({gpuCount:bad}),/GPU|数量|卡/);
  assert.equal(config({gpuCount:'2'}).gpuCount,2);
  const { assessInstance } = await import('../src/matching.mjs');
  assert.equal(assessInstance({running:true,gpuVerified:true,copyComplete:true,progress:'数据盘复制中'},'clone',true).state,'verifying');
});
test('Webhook 地址换到另一个网站时不沿用原 Token；同一网站换路径可以沿用',()=>{
  const stored={webhookUrl:'https://a.example.test/notify',webhookToken:'synthetic-token-a'};
  assert.throws(()=>normalizeNotifications({webhookEnabled:true,webhookUrl:'https://b.example.test/notify',webhookToken:'***'},stored),/重新填写 Webhook Token/);
  assert.equal(normalizeNotifications({webhookEnabled:true,webhookUrl:'https://a.example.test/other',webhookToken:'***'},stored).webhookToken,'synthetic-token-a');
  assert.equal(normalizeNotifications({webhookEnabled:true,webhookUrl:'https://b.example.test/notify',webhookToken:''},stored).webhookToken,'');
});

