import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { fakeCheckbox, fakeLabels } from './fixtures/fake-checkbox.mjs';

// 用于验证提交前的守卫与点击边界，所有页面/按钮均为内存替身，无浏览器或网络。
function submission({mode = 'create', extraDiskGB = 0, gpuModel = 'RTX 4090', copyDataDisk = true} = {}) {
  const config = normalizeConfig({provider:'autodl',gpuModel,mode,action:'execute',paidConsent:true,
    sourceId: mode === 'clone' ? 'synthetic-source' : '', imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1'],
    maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5,extraDiskGB,copyDataDisk});
  const host = {id:'synthetic-host01',number:'922机',region:'北京B区',gpuModel,available:2,
    driver:'synthetic-driver',maxCuda:'12.8',price:1.98,expandableGB:1000,disabled:false};
  const image = config.imagePath.join(' / ');
  const quote = {host,gpuCount:1,hourly:1.98,storageDaily:0,extraDiskGB,copyDataDisk:mode==='clone' && copyDataDisk,
    imageVerified:true,image,baselineIds:[],preparedAt:Date.now()};
  const task = {id:'synthetic-task',config,operation:{stage:'intent',quote,baselineIds:[]}};
  // AutoDL 克隆对话框不勾选数据盘时 copy_data_disk 为空字符串（不是 "0"）。
  const view = {url:mode==='clone'?'https://www.autodl.com/cloneInstance?region=beijing-B&id=synthetic-source&copy_data_disk='+ (copyDataDisk?'1':'')+'&use_address=&image_cuda=12.1':'https://www.autodl.com/create',
    image,hourly:1.98,storageDaily:0,extraDiskGB,expand:extraDiskGB>0,checked:new Map(),events:[],submitEnabled:true,failAfterClick:false,
    afterClick:'accept',signals:{toasts:[],dialogs:[]},instances:[],seen:new Set()};
  const adapter = new AutoDLBrowserAdapter('unused-synthetic-submission-profile');
  adapter.clickOutcomeMs = 300; adapter.clickLoadingMs = 600; adapter.clickPollMs = 10; adapter.rejectGraceMs = 30; adapter.rejectRecheckMs = 10;
  adapter.checkPage = async () => {};
  adapter.revalidateSource = async () => ({id:config.sourceId,region:config.regions[0],gpuModel,gpuCount:1,stopped:true});
  adapter.radioLabel = name => ({count:async () => 1,locator:() => ({isChecked:async () => view.checked.get(name) ?? true,isEnabled:async () => true})});
  adapter.readHosts = async () => [host];
  adapter.scanInstances = async () => [{id:'synthetic-newtarget',region:'北京B区',gpuModel,gpuCount:1,hostNumber:'922机'}];
  // 平台拒绝后的二次核对只读合成实例列表。
  adapter.instances = async () => { view.events.push('list'); return view.instances; };
  adapter.page = {
    url: () => view.url,
    // 合成提示：点击前 mark 记下已有提示，点击后只返回新出现的（按条目标记，同文字的新提示也算新）。
    evaluate: async (fn, [mode] = []) => {
      const all = [...view.signals.toasts.map(text => 'toast:' + text), ...view.signals.dialogs.map(text => 'dialog:' + text)];
      if (mode === 'mark') { all.forEach(item => view.seen.add(item)); return null; }
      const fresh = all.filter(item => !view.seen.has(item));
      return { toasts: fresh.filter(i => i.startsWith('toast:')).map(i => i.slice(6)), dialogs: fresh.filter(i => i.startsWith('dialog:')).map(i => i.slice(7)), others: [] };
    },
    locator(selector) {
      if (selector === 'body') return {innerText:async () => `配置费用：￥${view.hourly}/时\n日常费用：￥${view.storageDaily}/日`};
      if (selector === '.el-cascader:visible input') return {inputValue:async () => view.image};
      if (selector === 'label.el-checkbox') return {filter:() => fakeLabels([fakeCheckbox('需要扩容',{checked:view.expand,styled:view.expandStyled})])};
      throw Error(`unexpected synthetic locator: ${selector}`);
    },
    getByRole(role) {
      if (role === 'spinbutton') return {inputValue:async () => String(view.extraDiskGB)};
      if (role === 'button') return {count:async () => view.buttons ?? 1,isEnabled:async () => view.submitEnabled,click:async () => {
        view.events.push('click');
        if (view.failAfterClick) throw Error('synthetic connection interrupted after click');
        // 合成点击结果：跳回实例列表、出现报错提示、出现弹窗，或无变化。
        if (view.afterClick === 'accept') view.url = 'https://www.autodl.com/console/instance/list';
        if (view.afterClick === 'toast') view.signals = {toasts:[view.toast || 'GPU资源不足，请稍后再试'],dialogs:[]};
        if (view.afterClick === 'dialog') view.signals = {toasts:[],dialogs:['合成确认弹窗 确定 取消']};
      }};
      throw Error(`unexpected synthetic role: ${role}`);
    },
  };
  adapter.prepared = {taskId:task.id,quote,source:mode==='clone'?{id:config.sourceId,region:config.regions[0],gpuModel,gpuCount:1,stopped:true,extraDiskGB:0,sourceCuda:'12.1'}:null};
  const submit = () => adapter.submit(task,quote,() => {view.events.push('mark');task.operation.stage='click_started';});
  return {adapter,task,host,quote,view,submit};
}

test('最终报价变化阻断提交，不能到达点击边界', async () => {
  const s=submission();s.view.hourly=100;
  await assert.rejects(s.submit,error=>error.code==='QUOTE_CHANGED');assert.deepEqual(s.view.events,[]);
});
test('GPU数量或基础镜像被修改时阻断点击', async () => {
  const count=submission();count.view.checked.set('1',false);
  // 选中主机后 GPU 数量被平台改掉（例如“2卡起租”）：不点击，按竞争失败换主机。
  await assert.rejects(count.submit,error=>error.code==='GPU_COUNT'&&error.race===true&&error.hostProblem===true);assert.deepEqual(count.view.events,[]);
  const image=submission();image.view.image='unexpected image';
  await assert.rejects(image.submit,error=>error.code==='IMAGE_CHANGED');assert.deepEqual(image.view.events,[]);
});
test('扩容开关或扩容容量变化阻断点击', async () => {
  const expand=submission();expand.view.expand=true;
  await assert.rejects(expand.submit,error=>error.code==='DISK_CHANGED');assert.deepEqual(expand.view.events,[]);
  const size=submission({extraDiskGB:100});size.view.extraDiskGB=50;
  await assert.rejects(size.submit,error=>error.code==='DISK_CHANGED');assert.deepEqual(size.view.events,[]);
  // 原生未勾选但组件样式仍为勾选：扩容状态无法确认，同样不能点击付费按钮。
  const unknown=submission();unknown.view.expandStyled=true;
  await assert.rejects(unknown.submit,error=>error.code==='DISK_CHANGED');assert.deepEqual(unknown.view.events,[]);
});
test('克隆源、复制数据盘或服务地址参数被修改时阻断点击', async () => {
  // 取消了复制数据盘、源实例换成别的实例、或选择了把源实例的服务地址转给新实例，均不点击。
  for (const change of [url => url.replace('copy_data_disk=1', 'copy_data_disk='), url => url.replace('id=synthetic-source', 'id=synthetic-other'),
    url => url.replace('use_address=', 'use_address=1')]) {
    const s=submission({mode:'clone'});s.view.url=change(s.view.url);
    await assert.rejects(s.submit,error=>error.code==='COPY_DISK');assert.deepEqual(s.view.events,[]);
  }
});
test('费用授权、报价时效和禁用按钮均在点击前拒绝', async () => {
  const consent=submission();consent.task.config.paidConsent=false;
  await assert.rejects(consent.submit,error=>error.code==='CONSENT');assert.deepEqual(consent.view.events,[]);
  const stale=submission();stale.quote.preparedAt-=61000;
  await assert.rejects(stale.submit,error=>error.code==='QUOTE_STALE'&&error.retryable);assert.deepEqual(stale.view.events,[]);
  const disabled=submission();disabled.view.submitEnabled=false;
  await assert.rejects(disabled.submit,error=>error.code==='RESOURCE_GONE'&&error.retryable);assert.deepEqual(disabled.view.events,[]);
});
test('合成正常提交先持久化mark再点击，并绑定唯一新增目标', async () => {
  const s=submission();const receipt=await s.submit();
  assert.deepEqual(s.view.events,['mark','click']);assert.equal(receipt.instanceId,'synthetic-newtarget');assert.equal(s.adapter.prepared,null);
});
test('点击之后断线保留已进入点击状态，交由引擎对账', async () => {
  const s=submission();s.view.failAfterClick=true;
  await assert.rejects(s.submit,/interrupted/);assert.deepEqual(s.view.events,['mark','click']);assert.equal(s.task.operation.stage,'click_started');
});

test('非 RTX 和自定义型号的最终提交仍先核验型号并仅点击一次（合成页面）', async () => {
  for (const mode of ['create','clone']) for (const gpuModel of ['L20','A100 80GB','ExampleGPU [Mk2] (48GB)']) {
    const s=submission({mode,gpuModel});
    const read=s.adapter.readHosts,scan=s.adapter.scanInstances;
    s.adapter.readHosts=async(region,model)=>{assert.equal(model,gpuModel);return read(region,model);};
    s.adapter.scanInstances=async(model)=>{assert.equal(model,gpuModel);return scan(model);};
    const receipt=await s.submit();
    assert.equal(receipt.instanceId,'synthetic-newtarget');assert.deepEqual(s.view.events,['mark','click']);
  }
});
test('点击前显存变体改变时不提交，也不会回退基础型号（合成页面）', async () => {
  const s=submission({gpuModel:'A100 80GB'});s.host.gpuModel='A100 40GB';
  await assert.rejects(s.submit,error=>error.code==='QUOTE_CHANGED');assert.deepEqual(s.view.events,[]);
});

test('不复制数据盘时（AutoDL 克隆页的 copy_data_disk 为空）正常只提交一次，反向变化阻断',async()=>{
 const s=submission({mode:'clone',copyDataDisk:false});assert.match(s.view.url,/copy_data_disk=&/);await s.submit();assert.deepEqual(s.view.events,['mark','click']);
 const changed=submission({mode:'clone',copyDataDisk:false});changed.view.url=changed.view.url.replace('copy_data_disk=&','copy_data_disk=1&');await assert.rejects(changed.submit,e=>e.code==='COPY_DISK');assert.deepEqual(changed.view.events,[]);
});
test('提交回调检查失败时不能mark或点击；检查过程中价格变化再次阻断',async()=>{
 const low=submission();await assert.rejects(low.adapter.submit(low.task,low.quote,()=>low.view.events.push('mark'),async()=>{throw Error('合成低余额');}),/低余额/);assert.deepEqual(low.view.events,[]);
 const changed=submission();await assert.rejects(changed.adapter.submit(changed.task,changed.quote,()=>changed.view.events.push('mark'),async()=>{changed.view.hourly=2;}),e=>e.code==='QUOTE_CHANGED');assert.deepEqual(changed.view.events,[]);
});
test('克隆提交前重新核验源；源变化或暂停均不进入点击',async()=>{
 const changed=submission({mode:'clone'});let calls=0;changed.adapter.revalidateSource=async()=>{calls++;throw Error('合成源已开机');};await assert.rejects(changed.submit,/已开机/);assert.equal(calls,1);assert.deepEqual(changed.view.events,[]);
 const paused=submission();await assert.rejects(paused.adapter.submit(paused.task,paused.quote,()=>paused.view.events.push('mark'),async()=>{paused.task.state='paused';}),e=>e.code==='CANCELLED');assert.deepEqual(paused.view.events,[]);
});

// 点击后的结果判断：只读合成页面状态；任何不确定都保留提交记录，不会再次点击。
test('点击后平台报库存不足，两次核对实例列表都没有新实例：按竞争失败返回，可清除提交记录',async()=>{
 const s=submission();s.view.afterClick='toast';s.quote.baselineIds=['synthetic-existing'];s.view.instances=[{id:'synthetic-existing'}];
 await assert.rejects(s.submit,e=>e.code==='SUBMIT_REJECTED'&&e.notCreated===true&&e.race===true&&/GPU资源不足/.test(e.message));
 assert.deepEqual(s.view.events,['mark','click','list','list']);assert.equal(s.adapter.prepared,null);
});
test('平台提示账户问题时同样确认未创建，但不按竞争失败继续点击',async()=>{
 const s=submission();s.view.afterClick='toast';s.view.toast='账户余额不足，请充值后再试';
 await assert.rejects(s.submit,e=>e.code==='SUBMIT_REJECTED'&&e.notCreated===true&&e.race!==true&&e.retryable===false&&/处理账户问题/.test(e.message));
});
test('报错但实例列表出现无法归属的新实例：不清除提交记录',async()=>{
 const extra=submission();extra.view.afterClick='toast';extra.view.instances=[{id:'synthetic-unexpected'}];
 await assert.rejects(extra.submit,e=>e.code==='SUBMIT_UNCLEAR'&&e.notCreated!==true&&/synthetic-unexpected/.test(e.message));
});
test('点击后出现未识别弹窗或页面没有任何结果：不立即判定未创建，保留提交记录，约2分钟后再核对实例列表',async()=>{
 // 实例可能延迟出现在列表中：立即判定“未创建”会让下一轮再点一次而多租。
 const dialog=submission();dialog.view.afterClick='dialog';
 await assert.rejects(dialog.submit,e=>e.code==='SUBMIT_UNCLEAR'&&e.notCreated!==true&&/弹窗/.test(e.message));
 assert.deepEqual(dialog.view.events,['mark','click']);
 const silent=submission();silent.view.afterClick='none';
 await assert.rejects(silent.submit,e=>e.code==='SUBMIT_UNCLEAR'&&e.notCreated!==true&&/没有新出现的提示/.test(e.message));
 assert.deepEqual(silent.view.events,['mark','click']);
});
test('点击后没有回到实例列表、目标主机上出现一个新实例：先保留记录，约2分钟后的核对再绑定',async()=>{
 const s=submission();s.view.afterClick='none';s.view.instances=[{id:'synthetic-latebind',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'922机'}];
 await assert.rejects(s.submit,e=>e.code==='SUBMIT_UNCLEAR');
 s.task.operation={...s.task.operation,at:Date.now()-150000,clickedAt:Date.now()-150000};
 const status=await s.adapter.reconcileUnclear(s.task);assert.equal(status.receipt.instanceId,'synthetic-latebind');
});
test('点击后按钮仍在加载：平台可能还在处理，保留提交记录交给约2分钟后的自动核对',async()=>{
 const s=submission();s.view.afterClick='none';const read=s.adapter.page.evaluate;
 s.adapter.page.evaluate=async(fn,args=[])=>{const result=await read(fn,args);return args[0]==='read'?{...result,button:{disabled:true,loading:true}}:result;};
 const started=Date.now();
 await assert.rejects(s.submit,e=>e.code==='SUBMIT_UNCLEAR'&&e.notCreated!==true&&/仍在加载/.test(e.message));assert.deepEqual(s.view.events,['mark','click']);
 // 按钮加载期间继续等到 clickLoadingMs（真实值约65秒，覆盖 AutoDL 下单后最长约1分钟的实例查询）。
 assert.ok(Date.now()-started>=s.adapter.clickLoadingMs-50,'waited '+(Date.now()-started));
});
test('按钮加载一段时间后出现失败提示：按平台拒绝处理，两次核对后继续监测，不走2分钟核对',async()=>{
 const s=submission();s.view.afterClick='none';const read=s.adapter.page.evaluate;let clickedAt=0;
 const click=s.adapter.page.getByRole('button').click;
 s.adapter.page.getByRole=role=>role==='spinbutton'?{inputValue:async()=>String(s.view.extraDiskGB)}:{count:async()=>1,isEnabled:async()=>true,click:async()=>{await click();clickedAt=Date.now();}};
 // 超过 clickOutcomeMs（300ms）后仍在加载，450ms 时 AutoDL 给出“实例创建失败”。
 s.adapter.page.evaluate=async(fn,args=[])=>{
   if(args[0]==='read'&&clickedAt&&Date.now()-clickedAt>=450&&!s.view.signals.toasts.length)s.view.signals={toasts:['实例创建失败，请重试或联系客服处理。'],dialogs:[]};
   const result=await read(fn,args);return args[0]==='read'&&clickedAt&&Date.now()-clickedAt<450?{...result,button:{disabled:true,loading:true}}:result;
 };
 await assert.rejects(s.submit,e=>e.code==='SUBMIT_REJECTED'&&e.notCreated===true&&e.race===true&&e.unrecognized!==true&&/实例创建失败/.test(e.message));
 assert.deepEqual(s.view.events,['mark','click','list','list']);
});
test('点击后出现 AutoDL 的架构/CUDA 提示弹窗：确认未创建后停止，不当作竞争失败反复点击',async()=>{
 const s=submission();s.view.afterClick='none';const click=s.adapter.page.getByRole('button').click;
 s.adapter.page.getByRole=role=>role==='spinbutton'?{inputValue:async()=>String(s.view.extraDiskGB)}:{count:async()=>1,isEnabled:async()=>true,
   click:async()=>{await click();s.view.signals={toasts:[],dialogs:['您当前选择的为Blackwell架构的GPU（如50系列等）, 该架构的GPU需使用CUDA12.8及以上版本的CUDA 重新选择 继续']};}};
 await assert.rejects(s.submit,e=>e.code==='CUDA_ARCH'&&e.notCreated===true&&e.race!==true&&e.retryable!==true&&/Blackwell/.test(e.message));
 assert.deepEqual(s.view.events,['mark','click','list','list']);
 // 余额不足等明确失败的弹窗按已识别的拒绝处理，不计入“没有识别出结果”。
 const money=submission();money.view.afterClick='none';const pay=money.adapter.page.getByRole('button').click;
 money.adapter.page.getByRole=role=>role==='spinbutton'?{inputValue:async()=>String(money.view.extraDiskGB)}:{count:async()=>1,isEnabled:async()=>true,
   click:async()=>{await pay();money.view.signals={toasts:[],dialogs:['余额不足 账户余额: ￥3.61 需支付: ￥4.00 去充值']};}};
 await assert.rejects(money.submit,e=>e.code==='SUBMIT_REJECTED'&&e.notCreated===true&&e.unrecognized!==true&&e.race!==true);
});
test('点击前已存在的同一报错不算本次结果；报错后很快跳回实例列表按已受理处理',async()=>{
 const old=submission();old.view.signals={toasts:['GPU资源不足，请稍后再试'],dialogs:[]};old.view.afterClick='toast';
 await assert.rejects(old.submit,e=>e.code==='SUBMIT_UNCLEAR'&&!/GPU资源不足/.test(e.message));
 const late=submission();late.view.afterClick='toast';late.adapter.rejectGraceMs=2000;// 留足等待：10ms 后的跳转在整套测试并行时也能落在观察窗口内
 late.adapter.page.getByRole=role=>role==='spinbutton'?{inputValue:async()=>String(late.view.extraDiskGB)}:{count:async()=>1,isEnabled:async()=>true,click:async()=>{late.view.events.push('click');late.view.signals={toasts:['合成网络提示'],dialogs:[]};setTimeout(()=>{late.view.url='https://www.autodl.com/console/instance/list';},10);}};
 const receipt=await late.submit();assert.equal(receipt.instanceId,'synthetic-newtarget');
});
test('创建按钮缺失时在点击前停止，不进入点击边界',async()=>{
 const s=submission();s.view.buttons=0;
 await assert.rejects(s.submit,e=>e.code==='RESOURCE_GONE'&&e.race===true);assert.deepEqual(s.view.events,[]);
});
test('克隆：准备阶段刚复核过源实例时提交前不再另开页面复核；超过15秒才复核',async()=>{
 const fresh=submission({mode:'clone'});let calls=0;fresh.adapter.revalidateSource=async()=>{calls++;};fresh.adapter.prepared.sourceCheckedAt=Date.now();
 await fresh.submit();assert.equal(calls,0);
 const stale=submission({mode:'clone'});stale.adapter.revalidateSource=async()=>{calls++;};stale.adapter.prepared.sourceCheckedAt=Date.now()-16000;
 await stale.submit();assert.equal(calls,1);
});
test('按钮仍在加载时出现的失败提示不当作结果；平台拒绝后列表出现新实例不自动绑定；跳回列表后读列表失败仍记为已受理',async()=>{
 // 按钮仍在加载：请求可能还没返回，等到加载上限仍在加载就保留记录
 const loading=submission();loading.view.afterClick='toast';const read=loading.adapter.page.evaluate;
 loading.adapter.page.evaluate=async(fn,args)=>{const r=await read(fn,args);return r&&{...r,button:{loading:true,disabled:true}};};
 await assert.rejects(loading.submit,e=>e.code==='SUBMIT_UNCLEAR'&&/仍在加载/.test(e.message));assert.deepEqual(loading.view.events,['mark','click']);
 // 明确的拒绝提示之后列表出现新实例：可能属于别的任务，不自动绑定
 const rejected=submission();rejected.view.afterClick='toast';rejected.view.instances=[{id:'synthetic-other01',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'922机'}];
 await assert.rejects(rejected.submit,e=>e.code==='SUBMIT_UNCLEAR'&&e.noAutoBind===true&&/不自动绑定/.test(e.message));
 // 已跳回实例列表，之后读取列表失败：仍记为已受理，不会被当成结果不明
 const accepted=submission();accepted.adapter.scanInstances=async()=>{throw Object.assign(Error('list loading'),{code:'LIST_LOADING'});};
 const receipt=await accepted.submit();assert.equal(receipt.instanceId,null);assert.equal(receipt.evidence,'accepted-navigation-only');assert.ok(receipt.acceptedAt);
});
test('复制数据盘时克隆页地址的源数据盘容量为空不能当作 0',()=>{
 const s=submission({mode:'clone'});s.view.url='https://www.autodl.com/cloneInstance?region=beijing-B&id=synthetic-source&copy_data_disk=1&use_address=&image_cuda=12.1&expand_size=';
 assert.throws(()=>s.adapter.readClonePage(s.task.config),{code:'DISK_UNKNOWN'});
 s.view.url+='0';assert.equal(s.adapter.readClonePage(s.task.config).extraDiskGB,0);
});
test('实例列表同一页两行读成同一个实例 ID 时停止对账；新实例沿用源实例名称时仍按它自己的 ID 认作新实例',async()=>{
 const s=submission();const a=s.adapter;a.settle=async()=>{};a.checkPage=async()=>{};
 a.page={locator:()=>({count:async()=>0,isEnabled:async()=>false})};
 a.readInstancePage=async()=>({texts:['x'],instances:[{id:'stable-diffusion1',ids:['stable-diffusion1','realaaaa-000001']},{id:'stable-diffusion1',ids:['stable-diffusion1','realbbbb-000002']}]});
 await assert.rejects(AutoDLBrowserAdapter.prototype.scanInstances.call(a,'',{settled:true}),{code:'DOM_CHANGED'});
 // 名称片段不参与身份判断；新实例即使沿用源实例名称也按自己的主键对账。
 s.task.operation={stage:'accepted',quote:s.quote,baselineIds:['sourceaa-000001']};
 const rows=[{id:'sourceaa-000001',ids:['stable-diffusion1','sourceaa-000001'],region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'900机'},
   {id:'newclone-000002',ids:['stable-diffusion1','newclone-000002'],region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'922机'}];
 assert.deepEqual(a.newTargets(rows,s.task).map(i=>i.id),['newclone-000002']);
});
test('先前被拒绝的点击之后，别的主机上出现的相符新实例会被报告为可能多租；别的任务已绑定的实例不算',()=>{
 const s=submission();const a=s.adapter;
 s.task.submitRejections=[{at:Date.now()-60000,baselineIds:['old00001-aaaaaa'],hostNumber:'921机'}];
 s.task.operation={stage:'accepted',quote:s.quote,baselineIds:['old00001-aaaaaa']};
 const rows=[{id:'old00001-aaaaaa',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'900机'},
   {id:'late0001-aaaaaa',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'921机'},
   {id:'bound001-aaaaaa',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,hostNumber:'922机'}];
 assert.deepEqual(a.strays(s.task,rows,'bound001-aaaaaa'),['late0001-aaaaaa']);
 a.claimedIds=()=>new Set(['late0001-aaaaaa']);assert.deepEqual(a.strays(s.task,rows,'bound001-aaaaaa'),[]);
 assert.deepEqual(a.newTargets(rows,s.task).map(i=>i.id),['bound001-aaaaaa']);
 s.task.submitRejections=[];assert.deepEqual(a.strays(s.task,rows,'bound001-aaaaaa'),[]);
});

