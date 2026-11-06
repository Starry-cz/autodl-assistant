import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGpuModel } from '../src/config.mjs';
import { testConfig as normalizeConfig } from './fixtures/config.mjs';
import { candidateReasons, selectCandidate, verifyQuote } from '../src/matching.mjs';
import { parseHostRow, parseInstanceRow, parseGpuStockLabel } from '../src/adapters/dom.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { validateCloneSource } from '../src/instances.mjs';
import { fixture } from './helpers.mjs';
import { fakeCheckbox, fakeLabels } from './fixtures/fake-checkbox.mjs';

// 仅合成型号、页面与临时状态，不登录平台、不读取真实运行目录、不租用 GPU。
const modelHost = model => ({ id:'synthetic-model-host', number:'922机', region:'北京B区', gpuModel:model,
  available:4, driver:'synthetic-driver', maxCuda:'12.8', price:1.98, expandableGB:1000 });
const rawHost = model => ({ id:'synthetic-model-host', cells:['','922机',model+'\n24GB','2 / 8',
  'CPU：8核\n内存：64GB','合成 CPU','数据盘：50GB\n可扩容：1000GB','驱动：550.1 CUDA：12.8','￥1.98 /时'] });
const instanceText = model => 'synthetic001-abcdef01\n北京B区\n' + model + ' × 2卡\n922机\n已关机';
const customModel = 'ExampleGPU [Mk2] (48GB)';
// 常见型号名称，仅作校验样例，不代表平台当前可租型号。
const SAMPLE_MODELS = ['RTX 4090', 'RTX 4090D', 'RTX 3090', 'RTX 5090', 'RTX A4000', 'RTX A5000', 'RTX A6000', 'A40', 'A100', 'V100', 'L20', 'H20', 'H20-NVLink', 'H100'];

for (const mode of ['create','clone']) {
  test(mode+' 必须显式选择型号，不再默认使用 4090', () => {
    for (const gpuModel of [undefined,null,'','   ','__custom__',' __custom__ '])
      assert.throws(() => normalizeConfig({mode,gpuModel}), /型号/);
  });
  test(mode+' 接受常见型号名称及完整自定义型号', () => {
    // 用 CUDA 12.8 的镜像：Blackwell（如 RTX 5090）在新建时要求 12.8 及以上。
    const image={cuda:'12.8',imagePath:['PyTorch','2.8.0','3.12(ubuntu22.04)','12.8']};
    for (const gpuModel of [...SAMPLE_MODELS,'A100 80GB','A100-SXM4-80GB','RTX PRO 6000 Blackwell',customModel])
      assert.equal(normalizeConfig({mode,gpuModel,...image}).gpuModel, gpuModel);
    assert.equal(normalizeConfig({mode,gpuModel:'  a100   80GB  '}).gpuModel, 'a100 80GB');
  });
  test(mode+' 只筛选用户型号，保留显存变体且不回退 4090', () => {
    const config=normalizeConfig({mode,gpuModel:'A100 80GB',gpuCount:2});
    const source=mode==='clone'?{gpuModel:'A100 80GB',gpuCount:2,region:'北京B区',extraDiskGB:100,sourceCuda:'12.1'}:null;
    const exact=modelHost('A100 80GB'),wrong=[modelHost('A100 40GB'),modelHost('A100'),modelHost('RTX 4090')];
    assert.equal(selectCandidate(wrong,config,source),null);
    assert.equal(selectCandidate([...wrong,exact],config,source),exact);
    const quote={host:exact,gpuCount:2,hourly:3.96,storageDaily:0.66,extraDiskGB:100,copyDataDisk:mode==='clone',imageVerified:true};
    assert.deepEqual(verifyQuote(quote,config,source),[]);
    for (const host of wrong) assert.ok(verifyQuote({...quote,host},config,source).includes('型号不符'));
  });
  test(mode+' 非 4090 合成测试走完整验证与通知，且仅提交一次', async t => {
    const f=fixture(t,{mode,gpuModel:mode==='create'?'L20':'A100 80GB',gpuCount:2});
    await f.engine.tick();
    assert.equal(f.task.state,'verifying');
    assert.equal(f.task.operation.quote.host.gpuModel,f.task.config.gpuModel);
    await f.due(80000);await f.due(80000);
    assert.equal(f.task.state,'completed');assert.equal(f.submissions,1);
    assert.ok(f.store.data.notifications.some(notification=>notification.event==='completed'));
  });
}

test('型号校验拒绝非字符串、控制字符、过长名称和纯符号，不截断或替换型号', () => {
  for (const value of [42,[],{},'A100\n80GB','A100\t80GB','A100\u0000','A100\u2028','A'.repeat(81),'+++'])
    assert.throws(()=>normalizeGpuModel(value),/型号/);
  assert.equal(normalizeGpuModel('A'.repeat(80)).length,80);
});

test('主机及实例支持非 RTX 系列，保留完整显存、接口、版本后缀', () => {
  for (const model of ['A100','A100 40GB','A100 80GB','A100-SXM4-80GB','V100','V100S PCIe 32GB',
    'L20','A40','H20-NVLink','H100','RTX A6000','RTX PRO 6000 Blackwell','NVIDIA Tesla V100-SXM2-32GB','RTX 4090(48GB)']) {
    assert.equal(parseHostRow(rawHost(model),'北京B区').gpuModel,model);
    const instance=parseInstanceRow(instanceText(model));
    assert.equal(instance.gpuModel,model);assert.equal(instance.gpuCount,2);
    const inline=parseInstanceRow('北京B区 synthetic001-abcdef01 '+model+' * 2卡 已关机');
    assert.equal(inline.gpuModel,model);assert.equal(inline.gpuCount,2);
  }
});

test('自定义未知系列仅凭页面独立精确名称识别，不能拿用户输入伪造证据', () => {
  assert.equal(parseHostRow(rawHost(customModel),'北京B区').gpuModel,'');
  assert.equal(parseHostRow(rawHost(customModel),'北京B区',customModel).gpuModel,customModel);
  assert.equal(parseInstanceRow(instanceText(customModel)).gpuModel,'');
  assert.equal(parseInstanceRow(instanceText(customModel),customModel).gpuModel,customModel);
  assert.equal(parseInstanceRow(instanceText(customModel).replace(/\n/g,'\t'),customModel).gpuModel,customModel);
  for (const actual of ['Super'+customModel,customModel+' Plus','未知型号']) {
    assert.equal(parseHostRow(rawHost(actual),'北京B区',customModel).gpuModel,'');
    assert.equal(parseInstanceRow(instanceText(actual),customModel).gpuModel,'');
  }
  assert.equal(parseInstanceRow(instanceText('A100 80GB'),'A100').gpuModel,'A100 80GB');
  assert.equal(parseHostRow(rawHost('RTX 4090D'),'北京B区','RTX 4090').gpuModel,'RTX 4090D');
  assert.equal(parseHostRow({cells:['CPU：'+customModel]},'北京B区',customModel).gpuModel,'');
});

test('同一行有冲突的 GPU 证据时不猜测型号或数量', () => {
  const raw=rawHost('A100');raw.cells.push('H100');
  assert.equal(parseHostRow(raw,'北京B区','A100').gpuModel,'');
  const instance=parseInstanceRow(instanceText('A100')+'\nH100 × 1卡','A100');
  assert.equal(instance.gpuModel,'');assert.equal(instance.gpuCount,null);
});

test('GPU 标签仅剥离完整库存后缀，不剥离型号中的括号或显存', () => {
  assert.deepEqual(parseGpuStockLabel(' A100 （ 1 / 8 ） '),{gpuModel:'A100',available:1,total:8});
  assert.equal(parseGpuStockLabel('RTX 4090(48GB) (0/8)').gpuModel,'RTX 4090(48GB)');
  assert.equal(parseGpuStockLabel(customModel+'(1/8)').gpuModel,customModel);
  for (const label of ['RTX 4090(48GB)','A100 (加载中)','A100 (1/8) 其他文本','全部'])
    assert.equal(parseGpuStockLabel(label),null);
});

function modelAdapter(names, options = {}) {
  const adapter=new AutoDLBrowserAdapter('unused-synthetic-model-profile');
  const boxes=names.map(name=>fakeCheckbox(name,{checked:true,...(options[name]||{})}));
  adapter.page={boxes,changes:[],locator:selector=>{assert.equal(selector,'label.el-checkbox');return fakeLabels(adapter.page.boxes);}};
  for(const box of boxes){const click=box.click;box.click=async()=>{adapter.page.changes.push(box.name);await click();};}
  adapter.settle=async()=>{};adapter.checkboxTimeoutMs=300;
  return adapter;
}
const checkedNames=adapter=>adapter.page.boxes.filter(box=>box.checked).map(box=>box.name);
test('页面只勾选选中型号并清除其他型号，不触碰扩容等非型号选项', async () => {
  const adapter=modelAdapter(['全部','RTX 4090(1/8)','RTX 4090D(1/8)','A100(1/8)','需要扩容']);
  await adapter.selectModel('a100');
  assert.deepEqual(adapter.page.boxes.map(box=>box.checked),[false,false,false,true,true]);
});
test('括号显存版本不能冒充基础型号，找不到型号时不改变原选项', async () => {
  const adapter=modelAdapter(['RTX 4090(48GB)(1/8)','RTX 4090D(1/8)','A100(1/8)']);
  await assert.rejects(()=>adapter.selectModel('RTX 4090'),error=>error.code==='MODEL_MISSING');
  assert.deepEqual(adapter.page.changes,[]);
});
test('自定义型号的括号方括号作为文字匹配，不作为正则表达式', async () => {
  const adapter=modelAdapter(['RTX 4090(1/8)',customModel+' (1/8)']);
  await adapter.selectModel(customModel);
  assert.deepEqual(adapter.page.boxes.map(box=>box.checked),[false,true]);
});
test('存在多个同型号标签时停止，不猜测选中哪个库存项', async () => {
  const adapter=modelAdapter(['A100(1/8)','a100(2/8)']);
  await assert.rejects(()=>adapter.selectModel('A100'),error=>error.code==='MODEL_MISSING');
  assert.deepEqual(adapter.page.changes,[]);
});
test('先勾选目标再取消其他项：“全部”互斥、至少保留一项的页面规则都能收敛', async () => {
  // 合成规则：勾选具体型号会取消“全部”；全部取消后页面自动恢复“全部”。
  const exclusive=modelAdapter(['全部','RTX 4090(1/8)','RTX 3090(5/8)'],{'RTX 4090(1/8)':{checked:false},'RTX 3090(5/8)':{checked:false}});
  const [all,target]=exclusive.page.boxes;
  target.click=async()=>{exclusive.page.changes.push(target.name);target.set(!target.checked);if(target.checked)all.set(false);};
  all.click=async()=>{exclusive.page.changes.push(all.name);all.set(!all.checked);if(!exclusive.page.boxes.some(box=>box.checked))all.set(true);};
  await exclusive.selectModel('RTX 4090');
  assert.deepEqual(checkedNames(exclusive),['RTX 4090(1/8)']);assert.deepEqual(exclusive.page.changes,['RTX 4090(1/8)']);
  const minOne=modelAdapter(['全部','RTX 4090(1/8)'],{'RTX 4090(1/8)':{checked:false}});
  const [only]=minOne.page.boxes;
  only.click=async()=>{minOne.page.changes.push(only.name);only.set(!only.checked);if(!minOne.page.boxes.some(box=>box.checked))only.set(true);};
  await minOne.selectModel('RTX 4090');
  assert.deepEqual(checkedNames(minOne),['RTX 4090(1/8)']);assert.deepEqual(minOne.page.changes,['RTX 4090(1/8)','全部']);
});
test('点击后延迟生效时有限等待，不重复点击', async () => {
  const adapter=modelAdapter(['全部','RTX 4090(1/8)'],{'RTX 4090(1/8)':{checked:false}});
  for(const box of adapter.page.boxes)box.click=async()=>{adapter.page.changes.push(box.name);setTimeout(()=>box.set(!box.checked),120);};
  await adapter.selectModel('RTX 4090');
  assert.deepEqual(checkedNames(adapter),['RTX 4090(1/8)']);assert.deepEqual(adapter.page.changes,['RTX 4090(1/8)','全部']);
});
test('重渲染后按名称重新定位，不沿用旧位置点错型号', async () => {
  const adapter=modelAdapter(['全部','RTX 4090D(3/8)','RTX 4090(1/8)'],{'RTX 4090(1/8)':{checked:false}});
  // 合成重排：每次变化后把第一项移到末尾。
  for(const box of adapter.page.boxes){const click=box.click;box.click=async()=>{await click();adapter.page.boxes.push(adapter.page.boxes.shift());};}
  await adapter.selectModel('RTX 4090');
  assert.deepEqual(checkedNames(adapter),['RTX 4090(1/8)']);
});
test('目标型号禁用时不改动任何筛选，错误写明型号', async () => {
  const adapter=modelAdapter(['全部','RTX 4090(0/8)'],{'RTX 4090(0/8)':{checked:false,disabled:true}});
  await assert.rejects(()=>adapter.selectModel('RTX 4090'),error=>error.code==='OPTION_DISABLED'&&error.message.includes('RTX 4090(0/8)'));
  assert.deepEqual(adapter.page.changes,[]);assert.deepEqual(checkedNames(adapter),['全部']);
});
test('页面持续撤销型号筛选时有限次失败，可短暂重试但不会无限点击', async () => {
  const adapter=modelAdapter(['全部','RTX 4090(1/8)'],{'RTX 4090(1/8)':{checked:false}});
  for(const box of adapter.page.boxes){const click=box.click;box.click=async()=>{const before=box.checked;await click();setTimeout(()=>box.set(before),20);};}
  adapter.settle=()=>new Promise(resolve=>setTimeout(resolve,50));
  await assert.rejects(()=>adapter.selectModel('RTX 4090'),error=>['MODEL_FILTER','CHECKBOX_STATE'].includes(error.code)&&error.retryable===true&&error.maxRetries===2&&/“.+”/.test(error.message));
  assert.ok(adapter.page.changes.length<=6,'clicks are bounded: '+adapter.page.changes.length);
});
test('单个复选框：已是目标状态不点击；需要改动但禁用时写明选项名', async () => {
  const adapter=new AutoDLBrowserAdapter('unused-synthetic-model-profile');adapter.checkboxTimeoutMs=300;
  const fixed=fakeCheckbox('需要扩容',{checked:false,disabled:true});
  await adapter.checkbox(fakeLabels([fixed]),false,'需要扩容');assert.equal(fixed.clicks,0);
  await assert.rejects(()=>adapter.checkbox(fakeLabels([fixed]),true,'需要扩容'),error=>error.code==='OPTION_DISABLED'&&error.message.includes('“需要扩容”'));
  assert.equal(fixed.clicks,0);
  await assert.rejects(()=>adapter.checkbox(fakeLabels([]),false,'数据盘'),error=>error.code==='DOM_CHANGED'&&error.message.includes('“数据盘”'));
});
test('单个复选框：延迟生效只点一次；原生勾选与组件样式不一致时停止并说明', async () => {
  const adapter=new AutoDLBrowserAdapter('unused-synthetic-model-profile');adapter.checkboxTimeoutMs=400;
  const delayed=fakeCheckbox('数据盘',{checked:true,onClick:box=>{setTimeout(()=>box.set(false),150);}});
  await adapter.checkbox(fakeLabels([delayed]),false,'数据盘');assert.equal(delayed.clicks,1);assert.equal(delayed.checked,false);
  // 原生已取消，但组件样式仍为勾选：不能当作已取消扩容。
  const rejected=fakeCheckbox('需要扩容',{checked:true,onClick:box=>{box.checked=false;}});
  await assert.rejects(()=>adapter.checkbox(fakeLabels([rejected]),false,'需要扩容'),
    error=>error.code==='CHECKBOX_STATE'&&error.retryable===true&&error.maxRetries===2&&error.message.includes('原生勾选与页面样式不一致'));
  assert.equal(rejected.clicks,1);
  const never=fakeCheckbox('需要扩容',{checked:false,onClick:()=>{}});
  await assert.rejects(()=>adapter.checkbox(fakeLabels([never]),true,'需要扩容'),error=>error.code==='CHECKBOX_STATE'&&error.message.includes('仍为未勾选'));
  assert.equal(never.clicks,1);
});

test('源实例不在任务地区时在进入克隆控件前停止；源实例型号或卡数与目标不同不算错误', async () => {
  const adapter=new AutoDLBrowserAdapter('unused-synthetic-model-profile');
  let clicks=0;
  adapter.findInstanceRow=async(id,model)=>{
    assert.equal(id,'synthetic-source');assert.equal(model,'A100 80GB');
    return {row:{getByRole:()=>({click:async()=>{clicks++;}})},info:{id:'synthetic-source',stopped:true,region:'重庆A区',gpuModel:'A100 40GB',gpuCount:1}};
  };
  const task={id:'synthetic-task',config:normalizeConfig({mode:'clone',sourceId:'synthetic-source',gpuModel:'A100 80GB'})};
  await assert.rejects(()=>adapter.openClone(task),error=>error.code==='SOURCE_MISMATCH'&&error.message.includes('重庆A区')&&error.message.includes('北京B区'));
  assert.equal(clicks,0);
  // 源实例是 A100 40GB × 1、目标是 A100 80GB × 2：源实例可用于克隆。
  assert.doesNotThrow(()=>validateCloneSource(task.config,{id:'synthetic-source',stopped:true,region:'北京B区',gpuModel:'A100 40GB',gpuCount:1}));
});

test('自定义型号提示沿主机读取、基线分页和实例身份校验传递，但不覆盖页面型号', async () => {
  const adapter=new AutoDLBrowserAdapter('unused-synthetic-model-profile');
  adapter.settle=async()=>{};adapter.checkPage=async()=>{};adapter.goto=async()=>{};
  adapter.page={locator:selector=>{
    if(selector==='table tbody tr')return {evaluateAll:async fn=>fn.name==='readInstanceRowElements'
      ? [{text:instanceText(customModel),instanceId:'synthetic001-abcdef01',identityColumn:0}] : [rawHost(customModel)]};
    if(selector==='.el-pagination .btn-next:visible')return {count:async()=>0};
    throw Error('unexpected synthetic locator: '+selector);
  }};
  const hosts=await adapter.collectHosts('北京B区',{config:normalizeConfig({gpuModel:customModel})});
  assert.equal(hosts[0].gpuModel,customModel);
  const instances=await adapter.instances(customModel);
  assert.equal(instances[0].gpuModel,customModel);assert.equal(instances[0].gpuCount,2);
  const task={config:normalizeConfig({gpuModel:customModel,gpuCount:2})};
  assert.ok(adapter.verifyIdentity(instances[0],task));
  assert.equal(adapter.verifyIdentity({...instances[0],gpuModel:customModel+' Plus'},task),false);
});

test('克隆可以换成其他 GPU 型号：按目标型号筛选，环境随源实例系统盘', () => {
  const config=normalizeConfig({mode:'clone',gpuModel:'L20'});
  const source={gpuModel:'A100',gpuCount:1,region:'北京B区',extraDiskGB:0,sourceCuda:'12.1'};
  assert.deepEqual(candidateReasons(modelHost('L20'),config,source),[]);
  assert.ok(candidateReasons(modelHost('A100'),config,source).includes('型号不符'));
});

