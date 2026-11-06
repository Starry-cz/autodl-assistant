import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

// 真实浏览器中的合成页面：所有请求由本脚本拦截并返回本地夹具，域名解析全部禁用，不会访问 AutoDL 或任何网站。
// 只验证并行实例基线标签页与点击结果判断，不登录、不租卡、不点击任何真实按钮。
const blocked = [], errors = [];
let listMode = 'ready';
const rows = [[['synthetic01-abc123', '922机'], ['synthetic02-abc123', '923机']], [['synthetic03-abc123', '924机']]];
const listPage = () => listMode === 'login'
  ? '<!doctype html><meta charset="utf-8"><body><h2>账号登录</h2><input type="password"><button>登录</button></body>'
  : '<!doctype html><meta charset="utf-8"><body><h2>容器实例</h2><div class="el-table instance-table"><div class="el-table__header-wrapper"><table><thead><tr><th>实例ID/名称</th><th>地区</th><th>配置</th><th>主机</th><th>状态</th></tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody id="rows"></tbody></table></div></div>'
    + '<div class="el-pagination"><button class="btn-next">下一页</button></div><script>const pages=' + JSON.stringify(rows) + ';let p=0;'
    + 'function render(){document.getElementById("rows").innerHTML=pages[p].map(r=>"<tr><td><div style=\\"cursor:pointer\\">"+r[0]+"</div><div><span>合成实例</span></div></td><td>北京B区</td><td>RTX 4090 × 1</td><td>"+r[1]+"</td><td>已关机</td></tr>").join("");'
    + 'document.querySelector(".btn-next").disabled=p===pages.length-1;}'
    + 'document.querySelector(".btn-next").onclick=()=>setTimeout(()=>{p++;render();},150);render();</script></body>';
const createPage = '<!doctype html><meta charset="utf-8"><body><div id="old" class="el-message el-message--error" style="display:none">旧的错误提示</div>'
  + '<button type="button" id="submit">创建并开机</button><script>const mode=new URLSearchParams(location.search).get("mode");'
  // 按用户截图复现 AutoDL 的“错误”通知：Element 通知结构、标题“错误”、没有类型图标。
  + 'const notify="<div class=\\"el-notification__group\\"><h2 class=\\"el-notification__title\\">错误</h2><div class=\\"el-notification__content\\"><p>该主机已租满，请更换主机重新创建实例</p></div><div class=\\"el-notification__closeBtn el-icon-close\\"></div></div>";'
  + 'if(mode==="stale")document.getElementById("old").style.display="block";'
  + 'if(mode==="stale-repeat"){const n=document.createElement("div");n.className="el-notification right";n.innerHTML=notify;document.body.append(n);}'
  + 'if(mode==="nobutton")document.getElementById("submit").textContent="立即创建";'
  + 'const add=(cls,html)=>setTimeout(()=>{const n=document.createElement("div");n.className=cls;n.innerHTML=html;document.body.append(n);},120);'
  + 'document.getElementById("submit").onclick=()=>{'
  + 'if(mode==="accept")setTimeout(()=>{location.href="/console/instance/list";},100);'
  + 'if(mode==="toast")add("el-message el-message--error","<p class=\\"el-message__content\\">GPU资源不足，请稍后再试</p>");'
  + 'if(mode==="notify"||mode==="stale-repeat")add("el-notification right",notify);'
  + 'if(mode==="info")setTimeout(()=>{const n=document.createElement("div");n.className="el-notification right";n.innerHTML="<div class=\\"el-notification__group\\"><h2 class=\\"el-notification__title\\">提示</h2><div class=\\"el-notification__content\\"><p>实例创建中</p></div></div>";document.body.append(n);setTimeout(()=>{location.href="/console/instance/list";},150);},50);'
  + 'if(mode==="dialog")add("el-message-box__wrapper","<div class=\\"el-message-box\\"><span>提示</span><p>是否继续？</p><button>确定</button></div>");'
  // 不是 Element 组件的浮层提示（自定义类名、fixed 定位），只靠新加入的元素和明确失败文字识别。
  + 'if(mode==="custom")setTimeout(()=>{const n=document.createElement("div");n.className="ad-toast";n.style.cssText="position:fixed;top:10px;right:10px";n.innerHTML="<b>错误</b><span>该主机已租满，请更换主机重新创建实例</span>";document.body.append(n);},120);'
  // 表单校验错误也算本次没有提交成功。
  + 'if(mode==="formerror")setTimeout(()=>{const n=document.createElement("div");n.className="el-form-item__error";n.textContent="请选择主机";document.body.append(n);},80);'
  + 'if(mode==="loading")document.getElementById("submit").classList.add("is-loading");};</script></body>';
const candidates = [process.env.AI_TEST_BROWSER, chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const executablePath = candidates.find(candidate => fs.existsSync(candidate));
if (!executablePath) throw Error('未找到浏览器，请安装 Playwright Chromium 或用 AI_TEST_BROWSER 指定测试浏览器');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/console/instance/list') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: listPage() });
    if (url.origin === 'https://www.autodl.com' && url.pathname === '/create') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: createPage });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    blocked.push(url.href); return route.abort();
  });
  const main = await context.newPage(); main.on('pageerror', error => errors.push(error.message));
  await main.goto('https://www.autodl.com/create?mode=accept');
  const adapter = new AutoDLBrowserAdapter(path.join(os.tmpdir(), 'autodl-submit-ui-unused-profile'));
  adapter.context = context; adapter.page = main; adapter.setSession('ready', { checked: true });
  adapter.clickOutcomeMs = 1500; adapter.clickLoadingMs = 2500; adapter.rejectGraceMs = 300; adapter.clickPollMs = 50;

  // 并行实例基线：另一个标签页加载并翻页读取，主标签页同时可操作；结束后标签页关闭。
  const baseline = await adapter.startBaseline('RTX 4090');
  assert.equal(context.pages().length, 2);
  assert.equal(await main.locator('#submit').textContent(), '创建并开机');
  const instances = await baseline.collect();
  assert.deepEqual(instances.map(i => i.id), ['synthetic01-abc123', 'synthetic02-abc123', 'synthetic03-abc123']);
  assert.equal(instances[2].hostNumber, '924机'); assert.equal(adapter.session.state, 'ready');
  await baseline.close(); assert.equal(context.pages().length, 1); assert.equal(adapter.page, main);

  // 基线页发现登录失效时，状态写回同一个会话，主任务据此停止。
  listMode = 'login';
  const expired = await adapter.startBaseline('RTX 4090');
  await assert.rejects(expired.collect(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(adapter.session.state, 'expired'); await expired.close();
  listMode = 'ready'; adapter.setSession('ready', { checked: true });

  // 点击结果：跳回实例列表、新出现报错、AutoDL“已租满”通知、新弹窗、点击前已存在的旧报错、同一句通知再次弹出、中性提示后跳转。
  const outcomes = {};
  for (const mode of ['accept', 'toast', 'notify', 'dialog', 'stale', 'stale-repeat', 'info', 'custom', 'formerror', 'loading']) {
    await main.goto('https://www.autodl.com/create?mode=' + mode);
    const formUrl = main.url();
    await adapter.markClickSignals();
    await main.locator('#submit').click();
    outcomes[mode] = await adapter.clickOutcome(formUrl);
  }
  assert.deepEqual(outcomes.accept, { kind: 'accepted' });
  assert.deepEqual(outcomes.toast, { kind: 'rejected', message: 'GPU资源不足，请稍后再试' });
  assert.deepEqual(outcomes.notify, { kind: 'rejected', message: '该主机已租满，请更换主机重新创建实例' });
  assert.equal(outcomes.dialog.kind, 'dialog'); assert.match(outcomes.dialog.message, /是否继续/);
  assert.equal(outcomes.stale.kind, 'unknown'); assert.equal(outcomes.stale.busy, false); assert.deepEqual(outcomes.stale.others, []);
  assert.deepEqual(outcomes['stale-repeat'], { kind: 'rejected', message: '该主机已租满，请更换主机重新创建实例' });
  assert.deepEqual(outcomes.info, { kind: 'accepted' });
  assert.equal(outcomes.custom.kind, 'rejected'); assert.match(outcomes.custom.message, /该主机已租满/);
  assert.deepEqual(outcomes.formerror, { kind: 'rejected', message: '请选择主机' });
  assert.equal(outcomes.loading.kind, 'unknown'); assert.equal(outcomes.loading.busy, true);

  // 找不到“创建并开机”时列出页面上的按钮文字。
  await main.goto('https://www.autodl.com/create?mode=nobutton');
  await assert.rejects(adapter.submitButton(), error => error.code === 'SUBMIT_DOM' && error.message.includes('立即创建'));
  assert.equal((await adapter.submitButton({ race: false }).catch(error => error)).code, 'SUBMIT_DOM');
  await main.goto('https://www.autodl.com/create?mode=accept');
  assert.equal(await (await adapter.submitButton()).count(), 1);
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  console.log('提交页面回归通过：并行实例基线标签页翻页读取、登录失效写回会话、标签页关闭；点击后跳回列表/新报错/AutoDL“已租满”无图标通知/新弹窗/点击前旧报错/同一句通知再次弹出/中性提示后跳转/非 Element 浮层提示/表单校验错误/按钮仍在加载十种结果判断；创建按钮缺失时列出可见按钮。全部为本地夹具，域名解析已禁用，无真实请求。');
} finally { await browser.close(); }

