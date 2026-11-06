import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_LEVELS, normalizeImagePrefix, imageLabel, imageCuda, exactImagePath } from '../src/images.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { AppError } from '../src/errors.mjs';
test('官方镜像请求只接受最多三级的有界文本前缀',()=>{
  assert.deepEqual(normalizeImagePrefix(),[]);
  assert.deepEqual(normalizeImagePrefix([' PyTorch ','2.8.0']),['PyTorch','2.8.0']);
  for(const prefix of [null,{},'PyTorch',[''],['a','b','c','d'],['x'.repeat(151)],['a/b'],['a\n']])assert.throws(()=>normalizeImagePrefix(prefix),error=>error.code==='IMAGE_PREFIX');
});
test('镜像标签清理保留精确版本；路径不能用包含关系验证',()=>{
  assert.equal(imageLabel(' CUDA版本 12.8 ',3),'12.8');assert.equal(imageLabel('框架名称PyTorch',0),'PyTorch');
  assert.equal(imageCuda('CUDA 12.8'),'12.8');assert.equal(imageCuda('13.0'),'13.0');assert.equal(imageCuda('CPU'),null);
  const expected=['PyTorch','2.8.0','3.12(ubuntu22.04)','12.8'];
  assert.equal(exactImagePath(expected.join(' / '),expected),true);
  for(const selected of ['PyTorch / 12.8.0 / 3.12(ubuntu22.04) / 12.8',expected.join(' / ')+'0',expected.join(' / ')+' / other'])assert.equal(exactImagePath(selected,expected),false);
});
test('镜像缺失错误列出当前分支选项，不自动降级 CUDA 或跳过一级',async()=>{
  const adapter=new AutoDLBrowserAdapter('unused-isolated-profile'),clicks=[];
  const paths=[['PyTorch'],['2.1.0'],['3.10(ubuntu22.04)'],['12.1']];
  adapter.imageLevel=async level=>paths[level].map(label=>({label,disabled:false,node:{click:async()=>clicks.push(label)}}));
  await assert.rejects(adapter.chooseImagePath(['PyTorch','2.1.0','3.10(ubuntu22.04)','13.0']),error=>error.code==='IMAGE_MISSING'&&error.message.includes('当前可选：12.1')&&error.message.includes('不会自动更换版本'));
  assert.deepEqual(clicks,['PyTorch','2.1.0','3.10(ubuntu22.04)']);
});
test('已禁用镜像不被选择；四级路径按原顺序点击',async()=>{
  const adapter=new AutoDLBrowserAdapter('unused-isolated-profile'),clicks=[];
  adapter.imageLevel=async level=>[{label:IMAGE_LEVELS[level],disabled:false,node:{click:async()=>clicks.push(level)}},{label:'disabled',disabled:true,node:{click:async()=>{throw Error('不能点击');}}}];
  await assert.rejects(adapter.chooseImagePath(IMAGE_LEVELS.map((label,i)=>'value'+i)),error=>error.code==='IMAGE_MISSING');
  assert.deepEqual(clicks,[]);
  adapter.imageLevel=async level=>[{label:'value'+level,disabled:false,node:{click:async()=>clicks.push(level)}}];
  await adapter.chooseImagePath(['value0','value1','value2','value3']);assert.deepEqual(clicks,[0,1,2,3]);
});
test('官方菜单读取使用单独标签页，主任务表单不变；成功后保留标签页供下一级使用，失败时关闭',async t=>{
  for(const broken of [false,true]){
    const adapter=new AutoDLBrowserAdapter('unused-isolated-profile'),main={isClosed:()=>false},prepared={taskId:'isolated-task'};
    let closed=0,visited='',clicked=[],gotoPage=null;const page={isClosed:()=>closed>0,setDefaultTimeout(){},setDefaultNavigationTimeout(){},close:async()=>{closed++;}};
    const context={newPage:async()=>page};Object.assign(adapter,{page:main,context,prepared});
    adapter.browser=async()=>main;adapter.goto=async function(url){visited=url;gotoPage=this.page;};
    adapter.openImageMenu=async()=>{if(broken)throw Error('合成读取失败');};adapter.chooseImagePath=async prefix=>{clicked=prefix;};
    adapter.imageLevel=async()=>[{label:'12.8',disabled:false},{label:'CPU',disabled:false}];
    if(broken)await assert.rejects(adapter.imageOptions(['PyTorch','2.8.0','3.12(ubuntu22.04)']),/合成读取失败/);
    else{const result=await adapter.imageOptions(['PyTorch','2.8.0','3.12(ubuntu22.04)']);assert.equal(result.level,3);assert.equal(result.reused,false);assert.deepEqual(result.options,[{label:'12.8',disabled:false},{label:'CPU',disabled:true}]);assert.deepEqual(clicked,result.prefix);}
    assert.equal(visited,'https://www.autodl.com/create');assert.equal(gotoPage,page);assert.equal(closed,broken?1:0);assert.equal(adapter.imageTab,broken?null:page);
    assert.equal(adapter.page,main);assert.equal(adapter.prepared,prepared);
    await adapter.closeImageTab();
  }
});
test('逐级选择复用已打开的镜像菜单：不新开页面、不重新打开创建页，确认展开后才读下一级',async()=>{
  const adapter=new AutoDLBrowserAdapter('unused-isolated-profile'),main={isClosed:()=>false};let pages=0,gotos=0,checks=0;
  const page=()=>({closed:false,isClosed(){return this.closed;},setDefaultTimeout(){},setDefaultNavigationTimeout(){},async close(){this.closed=true;}});
  Object.assign(adapter,{page:main,context:{newPage:async()=>{pages++;return page();}}});adapter.browser=async()=>main;
  adapter.goto=async()=>{gotos++;};adapter.checkPage=async()=>{checks++;};adapter.openImageMenu=async()=>{};
  const node=(active=true)=>({click:async()=>{},evaluate:async()=>({active,loading:false})});
  adapter.imageLevel=async level=>[{label:['PyTorch','2.8.0','3.12(ubuntu22.04)','12.8'][level],disabled:false,node:node()}];
  await adapter.imageOptions([]);assert.equal(pages,1);assert.equal(gotos,1);
  const version=await adapter.imageOptions(['PyTorch']);assert.equal(version.reused,true);assert.deepEqual(version.options.map(o=>o.label),['2.8.0']);
  const cuda=await adapter.imageOptions(['PyTorch','2.8.0','3.12(ubuntu22.04)']);assert.equal(cuda.reused,true);assert.equal(pages,1);assert.equal(gotos,1);assert.equal(checks,2);
  // 点“同步官方镜像”（第一级）总是重新打开页面。
  await adapter.imageOptions([]);assert.equal(pages,2);assert.equal(gotos,2);
  await adapter.closeImageTab();
});
test('复用时无法确认展开就改用新页面重读，本次运行不再复用；登录失效直接报错',async()=>{
  const adapter=new AutoDLBrowserAdapter('unused-isolated-profile'),main={isClosed:()=>false};let pages=0,gotos=0;adapter.imageExpandMs=80;
  const page=()=>({closed:false,isClosed(){return this.closed;},setDefaultTimeout(){},setDefaultNavigationTimeout(){},async close(){this.closed=true;}});
  Object.assign(adapter,{page:main,context:{newPage:async()=>{pages++;return page();}}});adapter.browser=async()=>main;
  adapter.goto=async()=>{gotos++;};adapter.checkPage=async()=>{};adapter.openImageMenu=async()=>{};
  // 合成菜单没有展开标记：复用必须放弃，新页面按原方式读取。
  adapter.imageLevel=async level=>[{label:['PyTorch','2.8.0'][level],disabled:false,node:{click:async()=>{},evaluate:async()=>({active:false,loading:false})}}];
  await adapter.imageOptions([]);const version=await adapter.imageOptions(['PyTorch']);
  assert.equal(version.reused,false);assert.deepEqual(version.options.map(o=>o.label),['2.8.0']);assert.equal(adapter.imageReuse,false);assert.equal(pages,2);
  await adapter.imageOptions(['PyTorch']);assert.equal(pages,3);
  const expired=new AutoDLBrowserAdapter('unused-isolated-profile');let fresh=0;
  Object.assign(expired,{page:main,context:{newPage:async()=>{fresh++;return page();}}});expired.browser=async()=>main;
  expired.goto=async()=>{};expired.openImageMenu=async()=>{};expired.imageLevel=async()=>[{label:'PyTorch',disabled:false}];
  await expired.imageOptions([]);expired.checkPage=async()=>{throw new AppError('LOGIN_REQUIRED','合成登录失效');};
  await assert.rejects(expired.imageOptions(['PyTorch']),e=>e.code==='LOGIN_REQUIRED');assert.equal(fresh,1);assert.equal(expired.imageTab,null);
  await adapter.closeImageTab();
});

test('读取镜像过程中浏览器关闭时，不恢复失效表单或旧准备状态',async()=>{
  const adapter=new AutoDLBrowserAdapter('unused-isolated-profile');
  const main={isClosed:()=>false},page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},close:async()=>{}};
  const context={newPage:async()=>page};Object.assign(adapter,{page:main,context,prepared:{taskId:'isolated-task'}});
  adapter.browser=async()=>main;adapter.goto=async()=>{};adapter.openImageMenu=async()=>{};
  adapter.chooseImagePath=async()=>{adapter.context=null;};adapter.imageLevel=async()=>[{label:'PyTorch',disabled:false}];
  await adapter.imageOptions([]);
  assert.equal(adapter.page,null);assert.equal(adapter.prepared,null);assert.equal(adapter.sessionStatus().state,'closed');
});

