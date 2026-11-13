import { goView } from './ui-navigation.mjs';
import { syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { offlineUpdateOptions } from '../tests/fixtures/updates.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { cloneDialogHtml } from '../tests/fixtures/clone-dialog.mjs';
// 临时运行目录、停止的引擎、合成会话/余额及本地DOM；禁止一切非本地请求。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// 回归截图仅保留在被 Git 忽略的本机输出目录，不写入发布文档。
const output=path.join(root,'output','playwright');
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-account-ui-isolated-'));
const TOKEN='synthetic-ui-wallet-token-not-real';
const source={id:'syntheticsource-abcdef12',region:'北京B区',gpuModel:'A100 80GB',gpuCount:2,stopped:true,running:false};
const errors=[],blocked=[],posts=[];let app,browser,calls=0,walletCalls=0,assets=3500,rows=[source,{...source,id:'syntheticrunning-abcdef12',running:true,stopped:false},{...source,id:'syntheticunknown-abcdef12',gpuModel:''}],forbiddenCalls=0;
const forbidden=async()=>{forbiddenCalls++;throw Error('账户测试不允许真实登录、提交、通知或模型请求');};
try {
 const autodl=Object.assign(new SyntheticAdapter(),{imageOptions:syntheticImageOptions,sessionStatus:()=>({state:'ready',browserOpen:true,label:'会话可用',message:'仅合成会话',checkedAt:1}),instances:async()=>{calls++;return rows;},login:forbidden,checkLogin:forbidden,logout:async()=>({message:'已退出合成会话'}),submit:forbidden,reconcile:forbidden});
 app=createApplication({ updatesOptions: offlineUpdateOptions,runtimeDir:dir,startEngine:false,fingerprint:()=> 'synthetic-account-ui-build',adapters:{autodl},aiOptions:{fetchImpl:forbidden},walletOptions:{fetchImpl:async()=>{walletCalls++;return new Response(JSON.stringify({code:'Success',data:{assets,voucher_balance:50000}}));}}});
 // 模拟上次“同步 AutoDL 型号”保存在本机的合成目录。
 seedGpuCatalog(app.store);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 const candidates=[process.env.AI_TEST_BROWSER,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
 const executablePath=candidates.find(p=>fs.existsSync(p));if(!executablePath)throw Error('未找到可用的Chromium浏览器');
 browser=await chromium.launch({executablePath,headless:true});const context=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'});
 let cloneOptions={}, pricingInterfaceMissing=false;const danger=[];
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==base){blocked.push(url.href);return route.abort();}
  if(url.pathname==='/api/pricing/preview'&&pricingInterfaceMissing)return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'NOT_FOUND',message:'接口不存在'})});
  if(url.pathname==='/fixture/clone-dialog')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:cloneDialogHtml(source,cloneOptions)});
  if(url.pathname==='/fixture/danger'){danger.push(url.searchParams.get('act'));return route.fulfill({status:204,body:''});}
  if(url.pathname==='/cloneInstance'||url.pathname==='/fixture/prepared')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><p>Local synthetic form</p>'});
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname==='/api/tasks'&&r.method()==='POST')posts.push(r.postDataJSON());});
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#connection').textContent==='已连接');
 const form=page.locator('#task-form'),field=name=>form.locator('[name='+name+']');
 // 来源、预算凭据与登录各归所属页面，仍通过真实导航和折叠按钮操作。
 const view=async name=>{await goView(page, name);await page.locator('#'+name).waitFor({state:'visible'});};
 const expand=async id=>{if(!await page.locator('#'+id).evaluate(node=>node.open))await page.locator('#'+id+' > summary').click();};
 const sourcePanel=async()=>{await view('fleet');await expand('fleet-sources');};
 const walletPanel=async()=>{await view('billing');await expand('billing-budget-credentials');await expand('wallet-options');};
 await view('dashboard');
 assert.equal(await field('copyDataDisk').isChecked(),true);assert.equal(calls,0);assert.equal(walletCalls,0);
 await field('gpuModel').selectOption('L20');await field('gpuCount').selectOption('1');await form.locator('[name=region][value="重庆A区"]').check();
 await sourcePanel();await page.locator('#sync-instances').click();await page.waitForFunction(()=>document.querySelectorAll('#account-instances .instance-row').length===3);
 assert.equal(calls,1);assert.equal(await page.locator('[data-source="syntheticrunning-abcdef12"]').isDisabled(),true);assert.equal(await page.locator('[data-source="syntheticunknown-abcdef12"]').isDisabled(),true);
 await view('dashboard');await page.locator('[data-mode=clone]').click();await field('sourceId').selectOption(source.id);
 // 克隆不填写 CUDA（随源实例环境）；地区锁定，型号和数量默认取源实例、可以更换。
 assert.equal(await field('cuda').inputValue(),'');assert.equal(await field('cuda').evaluate(n=>n.type==='hidden'&&!n.required),true);
 assert.equal(await field('gpuModel').inputValue(),'A100 80GB');assert.equal(await page.locator('#custom-gpu-field').isHidden(),true);assert.equal(await field('gpuModel').isDisabled(),false);assert.equal(await field('customGpuModel').isDisabled(),true);assert.equal(await field('gpuCount').inputValue(),'2');assert.equal(await field('gpuCount').isDisabled(),false);
 assert.deepEqual(await form.locator('[name=region]:checked').evaluateAll(ns=>ns.map(n=>n.value)),['北京B区']);assert.equal(await form.locator('[name=region]').evaluateAll(ns=>ns.every(n=>n.disabled)),true);
 // 检查实际复制范围及源实例保留语义，沿用界面精简后的说明。
 await field('copyDataDisk').uncheck();const copyNote=await page.locator('#copy-disk-note').textContent();assert.match(copyNote,/只复制系统盘/);assert.match(copyNote,/数据盘文件不复制/);assert.match(copyNote,/源实例保留/);
 await page.locator('[data-mode=create]').click();assert.equal(await field('gpuModel').inputValue(),'L20');assert.equal(await field('gpuModel').isEnabled(),true);assert.equal(await field('gpuCount').inputValue(),'1');assert.deepEqual(await form.locator('[name=region]:checked').evaluateAll(ns=>ns.map(n=>n.value)),['北京B区','重庆A区']);
 await page.locator('[data-mode=clone]').click();assert.equal(await field('gpuModel').inputValue(),'A100 80GB');
 // 余额保护为可选项，本用例主动启用来验证余额不足/充足的行为。
 await page.locator('#balance-options > summary').click();
 await page.locator('#pricing-options > summary').click();
 await field('balanceGuard').check();await page.locator('[data-action-choice=execute]').click();assert.equal(await field('action').inputValue(),'execute');await field('paidConsent').check();await page.locator('#submit-task').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('余额保护需要配置'));assert.equal(app.store.tasks().length,0);
 await walletPanel();
 await page.locator('#wallet-form [name=rememberToken]').check();await page.locator('#wallet-form [name=token]').fill(TOKEN);await page.locator('#wallet-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#wallet-balance').textContent==='¥3.500');assert.equal(await page.locator('#wallet-form [name=token]').inputValue(),'');assert.equal(await field('includeVouchers').isChecked(),false);assert.equal(await page.locator('#wallet-vouchers').textContent(),'¥50.000');
 // 无库存时区分列表单卡价与完整报价，保留可先监测的入口。
 await view('dashboard');autodl.availableAfter=2;await page.locator('#refresh-pricing').click();
 await page.waitForFunction(()=>document.querySelector('#price-status').textContent.includes('暂无满足所选数量'));
 assert.equal(await page.locator('#price-unit').textContent(),'¥1.980');assert.equal(await page.locator('#price-detail').isHidden(),true);assert.equal(await page.locator('#price-hourly').textContent(),'—');assert.equal(await page.locator('#price-storage').textContent(),'—');
 assert.match(await page.locator('#budget-status').textContent(),/仍可先启用监测/);assert.equal(await page.locator('#check-budget').isDisabled(),true);assert.equal(await page.locator('#submit-task').isEnabled(),true);
 autodl.availableAfter=1;
 await field('expectedHours').fill('2');await field('balanceReserve').fill('1');await page.locator('#refresh-pricing').click();await page.waitForFunction(()=>document.querySelector('#price-hourly').textContent==='¥3.960');assert.match(await page.locator('#budget-status').textContent(),/余额不足/);
 // 旧后台缺少报价接口：提供可执行的重启说明，清除旧报价，恢复接口后可再次读取。
 pricingInterfaceMissing=true;await page.locator('#refresh-pricing').click();
 await page.waitForFunction(()=>document.querySelector('#price-status').textContent.includes('旧版代码'));
 assert.match(await page.locator('#price-status').textContent(),/正常停止旧后台/);assert.match(await page.locator('#price-status').textContent(),/npm\.cmd start/);
 for(const selector of ['#price-unit','#price-hourly','#price-storage'])assert.equal(await page.locator(selector).textContent(),'—');
 assert.equal(app.store.tasks().length,0);assert.equal(forbiddenCalls,0);
 pricingInterfaceMissing=false;await page.locator('#refresh-pricing').click();await page.waitForFunction(()=>document.querySelector('#price-hourly').textContent==='¥3.960');assert.equal(await page.locator('#price-detail').isVisible(),true);assert.equal(await page.locator('#price-cards').textContent(),'（2 卡）');
 // 普通的不存在任务仍应显示原错误，不被误判为后台版本问题。
 const missingTask=await page.evaluate(async()=>{try{await api('/api/tasks/missing-task/pause',{});return null;}catch(error){return {message:error.message,status:error.status,code:error.code};}});
 assert.equal(missingTask.status,404);assert.equal(missingTask.message.includes('旧版代码'),false);

 await page.locator('#submit-task').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('低于本次预检所需'));assert.equal(app.store.tasks().length,0);
 assets=100000;await walletPanel();await page.locator('#refresh-wallet').click();await page.waitForFunction(()=>document.querySelector('#wallet-balance').textContent==='¥100.000');await view('dashboard');await page.locator('#check-budget').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('余额预检通过'));await page.locator('#submit-task').click();await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='1');
 const task=app.store.tasks()[0];assert.equal(task.config.copyDataDisk,false);assert.equal(task.config.gpuModel,'A100 80GB');assert.equal(task.config.gpuCount,2);assert.deepEqual(task.config.regions,['北京B区']);assert.equal(task.balanceCheck.required,8.92);assert.equal(task.state,'queued');assert.equal(task.operation,null);assert.equal(posts.at(-1).copyDataDisk,false);assert.equal(posts.at(-1).pricePolicy,'official');assert.equal(task.config.maxTotalHourly,null);assert.equal(await page.locator('#wallet-form [name=token]').inputValue(),'');assert.equal(app.wallet.publicState().rememberToken,true);
 await field('extraDiskGB').fill('1');assert.equal(await page.locator('#price-hourly').textContent(),'—');await field('extraDiskGB').fill('0');await page.locator('#refresh-pricing').click();await page.waitForFunction(()=>document.querySelector('#price-hourly').textContent==='¥3.960');
 const before=calls;await page.evaluate(()=>new Promise(resolve=>window.addEventListener('appstatechange',resolve,{once:true})));assert.equal(calls,before);
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1080});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false,'page overflow at '+width);}
 await page.setViewportSize({width:1440,height:1080});await page.screenshot({path:path.join(output,'account-sync.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'account-sync-mobile.png'),fullPage:true});
 await walletPanel();await page.locator('#clear-wallet').click();await page.waitForFunction(()=>document.querySelector('#wallet-balance').textContent==='—');await view('dashboard');await page.locator('[data-mode=create]').click();await selectSyntheticImage(page);await field('balanceGuard').uncheck();await field('paidConsent').check();await page.locator('#submit-task').click();await page.waitForFunction(()=>document.querySelector('#task-count').textContent==='2');assert.equal(app.store.tasks()[0].config.balanceGuard,false);assert.equal(app.store.tasks()[0].config.gpuModel,'L20');
 rows=rows.slice(1);await sourcePanel();await page.locator('#sync-instances').click();await page.waitForFunction(()=>document.querySelectorAll('#account-instances .instance-row').length===2);await view('dashboard');await page.locator('[data-mode=clone]').click();assert.equal(await field('sourceId').inputValue(),'');assert.equal(await field('sourceId').evaluate(n=>n.validity.valueMissing),true);
 assert.equal(JSON.stringify(app.store.publicState()).includes(TOKEN),false);assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8').includes(TOKEN),false);
 // 真实Chromium对本地克隆菜单/复选框/URL的演练；不加载AutoDL。
 const dom=await context.newPage();dom.on('pageerror',e=>errors.push(e.message));const adapter=new AutoDLBrowserAdapter(dir);adapter.page=dom;adapter.context=context;adapter.settle=async()=>{};
 adapter.checkPage=async()=>{};
 const cloneConfig=(extra={})=>normalizeConfig({provider:'autodl',mode:'clone',gpuModel:source.gpuModel,gpuCount:2,sourceId:source.id,maxGpuHourly:3,maxTotalHourly:6,maxStorageDaily:1,...extra});
 let rowReads=0;adapter.findInstanceRow=async()=>{rowReads++;return {row:dom.locator('table tbody tr'),info:source};};
 const openWith=async(options,config,id)=>{cloneOptions=options;adapter.cloneCache=null;await dom.goto(base+'/fixture/clone-dialog');return adapter.openClone({id,config});};
 for(const copyDataDisk of [true,false]){
  const config=cloneConfig({copyDataDisk}),result=await openWith({},config,'synthetic-clone-'+copyDataDisk);
  // AutoDL 不勾选数据盘时 copy_data_disk 为空字符串；源环境 CUDA 来自 image_cuda。
  const url=new URL(dom.url());assert.equal(url.searchParams.get('copy_data_disk'),copyDataDisk?'1':'');assert.equal(url.searchParams.get('use_address'),'');
  assert.equal(result.extraDiskGB,100);assert.equal(result.sourceCuda,'12.1');assert.equal(result.id,source.id);
 }
 // 10分钟内再次打开同一任务的克隆页：直接打开已读到的地址，不再展开源实例的菜单。
 const reads=rowReads,cached=await adapter.openClone({id:'synthetic-clone-false',config:cloneConfig({copyDataDisk:false})});
 assert.equal(rowReads,reads);assert.equal(cached.sourceCuda,'12.1');assert.match(dom.url(),/\/cloneInstance\?/);
 // 页面不符时停止且不继续：没有“源实例不受影响”说明、选中“克隆给他人”、继续不可用、克隆入口不可用、要求转移服务地址、缺少源环境 CUDA。
 for(const [options,code] of [[{notice:false},'CLONE_DOM'],[{othersSelected:true},'CLONE_DOM'],[{continueDisabled:true},'CLONE_LIMIT'],[{cloneDisabled:true},'SOURCE_UNAVAILABLE'],[{useAddress:true},'CLONE_URL'],[{imageCuda:''},'CUDA_SOURCE']]){
  await assert.rejects(openWith(options,cloneConfig(),'synthetic-guard-'+code+JSON.stringify(options)),e=>e.code===code,JSON.stringify(options));
  assert.equal(adapter.cloneCache,null,JSON.stringify(options));
 }
 // 克隆到其他型号：源环境 CUDA 12.1 不满足 Blackwell（如 RTX 5090）要求的 12.8，读克隆页时就停止。
 await assert.rejects(openWith({},cloneConfig({gpuModel:'RTX 5090'}),'synthetic-arch'),e=>e.code==='CUDA_ARCH'&&/12\.8/.test(e.message));
 // 只允许点击文字完全相同的“更多”“克隆实例”“继续”；菜单项文字不同（例如被替换成“释放实例”）时不点击。
 await assert.rejects(openWith({menuText:'释放实例'},cloneConfig(),'synthetic-wrong-menu'),e=>e.code==='CLONE_DOM');
 await dom.goto(base+'/fixture/clone-dialog');await assert.rejects(adapter.cloneClick(dom.locator('#start'),'开机'),e=>e.code==='SOURCE_GUARD');
 await assert.rejects(adapter.cloneClick(dom.locator('#start'),'更多'),e=>e.code==='SOURCE_GUARD');
 // 源实例的其他操作（开机、无卡模式、释放、重置、更换镜像等）一次都没有被点击。
 await dom.waitForTimeout(100);assert.deepEqual(danger,[]);
 const noCopy=cloneConfig({copyDataDisk:false});
 await dom.goto(base+'/fixture/prepared');const originalUrl=dom.url(),count=context.pages().length;
 adapter.findInstanceRow=async()=>{assert.notEqual(adapter.page,dom);return{info:source};};await adapter.revalidateSource({config:noCopy});assert.equal(adapter.page,dom);assert.equal(dom.url(),originalUrl);assert.equal(context.pages().length,count);
 adapter.findInstanceRow=async()=>({info:{...source,running:true,stopped:false}});await assert.rejects(adapter.revalidateSource({config:noCopy}),e=>e.code==='SOURCE_UNAVAILABLE');assert.equal(adapter.page,dom);assert.equal(context.pages().length,count);
 await view('profile');await page.locator('#logout-browser').click();assert.equal(await page.locator('#logout-dialog').isVisible(),true);await page.locator('#logout-cancel').click();assert.equal(await page.locator('#logout-dialog').isVisible(),false);assert.equal(app.store.tasks().some(t=>t.state==='queued'),true);
 await page.locator('#logout-browser').click();await page.locator('#logout-clear-credentials').check();await page.locator('#confirm-logout').click();await page.waitForFunction(()=>!document.querySelector('#logout-dialog').open);assert.equal(app.store.tasks().filter(t=>t.config.provider==='autodl').every(t=>t.state==='paused'),true);assert.equal(app.wallet.publicState().configured,false);assert.equal(app.ai.publicState().hasKey,false);
 assert.equal(forbiddenCalls,0);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
 console.log('账户页面与本地DOM演练通过：实例同步、源选择与字段锁定/恢复、运行及未知源禁用、数据盘选择、凭据记住及清除、官方报价读取与失效、余额不足拦截与正常入队、退出取消与确认、可选余额保护、5种宽度布局，以及复选框URL校验和独立源核验。引擎未启动，无真实账号、租卡或外部通知。');
} finally {
 await browser?.close();await app?.close();const target=path.resolve(dir);if(!target.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(target).startsWith('autodl-account-ui-isolated-'))throw Error('invalid isolated cleanup target');fs.rmSync(target,{recursive:true,force:true});
}

