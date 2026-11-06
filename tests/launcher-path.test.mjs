import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Windows 启动器支持中文空格与方括号目录，并把日志写到字面路径', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  // 只替换浏览器和后台为无账号的本地样例，实际执行原启动器与 Node 环境选择逻辑。
  const area = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-launcher-path-'));
  const project = path.join(area, '源码 [测试] & 中文');
  const runtime = path.join(project, '状态 [资料]');
  for (const folder of ['scripts', 'src', 'node_modules/playwright', 'node_modules/playwright-core']) fs.mkdirSync(path.join(project, folder), { recursive: true });
  for (const name of ['start-local.ps1', 'node-runtime.ps1', 'start-background.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(project, 'scripts', name));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ version: 'synthetic' }));
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/playwright': { version: 'synthetic' }, 'node_modules/playwright-core': { version: 'synthetic' } } }));
  for (const name of ['playwright', 'playwright-core']) {
    fs.writeFileSync(path.join(project, 'node_modules', name, 'package.json'), JSON.stringify({ version: 'synthetic', main: 'index.js' }));
    fs.writeFileSync(path.join(project, 'node_modules', name, 'index.js'), 'module.exports = {};');
  }
  fs.writeFileSync(path.join(project, 'src/browser.mjs'), '// 隔离测试不启动浏览器或访问 AutoDL。\n');
  fs.writeFileSync(path.join(project, 'src/server.mjs'), `
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDir=process.env.AUTODL_RUNTIME_DIR;
const server=http.createServer((req,res)=>{
  if(req.url==='/stop'){res.end('stopping');server.close();return;}
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify({ok:true,app:'autodl-assistant',version:'synthetic',codeChanged:false,projectRoot,runtimeDir,pid:process.pid}));
});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>{console.log('synthetic stdout');console.error('synthetic stderr');});
`);
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  assert.notEqual(port, 8787);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    try {
      const health = await (await fetch(base + '/api/health')).json();
      if (health.projectRoot === project) {
        await fetch(base + '/stop');
        // HTTP 响应会早于进程关闭日志句柄；等待样例后台退出后再删除临时目录。
        for (let attempt = 0; attempt < 30; attempt += 1) {
          try { process.kill(health.pid, 0); } catch { break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch {}
    const target = path.resolve(area);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('autodl-launcher-path-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const launcher = path.join(project, 'scripts/start-local.ps1').replaceAll("'", "''");
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & '${launcher}' -NoOpen -NoPause`;
  const env = { ...process.env, PORT: String(port), AUTODL_RUNTIME_DIR: '状态 [资料]' };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env.Path = [path.dirname(process.execPath), path.dirname(ps), path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: area, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    // Windows 后台进程可能继承管道句柄；以启动器退出为完成点，不等待后台退出才关闭管道。
    child.once('exit', code => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.projectRoot, project);
  assert.equal(health.runtimeDir, runtime);
  assert.match(fs.readFileSync(path.join(runtime, 'server.log'), 'utf8'), /synthetic stdout/);
  assert.match(fs.readFileSync(path.join(runtime, 'server-error.log'), 'utf8'), /synthetic stderr/);
});
