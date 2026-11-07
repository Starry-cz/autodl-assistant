import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  assert.fail('隔离交接测试等待超时');
}

test('网页版实际进程交接等待旧后台退出及新版就绪，再激活原入口，资料原地保留', { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-web-handoff-'));
  const oldRoot = path.join(root, 'old'), targetRoot = path.join(root, 'new'), runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDir);
  const stateFile = path.join(runtimeDir, 'state.json'), loginFile = path.join(runtimeDir, 'synthetic-login.json');
  const state = '{"tasks":[{"id":"waiting-fixture","state":"watching"}],"owner":"synthetic"}';
  fs.writeFileSync(stateFile, state); fs.writeFileSync(loginFile, '{"session":"synthetic-only"}');
  // 只启动本测试自己的假后台：监听随机端口，不导入浏览器、任务引擎或任何真实账号。
  const source = `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const root=process.cwd(), runtime=process.env.AUTODL_RUNTIME_DIR;
const metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const newer=metadata.version==='99.0.0';
const server=http.createServer((req,res)=>{
  if(req.url==='/stop' && req.method==='POST'){res.end('ok');setImmediate(()=>{server.close(()=>process.exit(0));server.closeIdleConnections();});return;}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({app:'autodl-assistant',version:metadata.version,pid:process.pid,projectRoot:root,runtimeDir:runtime,ready:!newer||fs.existsSync(path.join(runtime,'allow-ready'))}));
});
server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>{
  const info={pid:process.pid,port:server.address().port};
  if(newer)fs.writeFileSync(path.join(runtime,'new-started.json'),JSON.stringify(info));
  console.log(JSON.stringify(info));
});`;
  for (const [directory, version] of [[oldRoot, '1.0.0'], [targetRoot, '99.0.0']]) {
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', version }));
    fs.writeFileSync(path.join(directory, 'src/server.mjs'), source);
  }
  const old = spawn(process.execPath, [path.join(oldRoot, 'src/server.mjs')], { cwd: oldRoot, windowsHide: true,
    env: { ...process.env, PORT: '0', AUTODL_RUNTIME_DIR: runtimeDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let helper, base;
  const oldExit = once(old, 'exit');
  t.after(async () => {
    // 清理只针对上述假后台和自身临时目录，不碰用户后台端口及数据。
    if (base) await fetch(base + '/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
    await until(() => old.exitCode !== null, 3000).catch(() => old.kill());
    if (helper && helper.exitCode === null) helper.kill();
    const marker = path.join(runtimeDir, 'new-started.json');
    if (fs.existsSync(marker)) {
      const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
      await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 3000);
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('autodl-web-handoff-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [data] = await once(old.stdout, 'data');
  const { port } = JSON.parse(data.toString().trim());
  assert.notEqual(port, 8787);
  base = 'http://127.0.0.1:' + port;
  const config = path.join(root, 'handoff.json');
  fs.writeFileSync(config, JSON.stringify({ oldPid: old.pid, node: process.execPath, oldRoot, targetRoot,
    installationRoot: oldRoot, runtimeDir, port, targetVersion: '99.0.0' }));
  helper = spawn(process.execPath, [fileURLToPath(new URL('../scripts/upgrade-handoff.mjs', import.meta.url)), config], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  const helperExit = once(helper, 'exit');
  await delay(250);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'new-started.json')), false, '旧PID仍活着时不能启动新后台');
  await fetch(base + '/stop', { method: 'POST' }); await oldExit;
  await until(() => fs.existsSync(path.join(runtimeDir, 'new-started.json')));
  const pointer = path.join(oldRoot, '.autodl-current.json');
  assert.equal(fs.existsSync(pointer), false, '新后台仍在恢复连接时不能激活入口');
  const preparing = await (await fetch(base + '/api/health')).json();
  assert.equal(preparing.version, '99.0.0'); assert.equal(preparing.ready, false);
  fs.writeFileSync(path.join(runtimeDir, 'allow-ready'), 'ready');
  const [code] = await helperExit;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(pointer, 'utf8')), { projectRoot: targetRoot, runtimeDir, version: '99.0.0', installationRoot: oldRoot });
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'upgrade-status.json'), 'utf8')).status, 'complete');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
  assert.equal(fs.readFileSync(loginFile, 'utf8'), '{"session":"synthetic-only"}');
});
