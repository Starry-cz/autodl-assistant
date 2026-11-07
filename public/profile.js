'use strict';

// 账号页统一负责登录后的同步顺序，各看板不再同时抢占专用浏览器。
(() => {
  let syncing=false, lastConnection='', loginWatchAt=0, progress='';
  const connected=()=>accountReady() && (!appState.account?.enabled || !!appState.account.identity);
  const current=()=>appState.account?.identity;
  function renderProfile(){
    const identity=current(), ready=connected(), session=appState.browser?.session;
    $('#account-name').textContent=identity?.displayName || (ready?'AutoDL 账号':'登录 AutoDL');
    $('#account-status').textContent=syncing?'正在同步账号内容':ready?(session?.background?'后台已连接':'账号已连接'):session?.browserOpen?'等待登录与核验':'账号与设置';
    $('#account-avatar').textContent=identity?.displayName?.slice(0,1).toUpperCase() || 'AD';
    $('#profile .profile-avatar').textContent=$('#account-avatar').textContent;
    $('#profile-name').textContent=identity?.displayName || '连接你的 AutoDL 账号';
    $('#profile-id').textContent=identity?'账号 ID：'+identity.accountId+(identity.subAccountId?' · 子账号 '+identity.subAccountId:''):'登录信息仅在本机专用浏览器中使用。';
    $('#profile-status').textContent=ready?(identity?.kind==='sub'?'子账号已连接':'账号已连接'):appState.account?.error || '尚未连接';
    $('#profile-sync-status').textContent=progress || (ready?(session?.background?'当前账号已在后台连接，可同步实例、账单与库存。':'已连接当前账号，可同步实例、账单与库存。'):'在 AutoDL 窗口完成登录后，会自动转到后台并同步账号内容。');
    $('#profile-sync').disabled=!ready || syncing || !!appState.browser?.busy || !!browserAction;
    const unclaimed=appState.account?.unclaimedCount||0;
    $('#profile-legacy-note').hidden=!unclaimed;
    $('#profile-legacy-note').textContent='本机有 '+unclaimed+' 条旧任务尚未确认归属。同步实例后会按实例 ID 匹配；未匹配的记录保留在本机，不混入当前账号。';
  }
  async function syncWorkspace({returnToOverview=false}={}){
    if(syncing||!connected())return;
    syncing=true;window.workspaceSyncing=true;
    // 仅用户本次发起登录时返回监控室；平常刷新或手动同步不会打断正在看的页面。
    if(returnToOverview && !$('#profile').classList.contains('hidden'))$('.nav-item[data-view="overview"]').click();
    const owner=current()?.ownerId, errors=[];
    const steps=[
      ['实例与资源','/api/observatory/overview',{targetId:owner?localStorage.getItem('autodl.overview.target.'+owner)||'':''}],
      ['近 35 天账单','/api/observatory/billing',{}],
      ['GPU 库存目录','/api/autodl/gpus',{}],
    ];
    try {
      for(let i=0;i<steps.length;i++){
        const [label,path,data]=steps[i];progress='正在同步 '+label+'（'+(i+1)+'/3）…';renderProfile();
        try{await api(path,data);}catch(error){errors.push(label+'：'+error.message);}
        await refresh();
        // 用户退出或更换账号后终止后续同步，不继续使用先前的实例选择。
        if(!connected()||current()?.ownerId!==owner)break;
      }
      progress=errors.length?'部分内容未同步：'+errors.join('；'):connected()?'当前账号的实例、账单与库存已同步。':'连接已断开，重新登录后同步。';
    } finally {syncing=false;window.workspaceSyncing=false;renderProfile();}
  }
  $('#profile-sync').addEventListener('click',()=>void syncWorkspace());
  $('#open-browser').addEventListener('click',()=>{loginWatchAt=Date.now();progress='请在 AutoDL 官方窗口完成登录，成功后窗口将关闭，后续同步在后台进行。';renderProfile();});
  // 登录检查只读页面状态；人工验证由用户在官网完成，不代为输入密码或验证码。
  setInterval(async()=>{
    if(!loginWatchAt||Date.now()-loginWatchAt>10*60000||browserAction||appState.browser?.busy||syncing)return;
    if(connected()){loginWatchAt=0;return;}
    if(!appState.browser?.session?.browserOpen)return;
    browserAction='check';renderBrowser();
    try{const result=await api('/api/browser/check',{});if(result.session)appState.browser={...appState.browser,session:result.session};}
    catch(error){progress=error.message;}
    finally{browserAction=null;await refresh();renderBrowser();renderProfile();}
  },5000);
  window.addEventListener('appstatechange',()=>{
    renderProfile();
    const key=connected()&&current()?current().ownerId+':'+appState.browser.session.readySince:'';
    if(!key){lastConnection='';return;}
    if(key!==lastConnection&&!syncing){const returnToOverview=!!loginWatchAt;lastConnection=key;loginWatchAt=0;void syncWorkspace({returnToOverview});}
  });
  renderProfile();
})();
