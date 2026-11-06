import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../src/server.mjs';

// 只在随机本地端口模拟后台，用独立临时运行目录执行停止脚本；不访问真实 8787 或账号资料。
async function syntheticServer(t, { health: override = {}, status = 200, body } = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-stop-installation-'));
  const requests = [], token = 'abc123';
  const health = { ok: true, app: 'autodl-assistant', version: 'synthetic', pid: process.pid,
    projectRoot: ROOT, runtimeDir, codeChanged: false, ...override };
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/health') {
      res.writeHead(status, { 'Content-Type': body === undefined ? 'application/json' : 'text/plain' });
      res.end(body === undefined ? JSON.stringify(health) : body); return;
    }
    if (req.url === '/') { res.end('<meta name="local-token" content="' + token + '">'); return; }
    assert.equal(req.headers['x-local-token'], token);
    if (req.url === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tasks: [], server: { codeChanged: false, canStop: true } })); return;
    }
    if (req.url === '/api/server/stop') {
      assert.equal(req.method, 'POST');
      res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      server.close(); return;
    }
    assert.fail('unexpected synthetic route: ' + req.url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(runtimeDir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('autodl-stop-installation-'))
      throw Error('invalid isolated cleanup target');
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { server, port, runtimeDir, health, requests };
}

function runStop(t, port, runtimeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'stop-server.mjs')], {
      // 特意从项目外调用，用于验证相对 AUTODL_RUNTIME_DIR 不会随 cwd 改变归属。
      cwd: os.tmpdir(), env: { ...process.env, PORT: String(port), AUTODL_RUNTIME_DIR: runtimeDir },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  });
}

test('停止当前安装的后台：核对归属后才读取令牌、状态并发送停止', { timeout: 15000 }, async t => {
  const f = await syntheticServer(t), result = await runStop(t, f.port, f.runtimeDir);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /后台已停止/);
  assert.deepEqual(f.requests, ['/api/health', '/', '/api/state', '/api/server/stop']);
});

test('相对运行目录按项目根解析，Windows目录大小写和分隔符不影响归属', { timeout: 15000 }, async t => {
  const f = await syntheticServer(t);
  if (process.platform === 'win32') {
    f.health.projectRoot = ROOT.toUpperCase().replaceAll('\\', '/') + '/';
    f.health.runtimeDir = f.runtimeDir.toUpperCase().replaceAll('\\', '/') + '/';
  }
  const result = await runStop(t, f.port, path.relative(ROOT, f.runtimeDir));
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /后台已停止/);
  assert.equal(f.requests.filter(route => route === '/api/server/stop').length, 1);
});

for (const [name, health] of [
  ['其他项目目录', { projectRoot: path.join(ROOT, 'another-copy') }],
  ['其他运行目录', { runtimeDir: path.join(os.tmpdir(), 'synthetic-other-runtime') }],
  ['其他服务', { app: 'synthetic-other-app' }],
  ['旧服务缺少归属信息', { projectRoot: undefined, runtimeDir: undefined }],
]) test('拒绝停止' + name + '，不读取其令牌或状态', { timeout: 15000 }, async t => {
  const f = await syntheticServer(t, { health }), result = await runStop(t, f.port, f.runtimeDir);
  assert.equal(result.code, 1); assert.match(result.stderr, /其他项目目录.*未读取账号状态.*未停止/);
  assert.deepEqual(f.requests, ['/api/health']);
});

test('端口上的非项目HTTP响应不当作后台，也不读取其首页', { timeout: 15000 }, async t => {
  const f = await syntheticServer(t, { status: 404, body: 'synthetic service' });
  const result = await runStop(t, f.port, f.runtimeDir);
  assert.equal(result.code, 1); assert.deepEqual(f.requests, ['/api/health']);
});

test('指定端口没有服务时仍正常退出，不创建或删除运行锁', { timeout: 15000 }, async t => {
  const f = await syntheticServer(t);
  await new Promise(resolve => f.server.close(resolve));
  const result = await runStop(t, f.port, f.runtimeDir);
  assert.equal(result.code, 0); assert.match(result.stdout, /没有运行中的监测台/);
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []); assert.deepEqual(f.requests, []);
});
