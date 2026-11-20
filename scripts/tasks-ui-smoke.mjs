import { syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';
import { configInput } from '../tests/fixtures/config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';

// 只使用临时目录和本地合成会话；引擎停用，不允许云端操作、模型调用或通知。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// 回归截图仅保留在被 Git 忽略的本机输出目录，不写入发布文档。
const output=path.join(root,'output','playwright');
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-tasks-ui-isolated-'));
const errors=[],blocked=[],posts=[];let app,browser,forbiddenCalls=0,legacyConflict=false;
const forbidden=async()=>{forbiddenCalls++;throw Error('任务界面测试禁止真实操作');};
try {
  const autodl=Object.assign(new SyntheticAdapter(),{
    imageOptions:syntheticImageOptions,sessionStatus:()=>({state:'ready',browserOpen:true,label:'会话可用',checkedAt:1}),
    login:forbidden,checkLogin:forbidden,instances:forbidden,probe:forbidden,prepare:forbidden,submit:forbidden,reconcile:forbidden,
  });
  app=createApplication({ updatesOptions: offlineUpdateOptions,runtimeDir:dir,startEngine:false,adapters:{autodl},aiOptions:{fetchImpl:forbidden},walletOptions:{fetchImpl:forbidden}});
  const old=app.store.create(normalizeConfig(configInput({name:'旧的 4090 任务',cuda:'13.0',imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','13.0']})));
  app.store.patch(old,{state:'attention',lastError:'镜像路径第4级“13.0”不唯一或已失效，请重新选择'});
  // 模拟上次“同步 AutoDL 型号”保存在本机的合成目录。
  seedGpuCatalog(app.store);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  const candidates=[process.env.AI_TEST_BROWSER,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  const executablePath=candidates.find(candidate=>fs.existsSync(candidate));if(!executablePath)throw Error('未找到 Chromium 测试浏览器');
  browser=await chromium.launch({executablePath,headless:true});const context=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());if(url.origin!==base){blocked.push(url.href);return route.abort();}
    if(url.pathname==='/api/tasks'&&legacyConflict)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'DUPLICATE',message:'已有相同型号的新建任务，或此源实例的迁移任务；请先处理原任务'})});
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/tasks'&&request.method()==='POST')posts.push(request.postDataJSON());});
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#connection').textContent==='已连接');
  await page.locator('[data-view=dashboard]').click();
  const form=page.locator('#task-form'),field=name=>form.locator('[name='+name+']'),dialog=page.locator('#task-conflict-dialog');
  const scheduler=page.getByRole('combobox',{name:'任务调度'}), schedulerStatus=page.locator('#scheduler-status');
  const readLimit=page.getByRole('combobox',{name:'同时查库存'});
  assert.equal(await scheduler.inputValue(),'serial');
  assert.equal(await scheduler.isEnabled(),true);
  assert.equal(await readLimit.isHidden(),true);
  const staleRead=Promise.withResolvers(), allowOldState=Promise.withResolvers();
  // 让切换前真实读取的快照迟到，验证前端不会用旧模式覆盖保存结果。
  await page.route(base+'/api/state',async route=>{
    const snapshot=await route.fetch();staleRead.resolve();
    await allowOldState.promise;await route.fulfill({response:snapshot});
  },{times:1});
  await page.evaluate(()=>{void refresh();});
  await staleRead.promise;
  const posted=page.waitForResponse(r=>r.url()===base+'/api/scheduler'&&r.request().method()==='POST');
  await scheduler.selectOption('parallel');
  const saved=await posted;
  assert.equal(saved.ok(),true);assert.deepEqual(saved.request().postDataJSON(),{mode:'parallel',maxParallel:2});
  await page.waitForFunction(()=>!document.querySelector('#scheduler-mode').disabled);
  allowOldState.resolve();
  await page.waitForFunction(()=>!fetching);
  assert.equal(await scheduler.inputValue(),'parallel');assert.equal(await readLimit.inputValue(),'2');
  assert.match(await schedulerStatus.textContent(),/其余任务排队.*付费提交逐笔核验/);
  const chooseThree=page.waitForResponse(r=>r.url()===base+'/api/scheduler'&&r.request().method()==='POST');
  await readLimit.selectOption('3');
  assert.deepEqual((await (await chooseThree).json()).scheduler, {mode:'parallel',maxParallel:3,maxSupportedParallel:3});
  await page.waitForFunction(()=>!document.querySelector('#scheduler-limit').disabled);
  assert.equal(await field('paidConsent').isChecked(),false);assert.equal(posts.length,0);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#connection').textContent==='已连接');
  await page.locator('[data-view=dashboard]').click();
  assert.equal(await scheduler.inputValue(),'parallel');
  assert.equal(await readLimit.inputValue(),'3');
  // 保存失败要恢复已生效的选项，且保留可重试入口。
  await page.route(base+'/api/scheduler',route=>route.fulfill({status:409,json:{error:'UPDATING',message:'正在准备更新'}}),{times:1});
  await readLimit.selectOption('2');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('调度方式保存失败'));
  assert.equal(await readLimit.inputValue(),'3');assert.equal(await scheduler.isEnabled(),true);
  await scheduler.selectOption('serial');
  await page.waitForFunction(()=>!document.querySelector('#scheduler-mode').disabled);
  assert.equal(await scheduler.inputValue(),'serial');assert.equal(await readLimit.isHidden(),true);
  await scheduler.selectOption('parallel');
  await page.waitForFunction(()=>!document.querySelector('#scheduler-limit').disabled);
  assert.equal(await readLimit.inputValue(),'3');
  await page.setViewportSize({width:320,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.setViewportSize({width:1440,height:1080});
  // 上一版支持串/并行，但固定双路，页面不能给出三路选择。
  const fixedScheduler=async route=>{
    const state=await (await route.fetch()).json();
    state.scheduler={mode:'parallel',maxParallel:2};await route.fulfill({json:state});
  };
  await page.route(base+'/api/state',fixedScheduler);await page.evaluate(()=>refresh());
  await page.waitForFunction(()=>document.querySelector('#scheduler-status').textContent.includes('同时查 2 项'));
  assert.equal(await scheduler.isEnabled(),true);assert.equal(await readLimit.isHidden(),true);
  await page.unroute(base+'/api/state',fixedScheduler);
  // 旧后台不会提供范围或调度模式，不开放无法兑现的并行选项。
  await page.route(base+'/api/state',async route=>{
    const state=await (await route.fetch()).json();delete state.scheduler;delete state.meta;
    await route.fulfill({json:state});
  });
  await page.evaluate(()=>refresh());
  await page.waitForFunction(()=>document.querySelector('#scheduler-status').textContent.includes('当前后台不支持'));
  assert.equal(await scheduler.isDisabled(),true);assert.equal(await scheduler.inputValue(),'');
  assert.equal(await field('experimentSlot').isHidden(),true);
  assert.equal(await page.evaluate(()=>Object.hasOwn(taskPayload(), 'experimentSlot')),false);
  assert.equal(await page.locator('#poll-presets').isHidden(),true);assert.equal(await field('pollSeconds').getAttribute('min'),'10');
  await page.unroute(base+'/api/state');
  await page.evaluate(()=>refresh());await page.waitForFunction(()=>!document.querySelector('#scheduler-mode').disabled);
  assert.equal(app.store.tasks().length,1);assert.equal(old.state,'attention');assert.equal(posts.length,0);
  assert.equal(await field('experimentSlot').inputValue(),'1');
  for(const mode of ['boot','clone']){
    await page.locator('[data-mode='+mode+']').click();
    assert.equal(await field('experimentSlot').isHidden(),true);
    assert.equal(await page.evaluate(()=>Object.hasOwn(taskPayload(), 'experimentSlot')),false);
  }
  await page.locator('[data-mode=create]').click();
  await selectSyntheticImage(page);await field('gpuModel').selectOption('RTX 4090');await field('pollSeconds').fill('10');await field('extraDiskGB').fill('50');
  await page.locator('#balance-options > summary').click();
  await field('balanceGuard').uncheck();await page.locator('[data-action-choice=execute]').click();await field('paidConsent').check();
  // 变更计费配置要重新确认；修改便于识别的任务名称不影响本次授权。
  await field('name').fill('合成重建任务');
  assert.equal(await field('paidConsent').isChecked(),true);
  await field('gpuCount').selectOption('2');
  assert.equal(await field('paidConsent').isChecked(),false,'增加 GPU 数量后必须重新授权');
  await field('gpuCount').selectOption('1');await field('balanceGuard').check();await field('paidConsent').check();
  await field('balanceGuard').uncheck();
  assert.equal(await field('paidConsent').isChecked(),false,'关闭预算保护后必须重新授权');
  await field('paidConsent').check();
  await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});
  assert.match(await page.locator('#conflict-old').textContent(),/CUDA 13\.0/);assert.match(await page.locator('#conflict-error').textContent(),/13\.0.*失效/);
  assert.match(await page.locator('#conflict-current').textContent(),/CUDA 12\.1/);assert.match(await page.locator('#conflict-current').textContent(),/自动提交并开机/);
  assert.equal(await page.locator('#replace-task').isVisible(),true);assert.equal(old.state,'attention');assert.equal(app.store.tasks().length,1);
  await page.locator('#conflict-close').click();assert.equal(await field('pollSeconds').inputValue(),'10');assert.equal(await field('extraDiskGB').inputValue(),'50');assert.equal(await field('paidConsent').isChecked(),true);
  await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});await page.locator('#conflict-view').click();await page.locator('#task-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#detail-content').textContent(),/13\.0.*失效/);await page.locator('#close-dialog').click();
  await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1080});
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'弹窗溢出 '+width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'页面溢出 '+width);
  }
  await page.setViewportSize({width:1440,height:1080});await page.screenshot({path:path.join(output,'task-conflict.png')});
  await page.locator('#replace-task').click();await page.waitForFunction(()=>!document.querySelector('#task-conflict-dialog').open);await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='2');
  const next=app.store.tasks()[0];assert.equal(old.state,'cancelled');assert.equal(old.replacedBy,next.id);assert.equal(next.replacesTaskId,old.id);
  assert.equal(next.config.cuda,'12.1');assert.equal(next.config.pollSeconds,10);assert.equal(next.config.extraDiskGB,50);assert.equal(next.config.action,'execute');assert.equal(next.config.paidConsent,true);assert.equal(next.operation,null);
  assert.equal(posts.at(-1).replaceTaskId,old.id);assert.equal(posts.at(-1).pollSeconds,'10');

  // 停止后仍保留的提交必须阻止重建，不能因状态 cancelled 就重复租用。
  app.store.patch(next,{state:'cancelled',operation:{stage:'click_started',at:1},lastError:'提交结果需核对'});
  await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});
  assert.equal(await page.locator('#replace-task').isHidden(),true);assert.match(await page.locator('#conflict-help').textContent(),/绑定目标实例.*重新核对实例列表/);
  await page.locator('#conflict-close').click();assert.equal(app.store.tasks().length,2);

  // 旧后台缺少替换协议时仅展示原因和正常重启说明，不先取消旧任务。
  legacyConflict=true;await page.evaluate(()=>refresh());await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});
  assert.match(await page.locator('#conflict-help').textContent(),/后台版本不匹配.*正常退出并重新启动助手.*当前表单已保留/);
  assert.equal(await page.locator('#replace-task').isHidden(),true);await page.locator('#conflict-close').click();
  assert.equal(await field('pollSeconds').inputValue(),'10');assert.equal(app.store.tasks().length,2);
  // 已停止的不明提交：详情页可重新核对实例列表；合成列表没有新增实例时清除记录，之后可按当前配置新建。
  legacyConflict=false;app.store.patch(next,{operation:{...next.operation,at:Date.now()-3*60000,baselineIds:[]}});await page.evaluate(()=>refresh());
  await page.locator(`[data-detail="${next.id}"]`).click();await page.locator('#task-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#attach-form').count(),1);const recheck=page.locator('#detail-content [data-command="recheck"]');assert.equal(await recheck.count(),1);
  page.once('dialog',confirmDialog=>void confirmDialog.accept());await recheck.click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已清除此次提交记录'));
  assert.equal(next.operation,null);assert.equal(next.state,'cancelled');assert.ok(next.logs.some(l=>/重新核对/.test(l.message)));
  await page.locator('#close-dialog').click();await page.locator('#submit-task').click();
  await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='3');assert.equal(app.store.tasks().length,3);assert.equal(app.store.tasks()[0].operation,null);
  // 相同资源分别建三条任务；切换编号需要重新授权，任何一次提交都只创建一条本地记录。
  for(const slot of [2,3]){
    await field('experimentSlot').selectOption(String(slot));
    assert.equal(await field('paidConsent').isChecked(),false);
    assert.match(await page.locator('#consent-text').textContent(),new RegExp('实验 '+slot+'.*1 台.*分别计费'));
    await field('name').fill('合成实验');await field('paidConsent').check();
    const postedTask=page.waitForResponse(r=>r.url()===base+'/api/tasks'&&r.request().method()==='POST');
    await page.locator('#submit-task').click();
    const response=await postedTask;assert.equal(response.status(),201);
    assert.equal(response.request().postDataJSON().experimentSlot,slot);
    const {task}=await response.json();
    const card=page.locator('[data-task-id="'+task.id+'"]');
    await card.waitFor();assert.match(await card.textContent(),new RegExp('实验 '+slot));
    await card.locator('[data-detail]').click();
    assert.match(await page.locator('#detail-title').textContent(),new RegExp('实验 '+slot));
    await page.locator('#close-dialog').click();
  }
  const experiments=app.store.tasks().filter(task=>task.state==='queued');
  assert.deepEqual(experiments.map(task=>task.config.experimentSlot).sort(),[1,2,3]);
  assert.ok(experiments.every(task=>task.config.gpuModel==='RTX 4090'&&task.config.gpuCount===1&&!task.operation));
  // 队列随任务自然增长；两列底部对齐，页面仍可滚到最后任务与提交按钮。
  await page.setViewportSize({width:1440,height:1080});
  for(let i=0;i<8;i++){const extra=app.store.create(normalizeConfig(configInput({name:'合成队列任务 '+(i+1)})));app.store.patch(extra,{state:'cancelled',lastScan:{at:Date.now(),count:10,summary:'合成扫描摘要：北京B区（1 页，已到末页），用于验证队列滚动'}});}
  await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='13');
  await page.locator('.composer').scrollIntoViewIfNeeded();
  const queue=await page.evaluate(()=>{const list=document.querySelector('#tasks'),fields=document.querySelector('.config-fields');
    const left=document.querySelector('.composer').getBoundingClientRect(),right=document.querySelector('.task-column').getBoundingClientRect();
    return {count:list.querySelectorAll('[data-detail]').length,allRowsVisible:list.scrollHeight<=list.clientHeight+1,
      bottomDifference:Math.abs(left.bottom-right.bottom),overflow:getComputedStyle(fields).overflowY};});
  assert.equal(queue.count,13);assert.equal(queue.allRowsVisible,true,JSON.stringify(queue));
  assert.ok(queue.bottomDifference<=2,JSON.stringify(queue));assert.equal(queue.overflow,'auto');
  await page.locator('#tasks [data-detail]').last().scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#tasks [data-detail]').last().isVisible(),true);
  await page.locator('#submit-task').scrollIntoViewIfNeeded();
  const buttonRect=await page.locator('#submit-task').boundingBox();
  assert.ok(buttonRect.y>=0&&buttonRect.y+buttonRect.height<=1080,JSON.stringify(buttonRect));
  await page.locator('#toggle-queue').click();
  assert.equal(await page.locator('#tasks').isHidden(),true);const folded=(await page.locator('#queue-summary').textContent()).match(/进行中 (\d+) · 待处理 (\d+) · 其余 (\d+)/);
  assert.ok(folded&&Number(folded[1])+Number(folded[2])+Number(folded[3])===13,String(folded));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='13');
  await page.locator('[data-view=dashboard]').click();
  assert.equal(await page.locator('#tasks').isHidden(),true);assert.equal(await page.locator('#toggle-queue').textContent(),'展开');
  await page.locator('#toggle-queue').click();assert.equal(await page.locator('#tasks').isVisible(),true);
  // 详情日志：往下翻看旧日志时，每2秒的刷新和新增日志都不会把它弹回最上面。
  const logged=app.store.tasks()[0];app.store.patch(logged,{logs:Array.from({length:60},(_,i)=>({at:Date.now()-(60-i)*1000,level:'info',message:'合成日志第 '+(i+1)+' 条：用于验证滚动位置在刷新后保持不变'}))});
  await page.waitForTimeout(2300);await page.locator('[data-detail="'+logged.id+'"]').click();await page.locator('#task-dialog').waitFor({state:'visible'});
  const topKey=()=>page.evaluate(()=>{const list=document.querySelector('#detail-content .log-list'),box=list.getBoundingClientRect();
    return {scrollTop:list.scrollTop,key:[...list.querySelectorAll('.log')].find(el=>el.getBoundingClientRect().bottom>box.top+1)?.dataset.key};});
  await page.evaluate(()=>{document.querySelector('#detail-content .log-list').scrollTop=400;});
  const before=await topKey();assert.ok(before.scrollTop>=300,JSON.stringify(before));
  app.store.log(logged,'info','合成：新增的一条日志');
  await page.waitForFunction(()=>document.querySelector('#detail-content .log-list .log span')?.textContent==='合成：新增的一条日志');
  await page.waitForTimeout(2300);const after=await topKey();
  assert.equal(after.key,before.key,JSON.stringify({before,after}));assert.ok(after.scrollTop>=before.scrollTop,JSON.stringify({before,after}));
  await page.locator('#close-dialog').click();
  // 两个窗口可以先后连接不同账号。分别覆盖已显示的冲突、切换后才返回的冲突。
  let owner='synthetic-owner-a', holdConflict=false;
  const delayedConflict=Promise.withResolvers(), releaseConflict=Promise.withResolvers();
  for(const endpoint of ['/api/observatory/overview','/api/observatory/billing','/api/autodl/gpus']){
    await page.route(base+endpoint,route=>route.fulfill({json:{}}));
  }
  await page.route(base+'/api/state',async route=>{
    const state=await (await route.fetch()).json();
    state.account={enabled:true,identity:{ownerId:owner,accountId:owner,displayName:owner}};
    await route.fulfill({json:state});
  });
  await page.route(base+'/api/tasks',async route=>{
    if(holdConflict){delayedConflict.resolve();await releaseConflict.promise;}
    await route.fulfill({status:409,json:{error:'DUPLICATE',message:'已有任务',conflict:{
      id:old.id,name:'账号 A 的实验',state:'paused',gpuModel:'RTX 4090',regions:['北京B区'],replaceable:true,
    }}});
  });
  const waitForOwner=()=>page.waitForFunction(id=>document.querySelector('#profile-name').textContent===id,owner);
  await waitForOwner();await selectSyntheticImage(page);await field('gpuModel').selectOption('RTX 4090');
  await page.locator('[data-action-choice=execute]').click();await field('paidConsent').check();
  await page.locator('#submit-task').click();await dialog.waitFor({state:'visible'});
  owner='synthetic-owner-b';await waitForOwner();
  assert.equal(await dialog.isVisible(),false,'换账号后应关闭前一个账号的任务冲突');
  assert.equal(await field('paidConsent').isChecked(),false);
  assert.equal(posts.at(-1).expectedOwnerId,'synthetic-owner-a');
  owner='synthetic-owner-a';await waitForOwner();await field('paidConsent').check();
  holdConflict=true;await page.locator('#submit-task').click();await delayedConflict.promise;
  owner='synthetic-owner-b';await waitForOwner();releaseConflict.resolve();
  await page.waitForFunction(()=>!document.querySelector('#submit-task').disabled);
  assert.equal(await dialog.isVisible(),false,'旧账号的冲突回执不应在新账号重新打开');
  const catalogRequested=Promise.withResolvers(), returnCatalog=Promise.withResolvers();
  await page.waitForFunction(()=>!window.workspaceSyncing);
  await page.route(base+'/api/autodl/gpus',async route=>{
    catalogRequested.resolve();await returnCatalog.promise;
    await route.fulfill({json:{checkedAt:Date.now(),regions:[{region:'北京B区',models:[{model:'上一账号专属型号',available:1,total:1}]}]}});
  },{times:1});
  await page.locator('#sync-gpus').click();await catalogRequested.promise;
  owner='synthetic-owner-c';await waitForOwner();await page.waitForFunction(()=>!window.workspaceSyncing&&!fetching);returnCatalog.resolve();
  await page.waitForFunction(()=>!gpuSyncing&&!fetching);
  assert.equal(await field('gpuModel').locator('option[value="上一账号专属型号"]').count(),0,'旧账号的同步响应不能成为新账号的库存目录');
  // 同一账号的慢心跳可以晚于手动同步返回；已显示的新目录应保留。
  const oldSnapshot=Promise.withResolvers(), returnSnapshot=Promise.withResolvers();
  await page.route(base+'/api/state',async route=>{
    const state=await (await route.fetch()).json();
    state.account={enabled:true,identity:{ownerId:owner,accountId:owner,displayName:owner}};
    oldSnapshot.resolve();await returnSnapshot.promise;await route.fulfill({json:state});
  },{times:1});
  await page.evaluate(()=>{void refresh();});await oldSnapshot.promise;
  await page.route(base+'/api/autodl/gpus',route=>route.fulfill({json:{checkedAt:Date.now(),regions:[
    {region:'北京B区',models:[{model:'当前账号最新型号',available:1,total:2}]},
  ]}}),{times:1});
  await page.locator('#sync-gpus').click();
  const latestModel=field('gpuModel').locator('option[value="当前账号最新型号"]');
  await latestModel.waitFor({state:'attached'});returnSnapshot.resolve();
  await page.waitForFunction(()=>!fetching);
  assert.equal(await latestModel.count(),1,'较早的心跳不能覆盖新同步的型号');
  assert.equal(app.store.data.notifications.length,0);assert.equal(forbiddenCalls,0);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  console.log('任务界面通过：旧 CUDA 错误定位、当前表单保留、查看日志、显式重建、提交保护、旧后台提示、已停止不明提交的重新核对与清除后新建、320～1440px 弹窗布局；任务队列自然增长、两列底齐、末条任务与提交可达、收起后刷新仍保持；详情日志往下翻时刷新与新增日志不会弹回最上面；无云端操作或通知。');
} finally {
  await browser?.close();await app?.close();const target=path.resolve(dir);
  assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('autodl-tasks-ui-isolated-'));fs.rmSync(target,{recursive:true,force:true});
}

