'use strict';

// 版本信息来自本机后台，检查失败不会影响登录、看板或正在运行的抢卡任务。
(() => {
  const releaseHome='https://github.com/Starry-cz/autodl-assistant/releases/latest';
  let snapshot=null, checking=false, requestError='', installRequested=false, reconnecting=false, reconnectTimedOut=false;
  const version=value=>value?'v'+value:'尚未检查';
  function setDownload(id,url,visible) {
    const link=$('#'+id);link.hidden=!visible||!url;
    if(url)link.href=url;else link.removeAttribute('href');
  }
  function renderUpdates(next) {
    // 保留刚收到的检查结果，避免此前发出的状态轮询短暂覆盖更新后的信息。
    if(next&&(!snapshot||next.currentVersion!==snapshot.currentVersion||Number(next.revision)>=Number(snapshot.revision))){
      snapshot=next;if(!checking)requestError='';
    }
    const data=snapshot||{}, available=!!data.updateAvailable, desktop=data.channel==='desktop';
    const installation=data.installation||{}, installing=installRequested||['preparing','switching'].includes(installation.status);
    if(installation.status==='error')reconnectTimedOut=false;
    const busy=checking||data.status==='checking', status=requestError?'error':busy?'checking':data.status||'idle';
    $('#update-current-version').textContent=data.currentVersion?version(data.currentVersion):'读取中…';
    $('#update-latest-version').textContent=version(data.latestVersion);
    $('#update-channel').textContent=data.currentVersion?(desktop?'桌面版':'网页版'):'';
    $('#update-check').disabled=busy||installing;$('#update-check').textContent=busy?'检查中…':'检查更新';
    $('#update-install').hidden=!available&&!installing;
    $('#update-install').disabled=busy||installing;
    $('#update-install').textContent=installing?'正在更新…':installation.status==='error'?'重试更新':'更新并重启';
    $('#update-installation').hidden=!installation.message&&!installRequested;
    $('#update-installation').textContent=reconnectTimedOut?'尚未确认新版启动，请重新打开助手或查看更新日志。数据已保留。':installation.message||(installRequested?'正在准备更新…':'');
    if(installing&&!reconnecting&&!reconnectTimedOut&&installation.targetVersion)void waitForNewBackend(installation.targetVersion);
    $('#version-updates .updates-panel').dataset.updateState=status;
    const message={idle:'尚未检查。',checking:'正在检查更新…',available:'发现新版本 '+version(data.latestVersion)+'。',current:'已是最新版本。',ahead:'当前版本高于公开发布版。',error:'检查失败 · '+(requestError||data.error||'请稍后重试。')}[status];
    // 普通状态轮询不重复改写 live region，避免读屏软件反复播报相同结果。
    const statusText=message||'尚未检查更新。';
    if($('#update-status').textContent!==statusText)$('#update-status').textContent=statusText;
    $('#update-checked-at').textContent=data.checkedAt?'上次成功检查 '+time(data.checkedAt,true):'';
    $('#account-update-badge').hidden=!available;
    $('#account-menu-update-badge').hidden=!available;
    $('#settings-update-dot').hidden=!available;
    $('#account-entry').setAttribute('aria-label',available?'打开账号菜单，有新版本 '+version(data.latestVersion):'打开账号菜单');
    const downloads=data.downloads||{};
    setDownload('update-main-download',desktop?downloads.desktopInstaller:downloads.source,available);
    $('#update-main-download').textContent=desktop?'下载桌面安装包':'下载新版源码';
    setDownload('update-portable-download',downloads.desktopPortable,available&&desktop);
    $('#update-release-link').href=data.releaseUrl||releaseHome;
    $('#update-release-link').textContent=available?'其他下载方式 ↗':'查看发布页 ↗';
    $('#update-guidance').hidden=!available;
    $('#update-instructions').textContent='任务提交或核对期间请稍后更新。手动安装前请完全退出程序。';
    $('#update-notes').hidden=!data.notes;
    // 发布说明一律作为文字显示，远端内容不能成为可执行 HTML。
    const notes=data.notes||'';
    if($('#update-release-notes').textContent!==notes)$('#update-release-notes').textContent=notes;
  }
  async function checkUpdates(force=false) {
    if(checking||installRequested||['preparing','switching'].includes(snapshot?.installation?.status)||(!force&&(document.hidden||snapshot?.nextCheckAt>Date.now())))return;
    checking=true;requestError='';renderUpdates();
    try {
      const result=await api('/api/updates/check',{force});
      appState.updates=result.updates;renderUpdates(result.updates);
    } catch(error) {requestError=error.message;}
    finally {checking=false;renderUpdates();}
  }
  async function installUpdate() {
    if(installRequested)return;
    installRequested=true;requestError='';reconnectTimedOut=false;renderUpdates();
    try {
      const result=await api('/api/updates/install',{});
      snapshot={...snapshot,installation:result.installation};
    } catch(error) {
      snapshot={...snapshot,installation:{status:'error',message:error.message}};
    } finally {installRequested=false;renderUpdates();}
  }
  async function waitForNewBackend(targetVersion) {
    reconnecting=true;
    // 交接时旧令牌会失效；健康检查不需要令牌，确认新版就绪后整页重载。
    const deadline=Date.now()+20*60*1000;
    while(Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,2000));
      try {
        const response=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(4000)});
        if(!response.ok)continue;
        const health=await response.json();
        if(health.app!=='autodl-assistant')break;
        if(health.version===targetVersion&&!health.codeChanged&&health.ready===true){location.reload();return;}
        if(health.installation?.status==='error') {
          snapshot={...snapshot,installation:health.installation};reconnecting=false;renderUpdates();return;
        }
      } catch { /* 正常交接期间端口会短暂关闭，继续等待同一后台地址。 */ }
    }
    // 保留本次等候超时，状态轮询不能再次启动同一轮等待或覆盖提示。
    reconnecting=false;reconnectTimedOut=true;
    $('#update-installation').hidden=false;
    $('#update-installation').textContent='尚未确认新版启动，请重新打开助手或查看更新日志。数据已保留。';
  }
  window.recoverUpdatedBackend=async error=>{
    if(reconnecting||error.status!==403||error.code!=='TOKEN')return;
    const response=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(4000)});
    const health=await response.json();
    if(health.app==='autodl-assistant'&&health.startedAt&&health.startedAt!==appState.server?.startedAt)location.reload();
  };
  window.renderUpdates=renderUpdates;
  $('#update-check').addEventListener('click',()=>void checkUpdates(true));
  $('#update-install').addEventListener('click',()=>void installUpdate());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkUpdates();});
  // 页面只定期询问是否到了检查时间，多个窗口和手动点击由后台统一缓存与合并。
  setInterval(()=>void checkUpdates(),15*60*1000);
  renderUpdates(appState.updates);
  void checkUpdates();
})();
