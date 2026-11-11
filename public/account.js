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
    return '已读到匹配主机的单卡价，但暂无满足所选数量等条件的空闲 GPU。可先启用监测；找到资源后读取完整报价，自动执行任务再按设置检查余额并提交。';
  if(availability?.status==='no_match') {
    const reasons=(availability.reasons||[]).map(item=>item.reason+'（'+item.count+' 台）').join('、');
    return '已读取 '+availability.scannedHosts+' 台主机，暂无符合全部条件的资源'+(reasons?'：'+reasons:'')+'。可先启用监测，程序会保持当前条件。';
  }
  if(availability?.status==='empty')return '当前页面未读到主机，请核对专用浏览器是否已加载完成、地区筛选是否正确。未取得完整报价。';
  return '暂未取得完整配置报价；单卡价格只覆盖已读取的匹配主机。可先启用监测，找到资源后读取完整报价并核对余额。';
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
  $('#price-status').textContent=accountBusy==='pricing'?'正在读取配置页面；不会提交租用。':pricingError?'读取失败：'+pricingError:expired?'报价已过期，请重新读取。':quote?'已读取 '+quote.region+' 当前配置报价；提交时会再次核对。':snapshot?pricingWaitMessage(snapshot):'选好配置后读取报价；真实价格来自 AutoDL 页面。';
  $('#price-source').textContent=snapshot?snapshot.source+' · '+time(snapshot.checkedAt,true)+' · 当前已读取页面，非全站价格保证':'尚未读取';
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
    const text=boot?source.id+' · '+source.region+' · '+source.gpuModel+' × '+source.gpuCount+'。保留原环境与磁盘，沿用原实例计费方式。'+(source.starting?'该实例正在开机，将只检查运行结果。':source.status==='运行中'?'该实例已经运行，将核对有卡状态。':source.gpuAvailable===false?'当前 GPU 不足，开始后持续等待。':source.gpuAvailable===true?'同步时 GPU 可用，开始后重新核对。':'开始后读取原实例状态和 GPU 可用信息。'):source.id+' · '+source.region+' · '+source.gpuModel+' × '+source.gpuCount+'。地区固定为源实例所在地区；目标 GPU 型号和数量默认与源实例相同，可以更换。源实例只被读取，不会被改动。'
      +(changed?'已改为 '+model+' × '+form.elements.gpuCount.value+'：克隆后的环境与源实例相同，请确认它能在这张卡上运行（例如 50 系列需要 CUDA 12.8 及以上，程序会检查）。':'');
    if($('#source-summary').textContent!==text)$('#source-summary').textContent=text;
  } else if(locked) $('#source-summary').textContent=boot?'请先同步并选择原实例。只等待其原主机 GPU；无卡运行中的实例需要先到 AutoDL 手动关机。':'请先同步并选择已关机的源实例；无法识别地区或型号的实例不可用于自动克隆。';
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
  if(!f.elements.balanceGuard.checked){node.textContent='此任务未启用余额保护，按提交时的官方报价执行。';return;}
  if(!Number.isFinite(hours)||hours<=0||!Number.isFinite(reserve)||reserve<0){node.textContent='请填写有效的预计运行时长和保留余额。';return;}
  if(!quote){
    node.textContent=!wallet.configured?'自动执行任务已启用余额保护，请先连接余额 Token，或主动关闭余额保护。暂无完整报价时，连接后仍可先开始监测。':'暂无完整配置报价，暂不能预检所需预算。仍可先启用监测；找到资源后按完整官方报价检查余额，余额不足时不会提交。';
    return;
  }
  const required=Math.ceil((quote.hourly*hours+quote.storageDaily*Math.max(1,Math.ceil(hours/24))+reserve)*1000-1e-8)/1000;
  const available=s?s.balance+(f.elements.includeVouchers.checked?s.vouchers:0):null;
  if(!wallet.configured){node.textContent='按当前报价估算需 '+money(required)+'。请连接开发者 Token，或主动关闭余额保护。';return;}
  if(!s||wallet.stale||wallet.lastError){node.textContent='按当前报价估算需 '+money(required)+'。余额未知、已过期或查询失败，请刷新。';return;}
  node.classList.toggle('error',available<required);
  node.textContent='按当前报价估算需 '+money(required)+'，可用 '+money(available)+'（'+(f.elements.includeVouchers.checked?'含':'不含')+'代金券）：'+(available>=required?'当前估算充足':'余额不足')+'。提交前重查，不预留资金，也不自动关机。';
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
    $('#account-instances').innerHTML=rows.length?rows.map(i=>'<article class="instance-row"><div><strong>'+esc(i.gpuModel||'型号待核对')+' × '+esc(i.gpuCount??'?')+'</strong><span>'+esc(i.region||'地区待核对')+' · '+esc(i.status)+'</span><small>'+esc(i.id)+'</small>'+(i.bootReason?'<small class="instance-reason">'+esc(i.bootReason)+'</small>':'')+'</div><div class="instance-actions"><button type="button" class="button primary small" data-boot="'+esc(i.id)+'"'+(!i.bootable||sync.error||!accountReady()?' disabled':'')+'>等待有卡开机</button><button type="button" class="button small" data-source="'+esc(i.id)+'"'+(!i.cloneable||sync.error||!accountReady()?' disabled':'')+'>用作克隆源</button></div></article>').join(''):'<p class="hint">'+(sync.checkedAt?'当前账号没有实例。':'登录并同步后显示实例，不会自动创建资源。')+'</p>';
  }
  $('#instances-status').textContent=sync.error?'同步失败：'+sync.error:sync.checkedAt?'最近同步 '+time(sync.checkedAt,true)+' · '+rows.length+' 个实例，点击同步更新平台状态。':'登录并同步后，可以选择原实例抢卡开机，或同地区克隆。';
  const busy=!!accountBusy||!!appState.browser?.busy||!!browserAction;
  for(const id of ['sync-instances','refresh-sources']){const b=$('#'+id);b.disabled=busy||!accountReady();b.textContent=accountBusy==='instances'?'正在同步…':id==='sync-instances'?'同步实例':'同步实例列表';}
  const wallet=appState.wallet||{},s=wallet.snapshot;
  $('#wallet-balance').textContent=money(s?.balance);$('#wallet-vouchers').textContent=money(s?.vouchers);
  $('#wallet-status').textContent=wallet.lastError?'余额查询失败：'+wallet.lastError:s?'最近查询 '+time(s.checkedAt,true)+(wallet.stale?' · 已过期，请刷新':' · 提交前会再次查询'):wallet.configured?'Token 已连接，请查询余额。':'余额 Token 尚未连接。';
  const wf=$('#wallet-form'),storage=appState.credentialStorage;
  if(appState.wallet&&!walletSettingsLoaded){wf.elements.rememberToken.checked=!!wallet.rememberToken;walletSettingsLoaded=true;}
  wf.elements.token.required=!wallet.configured;
  wf.elements.token.placeholder=wallet.configured?'已配置，留空保留；填写可替换':'从 AutoDL 控制台 · 设置获取';
  $('#wallet-key-status').textContent=(wallet.configured?(wallet.rememberToken?'已配置 · 已加密记住':'已配置 · 仅本次服务使用'):'尚未配置')+(storage?' · '+storage.method:'');
  // 通知表单独立管理发送/保存期间的锁定；账号心跳仅更新钱包的存储选项。
  if(storage){const field=wf.elements.rememberToken;field.disabled=!storage.available;if(!storage.available)field.checked=false;}
  $('#refresh-wallet').disabled=!!accountBusy||!wallet.configured;$('#clear-wallet').disabled=!!accountBusy||!wallet.configured;
  $('#check-budget').disabled=!!accountBusy||!wallet.configured||!currentQuote();
  $('#check-budget').title=!wallet.configured?'请先连接余额 Token':!currentQuote()?'暂无完整报价，可先启用监测；找到资源后自动核对余额':'';
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
    toast(result.quote?'已读取 AutoDL 当前配置报价':result.availability?.status==='no_stock'||(!result.available&&result.listed?.length)?'当前暂无符合条件的空闲卡，可先启用监测':'未取得完整报价，请查看报价区域的具体原因');
  } catch(error){pricingSnapshot=null;pricingFormSignature=null;pricingError=error.message;throw error;}
}));
$('#wallet-form').addEventListener('submit',e=>{e.preventDefault();const f=e.target,value=f.elements.token.value,rememberToken=f.elements.rememberToken.checked;f.elements.token.value='';void accountCommand('wallet',async()=>{const result=await api('/api/wallet/token',{token:value,rememberToken});appState.wallet=result.wallet;walletSettingsLoaded=false;toast(rememberToken?'Token 已加密记住，余额已同步':'余额已同步；Token 仅在本次服务中使用');});});
$('#refresh-wallet').addEventListener('click',()=>void accountCommand('wallet',async()=>{const result=await api('/api/wallet/refresh',{});appState.wallet=result.wallet;toast('余额已更新');}));
$('#clear-wallet').addEventListener('click',()=>void accountCommand('wallet',async()=>{const result=await api('/api/wallet/clear-token',{});appState.wallet=result.wallet;walletSettingsLoaded=false;$('#wallet-form').elements.token.value='';toast('余额 Token 已从内存及保存配置中清除');}));
$('#check-budget').addEventListener('click',()=>void accountCommand('budget',async()=>{const result=await api('/api/wallet/preflight',taskPayload());appState.wallet=result.wallet;toast('当前余额通过按官方报价的预检，提交前还会重新核对');}));
function resetAccountState(){walletSettingsLoaded=false;instanceSignature=null;$('#wallet-form').reset();clearPricing();}
// 实例列表的按钮只填入任务，不会立即开机；仍需在表单里确认费用并点击开始。
$('#account-instances').addEventListener('click',e=>{const button=e.target.closest('[data-source],[data-boot]');if(!button||button.disabled)return;const f=$('#task-form'),boot=!!button.dataset.boot;document.querySelector('[data-mode='+ (boot?'boot':'clone') +']').click();f.elements.sourceId.value=button.dataset.boot||button.dataset.source;updateAccountForm();$('#live-source-fields').scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
window.addEventListener('appstatechange',renderAccount);
renderAccount();

