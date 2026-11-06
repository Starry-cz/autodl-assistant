'use strict';
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const token = $('meta[name="local-token"]').content;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = (n, full=false) => n ? new Date(n).toLocaleString('zh-CN', full ? {hour12:false} : {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '—';
const STATES = {queued:'等待首次检查',watching:'监测库存',preparing:'核对配置',submitting:'提交中',verifying:'验证实例与数据',reconciling:'等待绑定核对',paused:'已暂停',found:'已找到资源',completed:'已完成',attention:'需要处理',expired:'监测已到期',cancelled:'已停止'};
const modeLabel = mode => ({create:'新建实例',boot:'原实例开机',clone:'迁移克隆'}[mode] || mode);
const scanLabel = c => c.mode==='boot'?'检查原实例状态':c.scanScope==='first-page'?`首页优先，约每 ${c.fullScanSeconds}s 完整翻页`:'每轮完整翻页';
const ACTIVE = ['queued','watching','preparing','submitting','verifying'];
// 已停止但请求已发送的原实例任务，只允许继续核对同一实例的结果。
const canReconcileBoot = t => t.config.mode==='boot'&&t.state==='cancelled'&&t.operation?.receipt?.instanceId===t.config.sourceId;
const canResumeTask = t => canReconcileBoot(t)||(['paused','attention','found','expired'].includes(t.state)&&(t.config.mode==='boot'||!t.operation||t.operation.receipt));
let appState = {tasks:[],notifications:[],settings:{}}, currentMode='create', detailId=null, initialSettings=false, seenNotifications=null, toastTimer=null, fetching=false, browserAction=null, modelCatalogSignature=null;
const CUSTOM_GPU_MODEL = '__custom__';
let pendingConflict = null, conflictBusy = false;
async function api(url, data) {
  const response=await fetch(url,{method:data===undefined?'GET':'POST',headers:{'X-Local-Token':token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const result=await response.json();
  if(!response.ok){
    const missingInterface=response.status===404&&result.error==='NOT_FOUND'&&result.message==='接口不存在';
    const message=missingInterface?'本地后台未加载此功能接口，可能仍在运行旧版代码。请先正常停止旧后台，在项目目录运行 npm.cmd start，再刷新页面；仅刷新网页不会更新后台。':result.message||'请求失败';
    const error=new Error(message);error.status=response.status;error.code=result.error;error.conflict=result.conflict;throw error;
  }
  return result;
}
function toast(message,error=false){clearTimeout(toastTimer);const node=$('#toast');node.textContent=message;node.classList.toggle('error',error);node.classList.remove('hidden');toastTimer=setTimeout(()=>node.classList.add('hidden'),6500);}
// 暂停、到期和等待状态使用灰色，避免与成功/可用状态混淆。
function badge(state,mode){const style=['attention','reconciling'].includes(state)?'warning':['cancelled','paused','expired','queued'].includes(state)?'neutral':'';return `<span class="badge ${style}">${esc(mode==='boot'?({watching:'等待原实例空卡',preparing:'核对原实例',verifying:'确认有卡运行',found:'原实例 GPU 可用'}[state]||STATES[state]||state):(STATES[state]||state))}</span>`;}
function regions(names=['北京B区']) {
  const all=appState.regions || ['北京B区','西北B区','重庆A区','内蒙B区','北京A区','佛山区'];
  if(currentMode!=='create')names=names.slice(0,1);
  $('#regions').innerHTML=all.map(r=>`<label><input type="${currentMode!=='create'?'radio':'checkbox'}" name="region" value="${esc(r)}"${names.includes(r)?' checked':''}>${esc(r)}</label>`).join('');
  $('#region-label').innerHTML=currentMode==='clone'?'源实例地区 <small>仅同地区迁移</small>':'监测地区 <small>可多选</small>';
  renderModelCatalog();
}
function selectedGpuModel(){
  const form=$('#task-form');
  return form.elements.gpuModel.value===CUSTOM_GPU_MODEL ? form.elements.customGpuModel.value.trim() : form.elements.gpuModel.value;
}
function updateGpuSelection(){
  const form=$('#task-form'),custom=currentMode!=='boot'&&form.elements.gpuModel.value===CUSTOM_GPU_MODEL,model=selectedGpuModel();
  $('#custom-gpu-field').classList.toggle('hidden',!custom);
  form.elements.customGpuModel.disabled=!custom;form.elements.customGpuModel.required=custom;
  // 克隆：型号和数量默认取源实例的规格，可以更换；源实例本身只读取。
  const source=currentMode==='clone'?window.pickedSource?.():null;
  const same=!!source&&gpuIdentity(model)===gpuIdentity(source.gpuModel)&&form.elements.gpuCount.value===String(source.gpuCount);
  $('#gpu-model-title').textContent=currentMode!=='clone'?'GPU 精确型号':source?'目标 GPU 型号（可更换）':'目标 GPU 型号';
  $('#metric-gpu-model').textContent=model || '尚未选择';
  $('#metric-gpu-model').classList.toggle('long-model',model.length>22);
  $('#metric-gpu-detail').textContent=model ? form.elements.gpuCount.value+' 张 · '+(currentMode==='boot'?'原实例开机':currentMode!=='clone'?'新建实例':!source||same?'同源型号克隆':'克隆到其他型号') : '由你指定，不自动代选';
  renderGpuCatalogStatus();
}
// 任务的环境 CUDA：新建取所选镜像；克隆取首次检查时从源实例读到的 CUDA。
const taskCuda=t=>t.config.mode==='boot'?'保留原环境':t.config.mode==='clone'?(t.source?.sourceCuda?'CUDA '+t.source.sourceCuda+'（源实例）':'CUDA 跟随源实例'):'CUDA '+t.config.cuda;
// 型号目录来自 AutoDL 创建页的“GPU 型号”筛选（按地区同步，括号内为同步时的空闲/总数）；只列所选地区有的型号。
const checkedRegions=()=>$$('input[name=region]:checked').map(n=>n.value);
const gpuIdentity=value=>String(value||'').toUpperCase().replace(/[\s_-]/g,'');
function catalogModels(){
  const catalog=appState.gpuCatalog,picked=checkedRegions(),models=new Map();
  for(const row of catalog?.regions||[]){
    if(!picked.includes(row.region))continue;
    for(const item of row.models){
      const entry=models.get(item.model)||{model:item.model,regions:[]};
      entry.regions.push({region:row.region,available:item.available,total:item.total,disabled:item.disabled});
      models.set(item.model,entry);
    }
  }
  return [...models.values()];
}
function catalogLabel(entry,multi){
  const stock=r=>Number.isInteger(r.available)&&Number.isInteger(r.total)?r.available+'/'+r.total:'';
  const parts=entry.regions.map(r=>(multi?r.region+' ':'')+stock(r)).map(s=>s.trim()).filter(Boolean);
  return entry.model+(parts.length?'（'+parts.join('，')+'）':'')+(entry.regions.every(r=>r.disabled)?'（当前不可选）':'');
}
// 当前选择不在列表中时保留为单独一项（例如换了地区或克隆源的型号），不悄悄换成别的卡；其他临时项删除。
function keepGpuModel(value,note){
  const select=$('#task-form').elements.gpuModel;
  for(const option of [...select.options])if(option.dataset.extra&&option.value!==value)option.remove();
  if(value&&value!==CUSTOM_GPU_MODEL){
    let option=[...select.options].find(o=>o.value===value);
    if(!option){option=new Option(value,'');option.value=value;option.dataset.extra='1';select.insertBefore(option,select.querySelector('option[value="'+CUSTOM_GPU_MODEL+'"]'));}
    if(option.dataset.extra&&note)option.textContent=value+'（'+note+'）';
  }
  select.value=value;
}
function renderModelCatalog(){
  const catalog=appState.gpuCatalog,entries=catalogModels(),multi=checkedRegions().length>1;
  const rows=entries.map(entry=>[entry.model,catalogLabel(entry,multi)]);
  const prompt=!catalog?'请先点“同步 AutoDL 型号”':!checkedRegions().length?'请先选择地区':rows.length?'请选择 GPU 型号':'所选地区没有同步到型号';
  const signature=JSON.stringify([prompt,rows]);
  if(signature!==modelCatalogSignature){
    modelCatalogSignature=signature;
    const form=$('#task-form'),select=form.elements.gpuModel,selected=select.value;
    const placeholder=new Option(prompt,'');placeholder.disabled=true;
    select.replaceChildren(placeholder,...rows.map(([value,label])=>new Option(label,value)),new Option('其他型号（精确填写）',CUSTOM_GPU_MODEL));
    keepGpuModel(selected,rows.some(([value])=>value===selected)?'':'所选地区当前未列出');
    updateGpuSelection();
  }
  renderGpuCatalogStatus();
}
let gpuSyncing=false,gpuSyncError='',gpuAutoFor=null;
// 同步时间与快照含义一起显示，避免将目录数值误认为即时库存。
function renderGpuCatalogStatus(){
  const catalog=appState.gpuCatalog,ready=!!window.accountReady?.(),button=$('#sync-gpus');
  // 后台会等当前一轮监测结束再读取，监测任务运行时也可以同步。
  button.disabled=gpuSyncing||!ready;
  button.textContent=gpuSyncing?'正在同步…':'同步 AutoDL 型号';
  const picked=checkedRegions(),issues=[];
  for(const region of catalog?picked:[]){
    const row=catalog.regions.find(item=>item.region===region);
    if(!row)issues.push(region+'未同步');
    else if(row.error)issues.push(region+'读取失败');
    else if(row.missing)issues.push(region+'页面上没有此地区');
    else if(row.disabled)issues.push(region+'当前不可选');
    else if(!row.models.length)issues.push(region+'没有型号');
  }
  const value=$('#task-form').elements.gpuModel.value,key=gpuIdentity(value),clone=currentMode==='clone';
  // 与监测时选型号的规则一致：忽略大小写、空格、横线和下划线。
  const unlisted=!!value&&value!==CUSTOM_GPU_MODEL&&!catalogModels().some(entry=>gpuIdentity(entry.model)===key);
  // 常态仅显示同步时间；读取异常和型号不匹配仍直接展示，避免重要状态被长说明淹没。
  const text=gpuSyncing?'正在同步各地区 GPU 型号与库存…'
    :gpuSyncError?'同步失败：'+gpuSyncError
    :!catalog?(ready?'同步后选择所需 GPU 型号。':'连接账号后同步 GPU 型号。')
    :'同步于 '+time(catalog.checkedAt,true)+' · 括号内为空闲 / 总数快照。'+(issues.length?issues.join('、')+'，请重新同步。':'')
      +(unlisted?(clone?'源实例型号未列出，请重新同步核对。':'所选型号未列出，请核对地区或重新同步。'):'');
  const hint=$('#gpu-model-hint');
  if(hint.textContent!==text)hint.textContent=text;
  hint.classList.toggle('error',!!gpuSyncError);
}
async function syncGpuCatalog({auto=false}={}){
  if(gpuSyncing)return;gpuSyncing=true;gpuSyncError='';renderGpuCatalogStatus();
  try{
    const catalog=await api('/api/autodl/gpus',{});appState.gpuCatalog=catalog;
    const failed=catalog.regions.filter(row=>row.error||row.missing||row.disabled).map(row=>row.region);
    if(!auto||failed.length)toast('已同步 '+catalog.regions.filter(row=>row.models.length).length+' 个地区的 AutoDL 型号'+(failed.length?'；'+failed.join('、')+' 未读到，可重新同步':''),failed.length>0);
  }catch(error){gpuSyncError=(auto?'登录后自动刷新没有完成（'+error.message+'），可稍后点“同步 AutoDL 型号”':error.message);if(!auto)toast('同步 AutoDL 型号失败：'+error.message,true);}
  finally{gpuSyncing=false;renderModelCatalog();await refresh();}
}
// 登录后的首次同步由账号页统一串行安排，避免多个页面同时争用专用浏览器。
function updateForm(){
  const form=$('#task-form'),execute=form.elements.action.value==='execute',boot=currentMode==='boot';
  $('#consent-label').classList.toggle('hidden',!execute);
  form.elements.paidConsent.required=execute;
  form.elements.sourceId.required=currentMode!=='create';
  form.elements.imagePath.required=currentMode==='create';
  $('#create-fields').classList.toggle('hidden',currentMode!=='create');
  $('#clone-fields').classList.toggle('hidden',currentMode==='create');
  $('#clone-options').classList.toggle('hidden',currentMode!=='clone');
  $('.flow-card').classList.toggle('hidden',currentMode!=='clone');
  $('#source-label').textContent=boot?'选择要开机的原实例':'选择源实例';
  // 开机沿用原实例配置，隐藏并禁用只属于新租/克隆的控件，避免必填项挡住提交。
  for(const id of ['resource-fields','pricing-fields','balance-fields','scan-fields']) {
    const block=$('#'+id);block.classList.toggle('hidden',boot);
    for(const input of $$('input,select,button',block))input.disabled=boot;
  }
  form.elements.gpuModel.required=!boot;
  form.elements.action.options[0].textContent=boot?'自动为原实例有卡开机':currentMode==='clone'?'自动克隆并开机':'自动创建并开机';
  form.elements.action.options[1].textContent=boot?'只通知原实例 GPU 可用':'只通知，停在提交之前';
  for(const choice of $$('[data-action-choice]')) {
    const selected=choice.dataset.actionChoice===form.elements.action.value;
    choice.classList.toggle('selected',selected);choice.setAttribute('aria-pressed',String(selected));
  }
  $('#action-execute-title').textContent=boot?'自动开机':currentMode==='clone'?'自动克隆并开机':'自动新租';
  $('#action-execute-description').textContent=boot?'原主机有卡后，为所选实例开机':currentMode==='clone'?'满足条件后克隆环境并启动':'满足条件后创建并启动实例';
  $('#action-notify-description').textContent=boot?'发现原主机有卡时提醒，不开机':'发现符合条件的资源后提醒，不创建实例';
  $('#consent-text').textContent=boot?'我授权为选中的原实例自动有卡开机，沿用原计费方式并产生费用。运行后需在 AutoDL 自行关机。':'我授权按提交时 AutoDL 报价自动创建或克隆并开机，费用由本人承担。预览不锁价，运行后需自行关机。';
  $('#submit-task').innerHTML=(boot?(execute?'开始等待并开机':'监测原实例 GPU'):(execute?'启用真实抢卡':'开始真实库存监测'))+' <span>→</span>';
  $('#task-footnote').textContent=boot?'确认原实例有卡运行后结束任务。暂停只停止本地检查，不会关闭云端实例。':'成功后停止当前任务；提交结果不明时先核对，不重复下单。';
  form.elements.fullScanSeconds.disabled=boot||form.elements.scanScope.value!=='first-page';
  updateGpuSelection();
  window.updateAccountForm?.();
  window.renderAccount?.();
  window.updateImageForm?.();
  renderBrowser();
}
function renderServer(){
  // 磁盘代码已更新而后台仍在运行旧版本时提示；旧版后台的状态里没有 server 字段。
  const node=$('#stale-backend'),server=appState.server,stale=!server||server.codeChanged===true;
  node.hidden=!stale;
  const text=!server?'本地后台仍是旧版本，新功能没有生效。关闭网页或再次双击“启动监测台.cmd”都不会替换已在运行的后台。请先暂停任务、确认没有“提交中/验证实例与数据/等待绑定核对”的任务，再在任务管理器“详细信息”中结束本项目的 node.exe（再次双击启动程序会显示它的 PID），关闭专用浏览器窗口，然后重新双击启动。'
    :'磁盘上的程序已更新，但本地后台仍在运行启动时的代码。关闭网页不会停止后台。请在没有“提交中/验证实例与数据”的任务时运行 npm.cmd run stop，或再次双击“启动监测台.cmd”按提示输入 Y 重启。';
  if(stale&&node.textContent!==text)node.textContent=text;
}
function renderBrowser(){
  const session=appState.browser?.session || {state:'not_open',label:'未打开登录',message:'先打开专用浏览器，在 AutoDL 官方页面完成登录。',browserOpen:false};
  const ready=session.state==='ready'&&session.browserOpen&&(!appState.account?.enabled||!!appState.account.identity), checking=session.state==='checking';
  const busy=!!browserAction||checking, card=$('#autodl-connection'), badge=$('#browser-session-badge');
  card.dataset.session=session.state;
  badge.textContent=session.label;badge.className='badge'+(ready?'': ['expired','human_required','network_blocked','error','unknown','login_required'].includes(session.state)?' warning':' neutral');
  if(session.state==='ready'&&!ready)badge.textContent='账号待确认';
  if($('#browser-status').textContent!==session.message)$('#browser-status').textContent=session.message;
  $('#browser-checked-at').textContent=session.checkedAt?'最近核验：'+time(session.checkedAt,true)+' · 仅代表当时状态，任务执行时仍会检查。':'尚未核验；打开浏览器不代表已登录。';
  $('#open-browser').disabled=busy;
  $('#open-browser').textContent=browserAction==='open'?'正在连接…':ready?'重新连接账号':['expired','login_required'].includes(session.state)?'重新登录':session.state==='human_required'?'处理人工验证':session.state==='network_blocked'?'重试打开登录':'打开登录';
  $('#check-browser').disabled=busy||!session.browserOpen;
  $('#check-browser').textContent=browserAction==='check'||checking?'正在检查…':'检查登录状态';
  $('#logout-browser').disabled=busy||!!appState.browser?.busy;
  $('#logout-browser').textContent=browserAction==='logout'?'正在退出…':'退出 AutoDL';
  $('#check-browser').title=session.browserOpen?'只读检查，不会租用 GPU':'请先打开专用浏览器';
  $('#browser-busy').classList.toggle('hidden',!appState.browser?.busy||!!browserAction||checking);
  $('#live-note').textContent=ready?(currentMode==='boot'?'沿用原 GPU、地区与计费方式。无卡运行中的实例，请先到 AutoDL 手动关机。':'已连接 AutoDL，可选择仅提醒或自动执行。'):'点击左下角账号入口连接 AutoDL，再开始监测。';
  $('#live-note').hidden=ready&&currentMode!=='boot';
}
function focusLogin(){
  $('.nav-item[data-view="profile"]').click();
  $('#autodl-connection').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
  (appState.browser?.session?.browserOpen?$('#check-browser'):$('#open-browser')).focus({preventScroll:true});
}
async function browserCommand(action,data={}){
  if(browserAction)return;
  browserAction=action;renderBrowser();
  try{
    const result=await api('/api/browser/'+action,data);
    if(result.session)appState.browser={...appState.browser,session:result.session};
    window.clearPricing?.();
    if(action==='logout'){initialSettings=false;window.resetAccountState?.();$('#logout-dialog').close();}
    toast(result.message,action==='check'&&result.session?.state!=='ready');
  }catch(error){toast(error.message,true);}
  finally{browserAction=null;renderBrowser();await refresh();if(action==='logout')window.aiRenderState?.(true);}
}
function renderTasks(){
  const tasks=appState.tasks;
  $('#metric-active').textContent=tasks.filter(t=>ACTIVE.includes(t.state)).length;
  $('#metric-done').textContent=tasks.filter(t=>t.state==='completed').length;
  $('#metric-attention').textContent=tasks.filter(t=>['attention','reconciling'].includes(t.state)).length;
  $('#task-count').textContent=tasks.length;
  const html=tasks.length?tasks.map(t=>{
    const c=t.config,progress=t.state==='completed'?(c.mode==='clone'?(c.copyDataDisk!==false?'数据盘复制完成，目标 GPU 实例已运行':'系统盘克隆完成，目标 GPU 实例已运行（未复制数据盘）'):c.mode==='boot'?'原实例已确认有卡运行':'目标 GPU 实例已运行'):(t.lastError || t.balanceLow?.message || t.lastProgress || t.lastScan?.summary || '等待资源检查');
    return `<article class="task-card" data-task-id="${esc(t.id)}"><div class="task-top"><h3 title="${esc(c.name)}">${esc(c.name)}</h3>${badge(t.state,c.mode)}</div><div class="task-meta"><span>${modeLabel(c.mode)}</span><span>${esc(c.gpuModel)} × ${c.gpuCount}</span><span>${esc(c.regions.join(' / '))}</span><span>${esc(taskCuda(t))}</span></div><div class="task-progress${t.lastError||t.balanceLow?' error':''}">${esc(progress)}</div>${window.taskMonitor.summary(t)}<div class="task-bottom"><small>检查 ${t.attempts} 次 · ${c.pollSeconds}s 间隔 · ${esc(scanLabel(c))}<br>${t.result?.id?`实例 ${esc(t.result.id)}`:`更新于 ${time(t.updatedAt)}`}</small><div class="task-buttons">${ACTIVE.includes(t.state)?`<button class="text-button" data-command="pause" data-id="${t.id}">暂停</button>`:''}${canResumeTask(t)?`<button class="text-button" data-command="resume" data-id="${t.id}">${canReconcileBoot(t)?'继续核对原实例':'恢复'}</button>`:''}<button class="text-button" data-detail="${t.id}">详情与日志 ↗</button></div></div></article>`;
  }).join(''):`<div class="empty"><div class="empty-icon">◫</div><h3>暂无任务</h3><p>配置任务后开始监测。</p></div>`;
  replaceKeeping($('#tasks'),html);
  window.taskMonitor.tick();
  renderQueueToggle();
}
// 每2秒刷新一次：内容没有变化时不重写，变化时保留滚动位置和键盘焦点所在的按钮。
function replaceKeeping(node,html){
  if(node.dataset.html===html)return;
  const active=node.contains(document.activeElement)?document.activeElement:null;
  const focusKey=active?.dataset.command?'[data-command="'+active.dataset.command+'"][data-id="'+active.dataset.id+'"]':active?.dataset.detail?'[data-detail="'+active.dataset.detail+'"]':null;
  const top=node.scrollTop;
  node.innerHTML=html;node.dataset.html=html;node.scrollTop=top;
  if(focusKey)node.querySelector(focusKey)?.focus({preventScroll:true});
}
let queueCollapsed=(()=>{try{return localStorage.getItem('queueCollapsed')==='1';}catch{return false;}})();
function renderQueueToggle(){
  const panel=$('#queue-panel'),button=$('#toggle-queue'),tasks=appState.tasks||[];
  panel.classList.toggle('collapsed',queueCollapsed);
  button.textContent=queueCollapsed?'展开':'收起';button.setAttribute('aria-expanded',String(!queueCollapsed));
  const active=tasks.filter(t=>ACTIVE.includes(t.state)).length,attention=tasks.filter(t=>['attention','reconciling'].includes(t.state)).length;
  $('#queue-summary').textContent=queueCollapsed?'已收起：进行中 '+active+' 个，需要处理 '+attention+' 个，其余 '+(tasks.length-active-attention)+' 个。':'无库存时静默等待，关键变化时通知。';
  $('#queue-summary').hidden=!queueCollapsed;
}
$('#toggle-queue').addEventListener('click',()=>{queueCollapsed=!queueCollapsed;try{localStorage.setItem('queueCollapsed',queueCollapsed?'1':'0');}catch{}renderQueueToggle();});
function delivery(n){const values=Object.entries(n.deliveries||{});return values.length?values.map(([key,val])=>`${key==='wechat'?'微信':'Webhook'}：${val.ok?'已发送':`发送失败（${val.error||'等待重试'}）`}`).join(' · '):'已记录本地消息';}
function renderNotifications(){
  $('#unread').textContent=appState.notifications.filter(n=>!n.read).length;
  replaceKeeping($('#notification-list'),appState.notifications.length?appState.notifications.map(n=>`<article class="notification-item"><h3>${!n.read?'<i class="online-dot"></i>':''}${esc(n.name)}<time>${time(n.at,true)}</time></h3><p>${esc(n.message)}</p><small>${esc(delivery(n))}</small></article>`).join(''):`<div class="empty"><div class="empty-icon">♧</div><h3>暂时没有新消息</h3><p>有空卡、执行完成或需要你处理时，会在这里留下消息。</p></div>`);
  if(seenNotifications){for(const n of appState.notifications){if(!seenNotifications.has(n.id)&&'Notification'in window&&Notification.permission==='granted'){new Notification('AutoDL 抢卡助手 · '+n.name,{body:n.message,tag:n.id,icon:'/favicon.svg'});}seenNotifications.add(n.id);}}
  else seenNotifications=new Set(appState.notifications.map(n=>n.id));
}
function renderDetail(){
  const t=appState.tasks.find(t=>t.id===detailId);if(!t)return;const c=t.config;
  if($('#task-dialog').contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
  $('#detail-title').textContent=c.name;
  const html=`<div id="detail-state">${badge(t.state,c.mode)} 真实 AutoDL 任务 · ${c.action==='execute'?'发现后自动提交':'仅监测通知'}</div><div class="detail-grid"><div><small>资源条件</small>${esc(c.gpuModel)} × ${c.gpuCount} / ${esc(taskCuda(t))}<br>${esc(c.regions.join('、'))}<br>${c.pollSeconds}s 检查间隔 · ${esc(scanLabel(c))}</div><div><small>${c.mode==='boot'?'原实例计费':c.pricePolicy==='official'?'平台报价':'单价边界'}</small>${c.mode==='boot'?'沿用原实例计费方式和配置。请在 AutoDL 核对价格；本工具不修改计费方式。':c.pricePolicy==='official'?(t.quote?`按平台报价：单卡 ¥${esc(t.quote.host?.price)}/时<br>配置 ¥${esc(t.quote.hourly)}/时，磁盘 ¥${esc(t.quote.storageDaily)}/日`:'按提交时的平台报价，等待完整报价'):`单卡 ≤ ¥${esc(c.maxGpuHourly)}/时<br>配置总价 ≤ ¥${esc(c.maxTotalHourly)}/时，磁盘 ≤ ¥${esc(c.maxStorageDaily)}/日`}</div><div><small>${c.mode==='boot'?'要开机的原实例':c.mode==='clone'?'源实例':'基础镜像'}</small>${esc(c.mode!=='create'?c.sourceId:c.imagePath.join(' / ')||'待核对')}${c.mode==='clone'?(t.source?'<br>源实例 '+esc(t.source.gpuModel||'型号未知')+' × '+esc(t.source.gpuCount??'?')+' · '+esc(t.source.sourceCuda?'CUDA '+t.source.sourceCuda:'CUDA 待读取')+'（只读）':'')+'<br>'+(c.copyDataDisk!==false?'含数据盘复制':'仅系统盘，未复制数据盘'):''}</div><div><small>提交状态</small>${t.operation?esc({intent:'操作意图已保存',click_started:'已进入点击，结果需核对',accepted:'已提交，继续核对实例'}[t.operation.stage]||t.operation.stage):'尚未提交'}<br>${t.operation?.receipt?.instanceId?esc(t.operation.receipt.instanceId):''}</div></div>${t.balanceCheck?.pendingQuote?'<p class="dialog-note">余额接口已连接，等待完整官方报价后判断是否充足；提交前会重新核对。</p>':t.balanceCheck?`<p class="dialog-note">最近余额预检：可用 ¥${esc(t.balanceCheck.available)} / 所需 ¥${esc(t.balanceCheck.required)}，按${t.balanceCheck.basis==='limits'?'价格上限':'实际报价'}及预计 ${esc(t.balanceCheck.hours)} 小时估算，${t.balanceCheck.includeVouchers?'含':'不含'}代金券。预检于 ${time(t.balanceCheck.checkedAt,true)}。</p>`:''}${t.lastError?`<div class="notice">${esc(t.lastError)}</div>`:''}${(t.hostCooldowns||[]).some(r=>r.until>appState.now)?`<p class="dialog-note">暂不选择的主机（最近被平台拒绝下单，到时自动恢复）：${(t.hostCooldowns||[]).filter(r=>r.until>appState.now).map(r=>esc(r.hostNumber||r.hostId)+' 约 '+Math.max(1,Math.ceil((r.until-appState.now)/60000))+' 分钟后，'+esc(r.reason)).join('；')}</p>`:''}${t.quote?`<p class="dialog-note">最后报价：配置 ¥${t.quote.hourly}/时，磁盘 ¥${t.quote.storageDaily}/日，额外扩容 ${t.quote.extraDiskGB} GB。报价不是总消费封顶；任务完成后云端实例会持续运行。</p>`:''}<div class="detail-actions">${ACTIVE.includes(t.state)?`<button class="button small" data-command="pause" data-id="${t.id}">暂停检查</button>`:''}${canResumeTask(t)?`<button class="button small" data-command="resume" data-id="${t.id}">${canReconcileBoot(t)?'继续核对原实例':'恢复检查'}</button>`:''}${!['completed','cancelled'].includes(t.state)?`<button class="button small danger" data-command="cancel" data-id="${t.id}">停止本地任务</button>`:''}</div>${c.mode!=='boot'&&t.operation&&['attention','reconciling','paused','cancelled'].includes(t.state)?`<form class="inline-form" id="attach-form"><label>核对 AutoDL 后，填写此次创建的目标实例 ID<input name="instanceId" placeholder="目标完整 ID，不是源实例" required></label><button class="button small" type="submit">校验并绑定</button></form>`:''}${c.mode!=='boot'&&t.operation&&!t.operation.receipt?.instanceId&&['click_started','accepted'].includes(t.operation.stage)&&['attention','reconciling','paused','cancelled'].includes(t.state)?`<div class="notice"><p>没有可绑定的新实例？程序可重新读取当前账号的完整实例列表：全部都是提交前已有的实例时，才确认这次点击没有创建实例并清除提交记录，之后可恢复任务或新建同型号任务。点击后至少等待2分钟再核对。</p><button type="button" class="button small" data-command="recheck" data-id="${t.id}">重新核对实例列表</button></div>`:''}${t.operation?.receipt&&c.mode==='clone'&&c.copyDataDisk!==false&&['attention','verifying','paused'].includes(t.state)?`<div class="notice"><p>若页面没有明确的复制完成状态，请登录目标实例确认数据盘文件完整，再点下方按钮。不要仅凭开机成功确认。</p><label class="check-label"><input type="checkbox" id="data-confirmed">我已检查目标数据盘，数据复制完整</label><button type="button" class="button small" data-command="verify-data" data-id="${t.id}">提交人工数据核验</button></div>`:''}${window.taskMonitor.history(t)}<div class="logs"><div class="logs-heading"><h3>运行日志 <span class="count">${t.logs.length}</span></h3><button type="button" class="button small" data-export-logs="${esc(t.id)}">导出日志</button></div><div class="log-list">${[...t.logs].reverse().map(l=>`<div class="log ${esc(l.level)}" data-key="${esc(l.at+':'+l.message.slice(0,40))}"><time>${time(l.at)}</time><span>${esc(l.message)}</span></div>`).join('')}</div></div>`;
  const content=$('#detail-content');if(content.dataset.html===html)return;
  // 记下日志区里看到的第一条，重写后把它放回同一位置；位于最上方时保持在最上方，便于看到新日志。
  const dialog=$('#task-dialog'),oldList=content.querySelector('.log-list'),dialogTop=dialog.scrollTop;
  const checked=$('#data-confirmed')?.checked,typed=$('#attach-form [name=instanceId]')?.value;
  // 新采样到来时仍保留用户展开的图表，不打断详情和日志的浏览位置。
  const historyOpen=content.querySelector('.task-monitor-history')?.open,chartLeft=content.querySelector('.task-sample-chart')?.scrollLeft;
  let anchor=null;
  if(oldList&&oldList.scrollTop>4){const box=oldList.getBoundingClientRect();const first=[...oldList.querySelectorAll('.log')].find(el=>el.getBoundingClientRect().bottom>box.top+1);
    if(first)anchor={key:first.dataset.key,offset:first.getBoundingClientRect().top-box.top,top:oldList.scrollTop};}
  content.innerHTML=html;content.dataset.html=html;
  const history=content.querySelector('.task-monitor-history');if(history)history.open=!!historyOpen;
  const chart=content.querySelector('.task-sample-chart');if(chart&&chartLeft)chart.scrollLeft=chartLeft;
  dialog.scrollTop=dialogTop;
  const list=content.querySelector('.log-list');
  if(list&&anchor){const same=[...list.querySelectorAll('.log')].find(el=>el.dataset.key===anchor.key);
    list.scrollTop=same?list.scrollTop+same.getBoundingClientRect().top-list.getBoundingClientRect().top-anchor.offset:anchor.top;}
  if(checked&&$('#data-confirmed'))$('#data-confirmed').checked=true;
  if(typed&&$('#attach-form [name=instanceId]'))$('#attach-form [name=instanceId]').value=typed;
  $('#attach-form')?.addEventListener('submit',async e=>{e.preventDefault();await perform('attach',t.id,{instanceId:e.target.elements.instanceId.value});});
  window.taskMonitor.tick();
}
// 打开另一个任务的详情时从头显示。
function openDetail(id){detailId=id;$('#detail-content').dataset.html='';$('#detail-content').innerHTML='';renderDetail();$('#task-dialog').showModal();}
async function refresh(){
  if(fetching)return;fetching=true;
  try{const previousCatalog=appState.gpuCatalog,previousOwner=appState.account?.identity?.ownerId;appState=await api('/api/state');window.taskMonitor.setClock(appState.now);
    // 同步刚完成时，同步前发出的轮询结果可能更旧；保留较新的型号目录。
    if(previousCatalog&&previousOwner===appState.account?.identity?.ownerId&&!(appState.gpuCatalog?.checkedAt>=previousCatalog.checkedAt))appState.gpuCatalog=previousCatalog;
    if(previousOwner!==appState.account?.identity?.ownerId){window.resetAccountState?.();seenNotifications=null;$('#task-form').elements.paidConsent.checked=false;if($('#task-dialog').open)$('#task-dialog').close();detailId=null;}
    $('#connection').textContent='已连接';$('#last-updated').textContent='最后同步 '+time(appState.now);renderServer();renderModelCatalog();renderBrowser();
    renderTasks();renderNotifications();if(detailId&&$('#task-dialog').open)renderDetail();
    if(!initialSettings){initialSettings=true;const form=$('#settings-form');for(const key of Object.keys(appState.settings)){if(form.elements[key]){if(form.elements[key].type==='checkbox')form.elements[key].checked=appState.settings[key];else form.elements[key].value=appState.settings[key];}}}
    window.dispatchEvent(new Event('appstatechange'));
  }catch(e){$('#connection').textContent='已断开';$('#last-updated').textContent='服务未连接，监测可能已经停止';}finally{fetching=false;}
}
async function perform(command,id,data={}){
  if(command==='cancel'&&!confirm('停止后不再检查。云端已创建的实例和磁盘会保留，仍可能计费，需到 AutoDL 管理。继续停止本地任务？'))return;
  if(command==='verify-data'){if(!$('#data-confirmed')?.checked){toast('请先确认已核验目标数据盘的文件完整',true);return;}data.confirmed=true;}
  if(command==='recheck'){if(!confirm('将只读重新读取 AutoDL 实例列表。没有新增实例时清除此次提交记录；有新增实例时保留记录，请核对后绑定。继续？'))return;data.confirmed=true;}
  try{const result=await api(`/api/tasks/${id}/${command}`,data);
    toast(command==='attach'?'目标实例已绑定':command==='recheck'?(result.result?.cleared?'核对完成：没有新增实例，已清除此次提交记录':'实例列表有提交前没有的实例 '+(result.result?.extra||[]).map(i=>i.id).slice(0,3).join('、')+'，请核对后绑定'):'任务已更新',command==='recheck'&&!result.result?.cleared);
    await refresh();}catch(e){toast(e.message,true);}
}
$$('.nav-item').forEach(button=>button.addEventListener('click',()=>{
  // 切页后回到标题，避免长表单的滚动位置让新页面从中间显示。
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b===button);if(b===button)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $$('.view').forEach(v=>v.classList.toggle('hidden',v.id!==button.dataset.view));
  $('#view-title').textContent={dashboard:'抢卡控制台',overview:'监控室',fleet:'我的实例',billing:'账单',profile:'账号与连接',notifications:'消息中心',settings:'通知设置',ai:'AI 环境与选卡'}[button.dataset.view];
  window.dispatchEvent(new CustomEvent('appviewchange',{detail:{view:button.dataset.view}}));
  window.scrollTo({top:0,behavior:'instant'});
}));
$$('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
  if(currentMode==='create'&&button.dataset.mode!=='create')window.rememberAccountResource?.();
  currentMode=button.dataset.mode;$('#task-form').elements.paidConsent.checked=false;$$('[data-mode]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-selected',b===button);});
  const selected=$$('input[name=region]:checked').map(n=>n.value);regions(selected);updateForm();
  // 每种模式从第一项配置开始，保留已填值，只重置面板滚动位置。
  $('.config-fields').scrollTop=0;
}));
$('#task-form').elements.action.addEventListener('change',updateForm);
$('#action-choices').addEventListener('click',event=>{
  const button=event.target.closest('[data-action-choice]');if(!button)return;
  $('#task-form').elements.action.value=button.dataset.actionChoice;
  $('#task-form').elements.paidConsent.checked=false;updateForm();
});
// 图表筛选只把资源条件填入表单，不建立任务，也不沿用之前勾选的费用授权。
window.applyMarketSelection=({model,region})=>{
  $('.nav-item[data-view="dashboard"]').click();$('[data-mode="create"]').click();
  if(region)regions([region]);renderModelCatalog();if(model)keepGpuModel(model,'目录型号');
  $('#task-form').elements.paidConsent.checked=false;updateForm();
  $('#resource-fields').scrollIntoView({block:'start'});toast('已填入资源条件，请选择提醒或自动执行并核对配置。');
};
$('#task-form').elements.scanScope.addEventListener('change',updateForm);
$('#task-form').elements.gpuModel.addEventListener('change',()=>{keepGpuModel($('#task-form').elements.gpuModel.value);updateGpuSelection();});
$('#regions').addEventListener('change',renderModelCatalog);
$('#sync-gpus').addEventListener('click',()=>void syncGpuCatalog());
$('#task-form').elements.gpuCount.addEventListener('change',updateGpuSelection);
$('#task-form').elements.customGpuModel.addEventListener('input',updateGpuSelection);
function taskPayload(form=$('#task-form')) {
  // 原实例参数只来自同步结果，不把隐藏的新建镜像或报价提交给开机接口。
  if(currentMode==='boot') {
    const source=window.pickedSource?.();
    return {provider:'autodl',mode:'boot',name:form.elements.name.value,sourceId:form.elements.sourceId.value,
      gpuModel:source?.gpuModel||'',gpuCount:source?.gpuCount||1,regions:source?[source.region]:[],
      action:form.elements.action.value,paidConsent:form.elements.paidConsent.checked,
      pollSeconds:form.elements.pollSeconds.value,timeoutMinutes:form.elements.timeoutMinutes.value};
  }
  const data=Object.fromEntries(new FormData(form));
  data.gpuModel=selectedGpuModel();data.gpuCount=form.elements.gpuCount.value;delete data.customGpuModel;
  data.provider='autodl';data.pricePolicy='official';
  data.mode=currentMode;data.regions=$$('input[name=region]:checked').map(n=>n.value);delete data.region;
  data.imagePath=form.elements.imagePath.value.split('/').map(s=>s.trim()).filter(Boolean);
  for(const key of ['paidConsent','copyDataDisk','balanceGuard','includeVouchers']) data[key]=form.elements[key].checked;
  return data;
}
function showTaskConflict(error, data) {
  const identity=value=>String(value||'').toUpperCase().replace(/[\s_-]/g,'');
  const previous=appState.tasks.find(t=>t.config.mode===data.mode
    && (data.mode!=='create'?t.config.sourceId===data.sourceId:identity(t.config.gpuModel)===identity(data.gpuModel))
    && (!['cancelled','expired','completed','found'].includes(t.state)||(t.operation&&t.state!=='completed')));
  const conflict=error.conflict||(previous?{id:previous.id,name:previous.config.name,state:previous.state,
    gpuModel:previous.config.gpuModel,cuda:previous.config.cuda,regions:previous.config.regions,
    lastError:previous.lastError,hasOperation:!!previous.operation,replaceable:false}:null);
  if(!conflict){toast(error.message+'。请查看下方任务列表。',true);return;}
  pendingConflict={data:structuredClone(data),signature:JSON.stringify(data),conflict};
  $('#conflict-old').textContent=conflict.name+' · '+(STATES[conflict.state]||conflict.state)+' · '+conflict.gpuModel+' · '+(conflict.cuda?'CUDA '+conflict.cuda:'CUDA 跟随源实例')+' · '+(conflict.regions||[]).join(' / ');
  $('#conflict-error').textContent=conflict.lastError?'旧任务原因：'+conflict.lastError:conflict.hasOperation?'旧任务已有提交记录。':'旧任务尚未提交。';
  $('#conflict-current').textContent=modeLabel(data.mode)+' · '+data.gpuModel+' × '+data.gpuCount+' · '+(data.mode==='boot'?'保留原环境':data.mode==='clone'?'CUDA 跟随源实例':'CUDA '+data.cuda)+' · '+data.regions.join(' / ')+(data.action==='execute'?'；符合条件后按当前授权自动提交并开机。':'；仅监测库存并通知。');
  $('#conflict-help').textContent=!error.conflict?'当前后台仍使用旧版任务接口。请正常停止旧后台，在项目目录运行 npm.cmd start，再刷新页面；当前表单会在关闭此弹窗后保留。'
    :conflict.replaceable?'可以保留当前配置并重建。新配置、源实例及余额校验通过后，旧任务才会停止；原配置和日志继续保留。'
    :data.mode==='boot'&&conflict.hasOperation?'原实例已有开机请求需要核对。请回到原任务点击恢复检查，程序会查询同一实例的状态，不会创建新实例。':conflict.hasOperation?'原任务有一次结果不明的提交。请先到 AutoDL 核对：已创建就在原任务中绑定目标实例；确认没有创建，在原任务中点“重新核对实例列表”清除记录后再新建。停止本地任务不会撤销云端租用，也不会清除提交记录。'
    :'旧任务仍在运行或等待处理。请先查看并暂停原任务，再按当前配置重建。';
  $('#replace-task').hidden=!conflict.replaceable||!error.conflict;
  $('#replace-task').disabled=conflictBusy;
  if(!$('#task-conflict-dialog').open)$('#task-conflict-dialog').showModal();
}
async function taskCreated(replaced=false) {
  toast(replaced?'旧任务已停止，新任务已按当前配置建立':'任务已建立，请保持服务与电脑运行');
  await refresh();
}
$('#task-form').addEventListener('invalid',event=>{for(let node=event.target.parentElement;node&&node!==event.currentTarget;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;},true);
$('#task-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,button=$('#submit-task'),data=taskPayload(form);
  if(currentMode==='boot'&&!window.pickedSource?.()?.bootable){toast('请同步并选择可开机的原实例；无卡运行中的实例需先手动关机',true);return;}
  if(!data.gpuModel){toast('请选择 GPU 精确型号，或填写其他型号',true);return;}
  if(!data.regions.length){toast('请至少选择一个地区',true);return;}
  if(appState.browser?.session?.state!=='ready'||!appState.browser.session.browserOpen){
    toast('请先登录 AutoDL 并点击“检查登录状态”，确认会话可用后再开始真实监测。',true);focusLogin();return;
  }
  if(currentMode==='create'&&!window.imageSelectionReady?.()){toast('请同步官方镜像，并完成框架、版本、Python 和 CUDA 的四级选择',true);return;}
  button.disabled=true;try{await api('/api/tasks',data);await taskCreated();}catch(error){if(error.code==='DUPLICATE')showTaskConflict(error,data);else toast(error.message,true);}finally{button.disabled=false;}
});
document.addEventListener('click',e=>{const detail=e.target.closest('[data-detail]');if(detail){openDetail(detail.dataset.detail);return;}const download=e.target.closest('[data-export-logs]');if(download){void window.taskMonitor.exportLogs(download.dataset.exportLogs);return;}const command=e.target.closest('[data-command]');if(command)void perform(command.dataset.command,command.dataset.id);});
$('#close-dialog').addEventListener('click',()=>{$('#task-dialog').close();detailId=null;});
$('#conflict-close').addEventListener('click',()=>{if(!conflictBusy)$('#task-conflict-dialog').close();});
$('#task-conflict-dialog').addEventListener('cancel',event=>{if(conflictBusy)event.preventDefault();});
$('#task-conflict-dialog').addEventListener('close',()=>{pendingConflict=null;});
$('#conflict-view').addEventListener('click',async()=>{
  if(conflictBusy||!pendingConflict)return;
  const id=pendingConflict.conflict.id;$('#task-conflict-dialog').close();await refresh();
  if(!appState.tasks.some(t=>t.id===id)){toast('原任务状态已变化，请刷新后查看',true);return;}
  openDetail(id);
});
$('#replace-task').addEventListener('click',async()=>{
  if(conflictBusy||!pendingConflict?.conflict.replaceable)return;
  const pending=pendingConflict;
  if(JSON.stringify(taskPayload())!==pending.signature){$('#task-conflict-dialog').close();toast('配置已变化，请按当前配置重新提交',true);return;}
  conflictBusy=true;$('#replace-task').disabled=true;$('#conflict-close').disabled=true;$('#conflict-view').disabled=true;
  try{
    await api('/api/tasks',{...pending.data,replaceTaskId:pending.conflict.id});
    $('#task-conflict-dialog').close();await taskCreated(true);
  }catch(error){
    if(error.code==='DUPLICATE')showTaskConflict(error,pending.data);
    else {$('#conflict-help').textContent='未能确认重建成功：'+error.message+'。请查看最新任务状态后再操作。';toast(error.message,true);}
    await refresh();
  }finally{conflictBusy=false;$('#replace-task').disabled=false;$('#conflict-close').disabled=false;$('#conflict-view').disabled=false;}
});
$('#open-browser').addEventListener('click',()=>void browserCommand('open'));
$('#check-browser').addEventListener('click',()=>void browserCommand('check'));
$('#logout-browser').addEventListener('click',()=>{$('#logout-clear-credentials').checked=false;$('#logout-dialog').showModal();});
$('#logout-cancel').addEventListener('click',()=>$('#logout-dialog').close());
$('#confirm-logout').addEventListener('click',async()=>{const button=$('#confirm-logout');button.disabled=true;try{await browserCommand('logout',{clearCredentials:$('#logout-clear-credentials').checked});}finally{button.disabled=false;}});
$('#settings-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form));data.rememberCredentials=form.elements.rememberCredentials.checked;data.webhookEnabled=form.elements.webhookEnabled.checked;data.wechatEnabled=form.elements.wechatEnabled.checked;try{const result=await api('/api/notifications/settings',data);initialSettings=false;toast(result.message);await refresh();}catch(error){toast(error.message,true);}});
$('#read-notifications').addEventListener('click',async()=>{try{await api('/api/notifications/read',{});await refresh();}catch(error){toast(error.message,true);}});
$('#desktop-notify').addEventListener('click',async()=>{if(!('Notification'in window)){toast('当前浏览器不支持桌面通知，请配置微信或 Webhook',true);return;}const result=await Notification.requestPermission();toast(result==='granted'?'桌面提醒已开启，请保持本页面打开':'未启用桌面通知，站内消息仍会保留');});
function tickClock(){$('#clock').textContent=new Date().toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
regions();updateForm();renderBrowser();tickClock();void refresh();setInterval(()=>void refresh(),2000);setInterval(tickClock,30000);
// 倒计时只更新文字节点，队列和日志仍沿用原有的状态刷新与滚动保持。
setInterval(()=>window.taskMonitor.tick(),1000);

