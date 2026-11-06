'use strict';

// 版本信息来自本机后台，检查失败不会影响登录、看板或正在运行的抢卡任务。
(() => {
  const releaseHome='https://github.com/Starry-cz/autodl-assistant/releases/latest';
  let snapshot=null, checking=false, requestError='';
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
    const busy=checking||data.status==='checking', status=requestError?'error':busy?'checking':data.status||'idle';
    $('#update-current-version').textContent=data.currentVersion?version(data.currentVersion):'读取中…';
    $('#update-latest-version').textContent=version(data.latestVersion);
    $('#update-channel').textContent=data.currentVersion?(desktop?'桌面版':'网页版'):'';
    $('#update-check').disabled=busy;$('#update-check').textContent=busy?'检查中…':'检查更新';
    $('#version-updates .updates-panel').dataset.updateState=status;
    const message={idle:'尚未检查，联网后会自动检查。',checking:'正在检查正式发布版本…',available:'发现新版本 '+version(data.latestVersion)+'，可下载更新。',current:'已是最新正式版本。',ahead:'当前版本高于公开发布版。',error:'检查失败 · '+(requestError||data.error||'请稍后重试。')}[status];
    // 普通状态轮询不重复改写 live region，避免读屏软件反复播报相同结果。
    const statusText=message||'尚未检查更新。';
    if($('#update-status').textContent!==statusText)$('#update-status').textContent=statusText;
    $('#update-checked-at').textContent=data.checkedAt?'上次成功检查 '+time(data.checkedAt,true):'';
    $('#account-update-badge').hidden=!available;
    $('#account-entry').setAttribute('aria-label',available?'打开账号页面，有新版本 '+version(data.latestVersion):'打开账号页面');
    const downloads=data.downloads||{};
    setDownload('update-main-download',desktop?downloads.desktopInstaller:downloads.source,available);
    $('#update-main-download').textContent=desktop?'下载桌面安装包':'下载新版源码';
    setDownload('update-portable-download',downloads.desktopPortable,available&&desktop);
    $('#update-release-link').href=data.releaseUrl||releaseHome;
    $('#update-release-link').textContent=available?'其他下载方式 ↗':'查看发布页 ↗';
    $('#update-guidance').hidden=!available;
    $('#update-instructions').textContent=desktop?'从托盘选择“停止并退出”，再运行新版安装包；便携版请完整解压到新文件夹。原账号和任务数据仍保留在本机 AppData。':'先运行旧目录的“停止抢卡助手.cmd”，再将新版源码完整解压到新目录，双击“启动抢卡助手.cmd”。新目录需要重新登录，旧目录与 .runtime 请保留。';
    $('#update-notes').hidden=!data.notes;
    // 发布说明一律作为文字显示，远端内容不能成为可执行 HTML。
    const notes=data.notes||'';
    if($('#update-release-notes').textContent!==notes)$('#update-release-notes').textContent=notes;
  }
  async function checkUpdates(force=false) {
    if(checking||(!force&&(document.hidden||snapshot?.nextCheckAt>Date.now())))return;
    checking=true;requestError='';renderUpdates();
    try {
      const result=await api('/api/updates/check',{force});
      appState.updates=result.updates;renderUpdates(result.updates);
    } catch(error) {requestError=error.message;}
    finally {checking=false;renderUpdates();}
  }
  window.renderUpdates=renderUpdates;
  $('#update-check').addEventListener('click',()=>void checkUpdates(true));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkUpdates();});
  // 页面只定期询问是否到了检查时间，多个窗口和手动点击由后台统一缓存与合并。
  setInterval(()=>void checkUpdates(),15*60*1000);
  renderUpdates(appState.updates);
  void checkUpdates();
})();
