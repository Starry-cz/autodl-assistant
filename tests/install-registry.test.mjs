import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const powershell = path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { env, cwd, windowsHide: true });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
}

test('源码登记目录可承接默认在线安装，但不覆盖其他文件', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const area = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-install-registry-'));
  const localAppData = path.join(area, 'LocalAppData'), target = path.join(localAppData, 'AutoDL-Assistant');
  const source = path.join(area, '源码原目录'), bundle = path.join(area, 'bundle');
  const version = '99.0.0', packageRoot = path.join(bundle, 'autodl-assistant-v' + version);
  for (const directory of [target, source, path.join(packageRoot, 'scripts')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'autodl-gpu-watch', version: '1.0.0' }));
  const registry = JSON.stringify({ projectRoot: source, runtimeDir: path.join(source, '.runtime'), installationRoot: source, version: '1.0.0' });
  fs.writeFileSync(path.join(target, 'web-install.json'), registry);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'autodl-gpu-watch', version }));
  // 仅隔离安装器：启动阶段用落盘标记代替服务，绝不使用真实端口、浏览器或账号。
  fs.writeFileSync(path.join(packageRoot, 'scripts/start-local.ps1'), '\uFEFFparam([switch]$NoOpen,[switch]$NoPause)\r\n[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) "started.txt"), "ok")\r\n');
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  delete env.AUTODL_INSTALL_ROOT; delete env.AUTODL_RUNTIME_DIR;
  const archive = path.join(area, 'source.zip');
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    const cleanup = path.resolve(area);
    assert.equal(path.dirname(cleanup), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cleanup).startsWith('autodl-install-registry-'));
    fs.rmSync(cleanup, { recursive: true, force: true });
  });
  let result = await run(['-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory(${quote(bundle)},${quote(archive)})`], env, area);
  assert.equal(result.code, 0, result.output);
  server = http.createServer((_request, response) => fs.createReadStream(archive).pipe(response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const installer = path.join(area, 'install.ps1');
  fs.writeFileSync(installer, fs.readFileSync(path.join(root, 'install.ps1'), 'utf8')
    .replace(/^\$releaseVersion = .+$/m, `$releaseVersion = '${version}'`)
    .replace(/^\$downloadUrl = .+$/m, `$downloadUrl = 'http://127.0.0.1:${server.address().port}/source.zip'`));

  // 同一个专用目录含有其他文件时仍应停止，而不是将它当作空目录。
  fs.writeFileSync(path.join(target, 'unrelated.txt'), 'keep');
  result = await run(['-File', installer, '-NoOpen', '-NoShortcut'], env, area);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(target, 'started.txt')), false);
  assert.equal(fs.readFileSync(path.join(target, 'unrelated.txt'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(target, 'unrelated.txt'));

  result = await run(['-File', installer, '-NoOpen', '-NoShortcut'], env, area);
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(path.join(target, 'started.txt'), 'utf8'), 'ok');
  assert.equal(fs.readFileSync(path.join(target, 'web-install.json'), 'utf8'), registry, '保留源安装的数据目录登记供启动器承接');
});
