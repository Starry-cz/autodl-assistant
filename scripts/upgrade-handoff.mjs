import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 独立交接进程不拥有任务引擎；旧后台退出、释放运行锁后才启动新版。
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const statusPath = path.join(config.runtimeDir, 'upgrade-status.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function start(root) {
  const out = fs.openSync(path.join(config.runtimeDir, 'server.log'), 'a'), err = fs.openSync(path.join(config.runtimeDir, 'server-error.log'), 'a');
  try {
    const child = spawn(config.node, [path.join(root, 'src/server.mjs')], { cwd: root, detached: true, windowsHide: true,
      env: { ...process.env, PORT: String(config.port), AUTODL_RUNTIME_DIR: config.runtimeDir, AUTODL_INSTALL_ROOT: config.installationRoot, AUTODL_RESTORE_SESSION: '1' },
      stdio: ['ignore', out, err] });
    child.unref(); return child;
  } finally { fs.closeSync(out); fs.closeSync(err); }
}
try {
  for (let count = 0; alive(config.oldPid); count++) {
    if (count >= 120) throw Error('旧后台未完成退出，未启动第二个后台。');
    await sleep(1000);
  }
  const child = start(config.targetRoot);
  let error = null;
  child.on('error', value => { error = value; });
  let healthy = false;
  for (let count = 0; count < 90; count++) {
    if (error || child.exitCode !== null) break;
    try {
      const health = await (await fetch('http://127.0.0.1:' + config.port + '/api/health', { signal: AbortSignal.timeout(1000) })).json();
      if (health.app === 'autodl-assistant' && health.version === config.targetVersion && health.projectRoot === config.targetRoot && health.runtimeDir === config.runtimeDir && health.ready) { healthy = true; break; }
    } catch {}
    await sleep(1000);
  }
  if (!healthy) {
    // 只有新版已经退出才恢复旧后台；绝不同时启动两个共用数据的进程。
    if (error || child.exitCode !== null || child.pid && !alive(child.pid)) start(config.oldRoot);
    throw Error('新版未通过启动检查，原文件和账号数据仍保留。请查看 server-error.log 后重试。');
  }
  const pointer = path.join(config.installationRoot, '.autodl-current.json');
  const record = JSON.stringify({ projectRoot: config.targetRoot, runtimeDir: config.runtimeDir, version: config.targetVersion, installationRoot: config.installationRoot });
  fs.writeFileSync(pointer + '.tmp', record);
  fs.renameSync(pointer + '.tmp', pointer);
  fs.writeFileSync(path.join(config.targetRoot, '.autodl-current.json'), record);
  if (Number(config.port) === 8787 && process.env.LOCALAPPDATA) {
    const registry = path.join(process.env.LOCALAPPDATA, 'AutoDL-Assistant'); fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(path.join(registry, 'web-install.json'), record);
  }
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'complete', phase: 'ready', message: '已更新到 v' + config.targetVersion, targetVersion: config.targetVersion }));
} catch (error) {
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'error', phase: 'restart', message: error.message, error: error.message, targetVersion: config.targetVersion }));
  process.exitCode = 1;
}
