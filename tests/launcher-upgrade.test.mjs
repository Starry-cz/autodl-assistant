import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const shell = path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function run(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
}
const ps = (file, args, env, cwd) => run(shell, ['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args], env, cwd);
const quote = value => "'" + value.replaceAll("'", "''") + "'";

// 使用真实后台和 PowerShell 入口，只绑定随机本机端口；浏览器预检打开空白页，不连接 AutoDL。
test('源码与在线安装升级：保留资料、旧入口转发、拒绝降级、原停止入口可用', { skip:process.platform !== 'win32', timeout:180000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'autodl-launcher-upgrade-'));
  const oldRoot = path.join(directory,'原安装 [旧版]'), sourceRoot = path.join(directory,'解压源码 [新版]');
  const runtimeDir = path.join(oldRoot,'.runtime');
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PORT:String(port), AUTODL_RUNTIME_DIR:runtimeDir, AUTODL_INSTALL_ROOT:oldRoot };
  const health = async () => (await fetch('http://127.0.0.1:' + port + '/api/health')).json();
  function copyProject(target, version) {
    fs.mkdirSync(target,{recursive:true});
    for(const name of ['src','public','scripts','package.json','package-lock.json','启动抢卡助手.cmd','停止抢卡助手.cmd'])
      fs.cpSync(path.join(ROOT,name),path.join(target,name),{recursive:true});
    const metadata = JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')); metadata.version=version;
    fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(metadata));
    // 复用已经安装的正式依赖文件，测试不依赖 npm 网络或开发依赖。
    for(const name of ['playwright','playwright-core']) fs.cpSync(path.join(ROOT,'node_modules',name),path.join(target,'node_modules',name),{recursive:true});
  }
  const start = root => ps(path.join(root,'scripts/start-local.ps1'),['-NoOpen','-NoPause'],env,directory);
  const stop = () => run(process.execPath,[path.join(oldRoot,'scripts/stop-server.mjs')],env,directory);
  t.after(async()=>{
    try { await stop(); } catch {}
    const target = path.resolve(directory);
    assert.equal(path.dirname(target),path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('autodl-launcher-upgrade-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  copyProject(oldRoot,'1.2.0'); copyProject(sourceRoot,'1.3.0');
  const store = new Store(runtimeDir);
  const task = store.create({provider:'autodl',mode:'boot',instanceId:'fixture-paused',timeoutMinutes:60});
  store.patch(task,{state:'paused'});
  fs.mkdirSync(path.join(runtimeDir,'browser-profile'),{recursive:true});
  fs.writeFileSync(path.join(runtimeDir,'browser-profile','retained-fixture.txt'),'synthetic login files retained');
  let result = await start(oldRoot); assert.equal(result.code,0,result.output);
  const oldHealth = await health(); assert.equal(oldHealth.version,'1.2.0');
  result = await start(sourceRoot); assert.equal(result.code,0,result.output);
  let current = await health(); assert.equal(current.version,'1.3.0'); assert.equal(current.projectRoot,sourceRoot); assert.equal(current.runtimeDir,runtimeDir);
  assert.notEqual(current.pid,oldHealth.pid); assert.equal(current.ready,true);
  assert.equal(new Store(runtimeDir).get(task.id).state,'paused');
  assert.equal(fs.readFileSync(path.join(runtimeDir,'browser-profile','retained-fixture.txt'),'utf8'),'synthetic login files retained');
  result = await start(oldRoot); assert.equal(result.code,0,result.output);
  assert.equal((await health()).pid,current.pid,'旧入口不可重启或降级当前后台');
  result = await stop(); assert.equal(result.code,0,result.output);
  result = await start(oldRoot); assert.equal(result.code,0,result.output);
  assert.equal((await health()).projectRoot,sourceRoot,'停机后原入口仍转发新版');

  // 本地发布 ZIP 只替换安装器测试副本的下载地址，仍执行真实下载、解压、侧装及启停脚本。
  const archiveRoot = path.join(directory,'发布包'), archiveProject = path.join(archiveRoot,'autodl-assistant-v1.3.0');
  copyProject(archiveProject,'1.3.0');
  const zip = path.join(directory,'release.zip');
  result = await run(shell,['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory(${quote(archiveRoot)},${quote(zip)})`],env,directory);
  assert.equal(result.code,0,result.output);
  // 用另一个已安装旧版目录检验 install.ps1 的升级分支，与前面的源码路径彼此独立。
  result = await stop(); assert.equal(result.code,0,result.output);
  const onlineRoot = path.join(directory,'在线安装 [旧版]'); copyProject(onlineRoot,'1.2.0');
  const onlineRuntime = path.join(onlineRoot,'.runtime'), onlineEnv = {...env,AUTODL_RUNTIME_DIR:onlineRuntime,AUTODL_INSTALL_ROOT:onlineRoot};
  new Store(onlineRuntime).save(); fs.writeFileSync(path.join(onlineRuntime,'retained.txt'),'keep');
  const archiveServer = http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/zip'});fs.createReadStream(zip).pipe(res);});
  await new Promise(resolve=>archiveServer.listen(0,'127.0.0.1',resolve));
  const installer = path.join(directory,'install-fixture.ps1');
  const script = fs.readFileSync(path.join(ROOT,'install.ps1'),'utf8').replace(/^\$downloadUrl = .+$/m,`$downloadUrl = 'http://127.0.0.1:${archiveServer.address().port}/release.zip'`);
  fs.writeFileSync(installer,script);
  try {
    result = await ps(installer,['-InstallDir',onlineRoot,'-NoOpen','-NoShortcut'],onlineEnv,directory);
    assert.equal(result.code,0,result.output);
    current = await health(); assert.equal(current.version,'1.3.0'); assert.equal(current.runtimeDir,onlineRuntime);
    assert.ok(current.projectRoot.startsWith(path.join(onlineRoot,'.versions') + path.sep));
    assert.equal(fs.readFileSync(path.join(onlineRuntime,'retained.txt'),'utf8'),'keep');
    result = await ps(path.join(onlineRoot,'scripts/start-local.ps1'),['-NoOpen','-NoPause'],onlineEnv,directory);
    assert.equal(result.code,0,result.output); assert.equal((await health()).pid,current.pid);
  } finally {
    await run(process.execPath,[path.join(onlineRoot,'scripts/stop-server.mjs')],onlineEnv,directory);
    await new Promise(resolve=>archiveServer.close(resolve));
  }
});
