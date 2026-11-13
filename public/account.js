'use strict';
let accountBusy = null, instanceSignature = null, sourceLocked = false, manualResource = null, appliedSource = null;
let pricingSnapshot = null, pricingFormSignature = null, pricingError = '', pricingRevision = 0, walletSettingsLoaded = false;
function currentPricingSignature() {
  const c=taskPayload();
  return JSON.stringify([c.provider,c.mode,c.gpuModel,c.gpuCount,c.regions,c.cuda,c.sourceId,c.imagePath,c.copyDataDisk,c.extraDiskGB]);
}
function clearPricing() { pricingSnapshot=null;pricingFormSignature=null;pricingError='';pricingRevision++;renderPricing(); }
function currentQuote() {
  return pricingSnapshot?.quote && pricingFormSignature===currentPricingSignature() && Date.now()-pricingSnapshot.checkedAt<=60000 ? pricingSnapshot.quote : null;
}
function pricingWaitMessage(snapshot) {
  const availability=snapshot?.availability;
  if(availability?.status==='no_stock'||(!snapshot?.available&&snapshot?.listed?.length))
    return '暂无满足所选数量的空闲 GPU。单卡价仅供参考，可先开始监测。';
  if(availability?.status==='no_match') {
    const reasons=(availability.reasons||[]).map(item=>item.reason+'（'+item.count+' 台）').join('、');
    return '已读取 '+availability.scannedHosts+' 台主机，暂无符合全部条件的资源'+(reasons?'：'+reasons:'')+'。可先开始监测。';
  }
  if(availability?.status==='empty')return '尚未读到主机，请检查地区选择后重试。';
  return '暂无完整报价，可先开始监测。';
}
function renderPricing() {
  const signature=currentPricingSignature();
  if(pricingFormSignature && signature!==pricingFormSignature){pricingSnapshot=null;pricingFormSignature=null;pricingError='';pricingRevision++;}
  const snapshot=pricingSnapshot,quote=currentQuote(),expired=!!snapshot&&Date.now()-snapshot.checkedAt>60000;
  let unit=quote?money(quote.unitHourly):'—';
  if(snapshot&&!expired&&!quote&&snapshot.listed?.length){const prices=snapshot.listed.map(h=>h.price).filter(Number.isFinite);if(prices.length)unit=money(Math.min(...prices))+(Math.max(...prices)>Math.min(...prices)?'～'+money(Math.max(...prices)):'');}
  // 只突出单卡每小时；读到完整配置报价后，下方一行再写配置总价（多卡时注明卡数）与磁盘日费。
  $('#price-unit').textContent=unit;$('#price-hourly').textContent=money(quote?.hourly);$('#price-storage').textContent=money(quote?.storageDaily);
  $('#price-cards').textContent=quote&&quote.gpuCount>1?'（'+quote.gpuCount+' 卡）':'';$('#price-detail').hidden=!quote;
  $('#price-status').textContent=accountBusy==='pricing'?'正在读取报价…':pricingError?'读取失败：'+pricingError:expired?'报价已过期，请重新读取。':quote?quote.region+' 报价已更新，提交时重新核对。':snapshot?pricingWaitMessage(snapshot):'选好配置后可读取报价。';
  $('#price-source').textContent=snapshot?'更新于 '+time(snapshot.checkedAt,true):'尚未读取';
  const button=$('#refresh-pricing');
  button.disabled=!!accountBusy||!!browserAction||(!accountReady()||!!appState.browser?.busy);
  button.textContent=accountBusy==='pricing'?'读取中…':'读取 AutoDL 官方报价';
}
const money = n => Number.isFinite(n) ? '¥' + n.toFixed(3) : '—';
function accountReady() { return appState.browser?.session?.state === 'ready' && appState.browser.session.browserOpen && (!appState.account?.enabled || !!appState.account.identity); }
function pickedSource() { return appState.autodlInstances?.instances?.find(i => i.id === $('#task-form').elements.sourceId.value); }
function rememberAccountResource() {
  const form=$('#task-form');
  if(!sourceLocked)manualResource={model:form.elements.gpuModel.value,custom:form.elements.customGpuModel.value,count:form.elements.gpuCount.value,regions:$$('input[name=region]:checked').map(n=>n.value)};
}
function updateAccountForm() {
  const form=$('#task-form'),locked=currentMode!=='create',boot=currentMode==='boot';
  if(locked&&!sourceLocked&&!manualResource) rememberAccountResource();
  if(!locked&&sourceLocked&&manualResource) {
    form.elements.customGpuModel.value=manualResource.custom;form.elements.gpuCount.value=manualResource.count;
    // 先恢复地区，再按新地区的型号列表恢复原来的型号选择。
    regions(manualResource.regions);keepGpuModel(manualResource.model,'所选地区当前未列出');updateGpuSelection();manualResource=null;
  }
  if(!locked)appliedSource=null;
  sourceLocked=locked;
  const source=locked?pickedSource():null;
  if(source&&(boot?source.bootable:source.cloneable)&&!appState.autodlInstances?.error&&accountReady()) {
    // 克隆只能在源实例所在地区，地区锁定。GPU 型号和数量在选中源实例时带入源实例的规格，之后可以改成其他型号或数量。
    // 地区按钮已是源实例所在地区时不重建（每2秒刷新一次，重建会让按钮失去焦点）。
    if(checkedRegions().join('|')!==source.region||$('#regions input')?.type!=='radio')regions([source.region]);
    if(appliedSource!==currentMode+':'+source.id){keepGpuModel(source.gpuModel,'源实例型号');form.elements.gpuCount.value=String(source.gpuCount);appliedSource=currentMode+':'+source.id;}
    updateGpuSelection();
    const model=selectedGpuModel(),changed=!!model&&(gpuIdentity(model)!==gpuIdentity(source.gpuModel)||form.elements.gpuCount.value!==String(source.gpuCount));
    const text=boot?source.id+' · '+source.region+' · '+source.gpuModel+' × '+source.gpuCount+'。沿用原配置与计费方式。'+(source.starting?'正在开机，等待确认。':source.status==='运行中'?'已运行，需核对 GPU 状态。':source.gpuAvailable===false?'GPU 不足，将持续等待。':source.gpuAvailable===true?'GPU 可用，执行前重新核对。':'启动监测后检查 GPU 库存。'):source.id+' · '+source.region+' · '+source.gpuModel+' × '+source.gpuCount+'。同地区克隆，可更换 GPU 型号与数量，源实例保留。'
      +(changed?'已改为 '+model+' × '+form.elements.gpuCount.value+'，请确认源环境兼容目标 GPU。':'');
    if($('#source-summary').textContent!==text)$('#source-summary').textContent=text;
  } else if(locked) $('#source-summary').textContent=boot?'请选择原实例；无卡运行中的实例需先在官网关机。':'请选择地区和型号可识别的已关机实例。';
  // 克隆只锁地区；源实例本身只被读取，程序不会改动它。
  form.elements.gpuModel.disabled=boot;form.elements.gpuCount.disabled=boot;
  form.elements.customGpuModel.disabled=boot||form.elements.gpuModel.value!==CUSTOM_GPU_MODEL;
  form.elements.customGpuModel.required=!boot&&form.elements.gpuModel.value===CUSTOM_GPU_MODEL;
  $$('input[name=region]').forEach(n=>n.disabled=locked);
  form.elements.sourceId.disabled=!locked;form.elements.sourceId.required=locked;
  // 在选择旁保留复制范围与源盘保留事实，详细完成条件放到下方折叠说明。
  $('#copy-disk-note').textContent=form.elements.copyDataDisk.checked?'复制系统盘和数据盘；目标扩容至少等于源扩容，源实例保留。':'只复制系统盘，数据盘文件不复制；源实例保留。';
  renderBudget();
}
function renderBudget() {
  renderPricing();
  const f=$('#task-form'),wallet=appState.wallet||{},s=wallet.snapshot,quote=currentQuote();
  const hours=Number(f.elements.expectedHours.value),reserve=Number(f.elements.balanceReserve.value),node=$('#budget-status');
  node.classList.remove('error');
  if(!f.elements.balanceGuard.checked){node.textContent='未启用余额保护。';return;}
  if(!Number.isFinite(hours)||hours<=0||!Number.isFinite(reserve)||reserve<0){node.textContent='请填写有效的预计运行时长和保留余额。';return;}
  if(!quote){
    node.textContent=!wallet.configured?'请在账单页配置余额 Token，或关闭余额保护。':'暂无完整报价，仍可先启用监测；提交前检查预算。';
    return;
  }
  const required=Math.ceil((quote.hourly*hours+quote.storageDaily*Math.max(1,Math.ceil(hours/24))+reserve)*1000-1e-8)/1000;
  const available=s?s.balance+(f.elements.includeVouchers.checked?s.vouchers:0):null;
  if(!wallet.configured){node.textContent='按当前报价估算需 '+money(required)+'。请配置余额 Token，或关闭余额保护。';return;}
  if(!s||wallet.stale||wallet.lastError){node.textContent='按当前报价估算需 '+money(required)+'。余额未知、已过期或查询失败，请刷新。';return;}
  node.classList.toggle('error',available<required);
  node.textContent='按当前报价估算需 '+money(required)+'，可用 '+money(available)+'（'+(f.elements.includeVouchers.checked?'含':'不含')+'代金券）：'+(available>=required?'当前估算充足':'余额不足')+'。提交前重新检查。';
}
function renderAccount() {
  const sync=appState.autodlInstances||{instances:[],checkedAt:null},rows=sync.instances||[],select=$('#task-form').elements.sourceId;
  const boot=currentMode==='boot';
  const signature=JSON.stringify([currentMode,rows,sync.checkedAt,sync.error,accountReady()]);
  if(signature!==instanceSignature) {
    instanceSignature=signature;const selected=select.value;
    const placeholder=new Option(sync.checkedAt?(boot?'请选择要开机的原实例':'请选择已关机的源实例'):'请先同步 AutoDL 实例','');placeholder.disabled=true;
    const options=rows.map(i=>{const option=new Option(i.id+' · '+(i.region||'地区未知')+' · '+(i.gpuModel||'型号未知')+' × '+(i.gpuCount??'?')+' · '+i.status,i.id);option.disabled=!(boot?i.bootable:i.cloneable)||!!sync.error||!accountReady();return option;});
    select.replaceChildren(placeholder,...options);select.value=options.some(o=>o.value===selected&&!o.disabled)?selected:'';
    $('#account-instances').innerHTML=rows.length?rows.map(i=>'<article class="instance-row"><div><strong>'+esc(i.gpuModel||'型号待核对')+' × '+esc(i.gpuCount??'?')+'</strong><span>'+esc(i.region||'地区待核对')+' · '+esc(i.status)+'</span><small>'+esc(i.id)+'</small>'+(i.bootReason?'<small class="instance-reason">'+esc(i.bootReason)+'</small>':'')+'</div><div class="instance-actions"><button type="button" class="button primary small" data-boot="'+esc(i.id)+'"'+(!i.bootable||sync.error||!accountReady()?' disabled':'')+'>等待有卡开机</button><button type="button" class="button small" data-source="'+esc(i.id)+'"'+(!i.cloneable||sync.error||!accountReady()?' disabled':'')+'>用作克隆源</button></div></article>').join(''):'<p class="hint">'+(sync.checkedAt?'当前账号没有实例。':'登录后同步实例。')+'</p>';
  }
  $('#instances-status').textContent=sync.error?'同步失败：'+sync.error:sync.checkedAt?rows.length+' 个实例 · 更新于 '+time(sync.checkedAt,true):'同步实例后可选择开机或克隆来源。';
  const busy=!!accountBusy||!!appState.browser?.busy||!!browserAction;
  for(const id of ['sync-instances','refresh-sources']){const b=$('#'+id);b.disabled=busy||!accountReady();b.textContent=accountBusy==='instances'?'正在同步…':id==='sync-instances'?'同步实例':'同步实例列表';}
  const wallet=appState.wallet||{},s=wallet.snapshot;
  $('#wallet-balance').textContent=money(s?.balance);$('#wallet-vouchers').textContent=money(s?.vouchers);
  $('#wallet-status').textContent=wallet.lastError?'余额查询失败：'+wallet.lastError:s?'最近查询 '+time(s.checkedAt,true)+(wallet.stale?' · 已过期，请刷新':''):wallet.configured?'Token 已连接，请查询余额。':'余额 Token 尚未连接。';
  const wf=$('#wallet-form'),storage=appState.credentialStorage;
  if(appState.wallet&&!walletSettingsLoaded){wf.elements.rememberToken.checked=!!wallet.rememberToken;walletSettingsLoaded=true;}
  wf.elements.token.required=!wallet.configured;
  wf.elements.token.placeholder=wallet.configured?'已配置，留空保留；填写可替换':'从 AutoDL 控制台 · 设置获取';
  $('#wallet-key-status').textContent=(wallet.configured?(wallet.rememberToken?'已配置 · 已加密记住':'已配置 · 仅本次服务使用'):'尚未配置');
  // 通知表单独立管理发送/保存期间的锁定；账号心跳仅更新钱包的存储选项。
  if(storage){const field=wf.elements.rememberToken;field.disabled=!storage.available;if(!storage.available)field.checked=false;}
  $('#refresh-wallet').disabled=!!accountBusy||!wallet.configured;$('#clear-wallet').disabled=!!accountBusy||!wallet.configured;
  $('#check-budget').disabled=!!accountBusy||!wallet.configured||!currentQuote();
  $('#check-budget').title=!wallet.configured?'请先连接余额 Token':!currentQuote()?'暂无完整报价，可先开始监测':'';
  $('#wallet-form button[type=submit]').disabled=!!accountBusy;
  updateAccountForm();
}
async function accountCommand(action,work) {
  if(accountBusy)return;accountBusy=action;renderAccount();
  try{await work();}catch(error){toast(error.message,true);}
  finally{accountBusy=null;await refresh();renderAccount();}
}
async function syncAccountInstances() {
  await accountCommand('instances',async()=>{const result=await api('/api/autodl/instances',{});appState.autodlInstances=result;renderAccount();toast('已同步 '+result.instances.length+' 个 AutoDL 实例');});
}
$('#sync-instances').addEventListener('click',()=>void syncAccountInstances());
$('#refresh-sources').addEventListener('click',()=>void syncAccountInstances());
$('#task-form').elements.sourceId.addEventListener('change',updateAccountForm);
$('#task-form').addEventListener('input',renderBudget);
$('#task-form').addEventListener('change',updateAccountForm);
$('#refresh-pricing').addEventListener('click',()=>void accountCommand('pricing',async()=>{
  const payload=taskPayload(),signature=currentPricingSignature(),revision=pricingRevision;pricingError='';
  try {
    const result=await api('/api/pricing/preview',payload);
    if(signature!==currentPricingSignature()||revision!==pricingRevision){toast('配置已变化，请按新配置重新读取报价');return;}
    pricingSnapshot=result;pricingFormSignature=signature;renderBudget();
    toast(result.quote?'已读取 AutoDL 当前配置报价':result.availability?.status==='no_stock'||(!result.available&&result.listed?.length)?'当前暂无符合条件的空闲卡，可先启用监测':'未取得完整报价，请查看原因');
  } catch(error){pricingSnapshot=null;pricingFormSignature=null;pricingError=error.message;throw error;}
}));
$('#wallet-form').addEventListener('submit',e=>{e.preventDefault();const f=e.target,value=f.elements.token.value,rememberToken=f.elements.rememberToken.checked;f.elements.token.value='';void accountCommand('wallet',async()=>{const result=await api('/api/wallet/token',{token:value,rememberToken});appState.wallet=result.wallet;walletSettingsLoaded=false;toast(rememberToken?'Token 已加密记住，余额已同步':'余额已同步；Token 仅在本次服务中使用');});});
$('#refresh-wallet').addEventListener('click',()=>void accountCommand('wallet',async()=>{const result=await api('/api/wallet/refresh',{});appState.wallet=result.wallet;toast('余额已更新');}));
$('#clear-wallet').addEventListener('click',()=>void accountCommand('wallet',async()=>{const result=await api('/api/wallet/clear-token',{});appState.wallet=result.wallet;walletSettingsLoaded=false;$('#wallet-form').elements.token.value='';toast('余额 Token 已清除');}));
$('#check-budget').addEventListener('click',()=>void accountCommand('budget',async()=>{const result=await api('/api/wallet/preflight',taskPayload());appState.wallet=result.wallet;toast('余额预检通过，提交前重新核对');}));
function resetAccountState(){walletSettingsLoaded=false;instanceSignature=null;$('#wallet-form').reset();clearPricing();}
// 实例列表的按钮只填入任务，不会立即开机；仍需在表单里确认费用并点击开始。
$('#account-instances').addEventListener('click',e=>{const button=e.target.closest('[data-source],[data-boot]');if(!button||button.disabled)return;const f=$('#task-form'),boot=!!button.dataset.boot;document.querySelector('[data-mode='+ (boot?'boot':'clone') +']').click();f.elements.sourceId.value=button.dataset.boot||button.dataset.source;updateAccountForm();$('#live-source-fields').scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
window.addEventListener('appstatechange',renderAccount);
renderAccount();

