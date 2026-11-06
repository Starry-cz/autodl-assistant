import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { SyntheticAdapter } from '../tests/fixtures/synthetic-adapter.mjs';
import { seedGpuCatalog } from '../tests/fixtures/gpu-catalog.mjs';
import { SYNTHETIC_IMAGES, syntheticImageOptions, selectSyntheticImage } from '../tests/fixtures/images.mjs';

// 隔离的本地页面与合成菜单；引擎不启动，禁止真实付费和外部调用。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 回归截图仅保留在被 Git 忽略的本机输出目录，不写入发布文档。
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-images-ui-isolated-'));
const errors = [], blocked = [], requests = [], ids = ['#image-framework','#image-version','#image-python','#image-cuda'];
const source = {id:'syntheticimage-source',region:'北京B区',gpuModel:'RTX 4090',gpuCount:1,stopped:true,running:false};
let app, browser, ready = true, responseMode = 'normal', forbiddenCalls = 0, releaseRead;
const forbidden = async () => { forbiddenCalls++; throw Error('镜像回归禁止真实操作'); };
const fixture = '<!doctype html><meta charset="utf-8"><style>[hidden]{display:none!important}.panel{display:flex}.el-cascader-menu{width:190px;margin:0;padding:10px;list-style:none}.el-cascader-node{padding:8px;cursor:pointer}.is-disabled{color:#aaa}input{width:650px}</style>' +
  '<label role="radio">基础镜像<input type="radio" checked></label><div class="el-cascader"><input readonly value="PyTorch / 2.8.0 / 3.12(ubuntu22.04) / 12.8"></div><div class="panel" hidden></div>' +
  '<script>const images='+JSON.stringify(SYNTHETIC_IMAGES)+';const titles=["框架名称","框架版本","Python版本","CUDA版本"];let parts=images[1].slice();const panel=document.querySelector(".panel"),input=document.querySelector(".el-cascader input");' +
  // 与 Element 级联菜单一致：已展开路径上的节点带 in-active-path。?lazy=1 时首次展开某个节点要约300ms，期间仍显示上一分支的下一级。
  'const lazy=new URLSearchParams(location.search).has("lazy"),loaded=new Set();' +
  'function render(){panel.replaceChildren();for(let level=0;level<Math.min(parts.length+1,4);level++){const menu=document.createElement("ul");menu.className="el-cascader-menu";const title=document.createElement("li");title.className="el-cascader-node is-disabled";title.textContent=titles[level];menu.append(title);const matches=images.filter(row=>parts.slice(0,level).every((v,i)=>row[i]===v));const labels=[...new Set(matches.map(row=>row[level]))];for(const label of labels.concat(level===0?["Disabled framework"]:[])){const node=document.createElement("li");node.className="el-cascader-node";if(parts[level]===label)node.classList.add(level<3?"in-active-path":"is-active");if(label==="Disabled framework"){node.classList.add("is-disabled");node.setAttribute("aria-disabled","true")}const span=document.createElement("span");span.className="el-cascader-node__label";span.textContent=(level===3?titles[level]:"")+label;node.append(span);node.addEventListener("click",()=>{if(node.classList.contains("is-disabled"))return;const key=parts.slice(0,level).concat(label).join("/");if(level<3&&lazy&&!loaded.has(key)){const icon=document.createElement("i");icon.className="el-icon-loading";node.append(icon);setTimeout(()=>{loaded.add(key);parts=parts.slice(0,level).concat(label);render();},300);return;}loaded.add(key);parts=parts.slice(0,level).concat(label);if(level===3){input.value=parts.join(" / ");panel.hidden=true}else render()});menu.append(node)}panel.append(menu)}}input.addEventListener("click",()=>{panel.hidden=!panel.hidden;if(!panel.hidden)render()});</script>';

try {
  const autodl = Object.assign(new SyntheticAdapter(), {
    sessionStatus: () => ({state:ready?'ready':'expired',browserOpen:true,label:ready?'会话可用':'登录已失效',message:'隔离会话',checkedAt:1}),
    login:forbidden,checkLogin:forbidden,submit:forbidden,reconcile:forbidden,
    instances:async()=>[source],
    imageOptions:async prefix=>{
      requests.push([...prefix]);
      if(responseMode==='deferred') await new Promise(resolve=>{releaseRead=resolve;});
      const result=await syntheticImageOptions(prefix);
      if(responseMode==='empty')result.options=[];
      if(responseMode==='disabled')result.options=result.options.map(item=>({...item,disabled:true}));
      if(responseMode==='duplicate')result.options=[{label:'PyTorch',disabled:false},{label:'PyTorch',disabled:false}];
      return result;
    },
  });
  app=createApplication({runtimeDir:dir,startEngine:false,adapters:{autodl},aiOptions:{fetchImpl:forbidden},walletOptions:{fetchImpl:forbidden}});
  // 模拟上次“同步 AutoDL 型号”保存在本机的合成目录。
  seedGpuCatalog(app.store);
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.server.address().port;
  const executablePath=[process.env.AI_TEST_BROWSER, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(file=>fs.existsSync(file));
  if(!executablePath)throw Error('未找到测试浏览器');
  browser=await chromium.launch({executablePath,headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'});
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){blocked.push(url.href);return route.abort();}
    if(url.pathname==='/fixture/images')return route.fulfill({contentType:'text/html; charset=utf-8',body:fixture});
    if(url.pathname==='/api/autodl/images'&&responseMode==='missing')return route.fulfill({status:404,json:{error:'NOT_FOUND',message:'接口不存在'}});
    if(url.pathname==='/api/autodl/images'&&responseMode==='failure')return route.fulfill({status:503,json:{error:'NETWORK',message:'合成菜单暂时无法读取'}});
    return route.continue();
  });
  const page=await context.newPage();await page.goto(base);await page.waitForFunction(()=>document.querySelector('#connection').textContent==='已连接');
  // 默认监控室与源实例折叠区各有独立入口，不直接操作隐藏表单。
  await page.locator('[data-view=dashboard]').click();
  const form=page.locator('#task-form'),field=name=>form.locator('[name='+name+']');
  const values=id=>page.locator(id).locator('option').evaluateAll(options=>options.filter(o=>o.value&&!o.disabled).map(o=>o.value));
  const waitChoice=async (id,label)=>page.waitForFunction(([id,label])=>{const s=document.querySelector(id);return !s.disabled&&[...s.options].some(o=>o.value===label&&!o.disabled);},[id,label]);
  const refresh=async()=>{await page.evaluate(()=>refresh());};
  assert.equal(await field('imagePath').inputValue(),'');assert.equal(await field('cuda').inputValue(),'');
  assert.equal(await field('imagePath').getAttribute('readonly'),'');assert.equal(await field('cuda').evaluate(n=>n.type==='hidden'&&n.required),true);
  for(const id of ids)assert.equal(await page.locator(id).isDisabled(),true);
  assert.deepEqual(requests,[]);
  await field('gpuModel').selectOption('RTX 4090');await page.locator('[data-action-choice=observe]').click();
  await selectSyntheticImage(page);
  assert.deepEqual(requests,[[],['PyTorch'],['PyTorch','2.1.0'],['PyTorch','2.1.0','3.10(ubuntu22.04)']]);
  assert.deepEqual(await values(ids[3]),['12.1']);assert.equal(await field('cuda').inputValue(),'12.1');
  assert.equal(await field('imagePath').inputValue(),SYNTHETIC_IMAGES[0].join(' / '));
  await page.locator('#pricing-options > summary').click();
  await page.locator('#refresh-pricing').click();await page.waitForFunction(()=>document.querySelector('#price-hourly').textContent==='¥1.980');
  await page.locator(ids[1]).selectOption('2.8.0');await waitChoice(ids[2],'3.12(ubuntu22.04)');
  assert.equal(await field('imagePath').inputValue(),'');assert.equal(await field('cuda').inputValue(),'');assert.equal(await page.locator('#price-hourly').textContent(),'—');
  assert.equal(await page.locator(ids[3]).isDisabled(),true);assert.equal(await page.locator(ids[2]).inputValue(),'');
  await page.locator(ids[2]).selectOption('3.12(ubuntu22.04)');await waitChoice(ids[3],'12.8');
  assert.deepEqual(await values(ids[3]),['12.8','13.0']);await page.locator(ids[3]).selectOption('12.8');
  assert.equal(await field('cuda').inputValue(),'12.8');
  const createPath=await field('imagePath').inputValue();
  await page.locator('[data-view=fleet]').click();await page.locator('#fleet-sources > summary').click();
  await page.locator('#sync-instances').click();await page.waitForFunction(()=>document.querySelector('#task-form').elements.sourceId.options.length===2);
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-mode=clone]').click();await field('sourceId').selectOption(source.id);
  // 克隆不填写 CUDA：环境随源实例系统盘，首次检查时从 AutoDL 克隆页读取。
  assert.equal(await field('cuda').inputValue(),'');assert.equal(await field('cuda').evaluate(n=>n.type==='hidden'&&!n.required),true);
  assert.equal(await field('imagePath').isDisabled(),true);
  assert.equal(await page.locator('#create-fields select').evaluateAll(selects=>selects.every(s=>s.disabled&&!s.required)),true);
  assert.equal(await form.evaluate(form=>form.checkValidity()),true);
  await page.locator('[data-mode=create]').click();assert.equal(await field('cuda').inputValue(),'12.8');assert.equal(await field('imagePath').inputValue(),createPath);
  await page.locator('[data-mode=clone]').click();assert.equal(await field('cuda').inputValue(),'');await page.locator('[data-mode=create]').click();
  for(const mode of ['failure','missing','empty','disabled','duplicate']){
    responseMode=mode;await page.locator('#sync-images').click();
    const expected=mode==='failure'?'同步失败':mode==='missing'?'旧版代码':mode==='duplicate'?'重名选项':'暂无可用';
    await page.waitForFunction(text=>document.querySelector('#image-status').textContent.includes(text),expected);
    assert.equal(await field('imagePath').inputValue(),'');assert.equal(await field('cuda').inputValue(),'');assert.equal(await page.locator(ids[0]).isDisabled(),true);
  }
  responseMode='deferred';await page.locator('#sync-images').click();
  await page.waitForFunction(()=>document.querySelector('#sync-images').textContent.includes('正在同步'));
  while(!releaseRead)await new Promise(resolve=>setImmediate(resolve));
  await page.locator('[data-mode=clone]').click();responseMode='normal';releaseRead();releaseRead=null;
  await page.waitForResponse(response=>response.url()===base+'/api/autodl/images');
  await page.locator('[data-mode=create]').click();assert.equal(await page.locator(ids[0]).isDisabled(),true);assert.equal(await field('imagePath').inputValue(),'');
  await refresh();await selectSyntheticImage(page,SYNTHETIC_IMAGES[1]);
  ready=false;await refresh();assert.equal(await page.locator('#sync-images').isDisabled(),true);assert.equal(await field('imagePath').inputValue(),'');assert.equal(await field('cuda').inputValue(),'');
  ready=true;await refresh();await selectSyntheticImage(page,SYNTHETIC_IMAGES[1]);
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:1080});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false,'image page overflow '+width);
  }
  await page.locator('#toast').waitFor({state:'hidden',timeout:10000});
  await page.setViewportSize({width:1440,height:1080});await form.screenshot({path:path.join(output,'official-images.png')});
  await page.setViewportSize({width:390,height:844});await form.screenshot({path:path.join(output,'official-images-mobile.png')});

  // 真实浏览器运行 Element 风格的本地合成 DOM，覆盖适配器而非仅模拟返回值。
  const dom=await context.newPage();await dom.goto(base+'/fixture/images');
  const adapter=new AutoDLBrowserAdapter(dir);adapter.page=dom;adapter.context=context;adapter.settle=async()=>{};adapter.checkPage=async()=>{};
  const prepared={taskId:'preserve-prepared-form'};adapter.prepared=prepared;let fixtureQuery='',gotoCalls=0;
  adapter.goto=async function(url){assert.equal(url,'https://www.autodl.com/create');gotoCalls++;await this.page.goto(base+'/fixture/images'+fixtureQuery);};
  const roots=await adapter.imageOptions([]);assert.deepEqual(roots.options,[{label:'PyTorch',disabled:false},{label:'Miniconda',disabled:false},{label:'Disabled framework',disabled:true}]);
  // 镜像菜单标签页读完保留，主任务页面与准备状态不变。
  assert.equal(adapter.page,dom);assert.equal(adapter.prepared,prepared);assert.equal(context.pages().length,3);
  const leaf=await adapter.imageOptions(SYNTHETIC_IMAGES[1].slice(0,3));assert.deepEqual(leaf.options.map(o=>o.label),['12.8','13.0']);
  assert.equal(leaf.reused,true);assert.equal(gotoCalls,1);assert.equal(context.pages().length,3);
  const otherBranch=await adapter.imageOptions(SYNTHETIC_IMAGES[0].slice(0,3));assert.deepEqual(otherBranch.options.map(o=>o.label),['12.1']);assert.equal(otherBranch.reused,true);
  await assert.rejects(adapter.imageOptions(['PyTorch','2.1.0','3.12(ubuntu22.04)']),error=>error.code==='IMAGE_MISSING'&&error.message.includes('3.10(ubuntu22.04)'));
  assert.equal(adapter.page,dom);assert.equal(context.pages().length,2);
  // 合成延迟加载：首次展开某选项约300ms，期间仍显示上一分支的下一级。复用与新开页面都必须等展开完成，不能读到上一分支。
  fixtureQuery='?lazy=1';await adapter.imageOptions([]);
  const lazyVersions=await adapter.imageOptions(['Miniconda']);assert.equal(lazyVersions.reused,true);assert.deepEqual(lazyVersions.options.map(o=>o.label),['conda3']);
  const backToPyTorch=await adapter.imageOptions(['PyTorch']);assert.deepEqual(backToPyTorch.options.map(o=>o.label),['2.1.0','2.8.0']);
  adapter.imageReuse=false;const freshLazy=await adapter.imageOptions(['Miniconda']);assert.equal(freshLazy.reused,false);assert.deepEqual(freshLazy.options.map(o=>o.label),['conda3']);
  adapter.imageReuse=undefined;fixtureQuery='';await adapter.closeImageTab();assert.equal(context.pages().length,2);
  await adapter.selectImage({imagePath:SYNTHETIC_IMAGES[1],cuda:'12.8'});assert.equal(await dom.locator('.el-cascader input').inputValue(),createPath);
  await assert.rejects(adapter.selectImage({imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','13.0'],cuda:'13.0'}),error=>error.code==='IMAGE_MISSING'&&error.message.includes('当前可选：12.1'));
  await assert.rejects(adapter.chooseImagePath(['Disabled framework']),error=>error.code==='IMAGE_MISSING');
  await dom.evaluate(()=>document.querySelector('.el-cascader-menu').append(document.querySelector('.el-cascader-menu .el-cascader-node:nth-child(2)').cloneNode(true)));
  await assert.rejects(adapter.imageLevel(0),error=>error.code==='IMAGE_AMBIGUOUS');
  assert.equal(app.store.tasks().length,0);assert.equal(forbiddenCalls,0);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  console.log('官方镜像页面回归通过：四级分支、CUDA自动带入、清除旧报价、创建/克隆独立配置、失败/404/空/禁用/重名选项、迟到响应、会话失效、5种宽度，以及本地Element菜单读取和精确选择。全部为隔离数据，无真实租卡或外部调用。');
} finally {
  releaseRead?.();await browser?.close();await app?.close();
  const resolved=path.resolve(dir),parent=path.resolve(os.tmpdir())+path.sep;
  if(!resolved.startsWith(parent)||!path.basename(resolved).startsWith('autodl-images-ui-isolated-'))throw Error('invalid isolated cleanup target');
  fs.rmSync(resolved,{recursive:true,force:true});
}

