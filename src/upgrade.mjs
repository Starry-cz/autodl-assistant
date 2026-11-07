import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AppError } from './errors.mjs';

// 下载、安装与交接均在独立目录进行，旧代码和登录资料不被覆盖。
export async function runUpgradeCommand(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60000, ...options });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-6000); });
  const [code] = await once(child, 'exit');
  if (code !== 0) { const error = new AppError('UPDATE_PREPARE', '新版环境准备失败：' + output.trim()); error.exitCode = code; throw error; }
}

export async function prepareWebUpgrade({ release, runtimeDir, projectRoot, installationRoot = projectRoot, port, report, assertReady, quiesce, onStop }) {
  if (process.platform !== 'win32') throw new AppError('UPDATE_PLATFORM', '当前一键更新支持 Windows，请使用发布页手动更新');
  if (!release.updateAvailable || !release.downloads?.source) throw new AppError('UPDATE_RELEASE', '请先检查到可下载的正式新版');
  const targetVersion = release.latestVersion;
  const directory = path.join(installationRoot, '.versions', targetVersion + '-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, 'source.zip'), unpacked = path.join(directory, 'unpacked');
  report({ status: 'preparing', phase: 'download', message: '正在下载新版源码，原数据保持不变。', targetVersion });
  const response = await fetch(release.downloads.source, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new AppError('UPDATE_DOWNLOAD', '新版下载失败，HTTP ' + response.status);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await runUpgradeCommand('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(unpacked)}`]);
  const targetRoot = path.join(unpacked, 'autodl-assistant-v' + targetVersion);
  const metadata = JSON.parse(fs.readFileSync(path.join(targetRoot, 'package.json'), 'utf8'));
  if (metadata.name !== 'autodl-gpu-watch' || metadata.version !== targetVersion) throw new AppError('UPDATE_PACKAGE', '下载包的项目或版本不匹配，未切换后台');
  report({ phase: 'dependencies', message: '正在准备新版依赖与浏览器，请保持联网。' });
  // npm 与当前 Node 来自同一个环境，避免切换目录后找不到便携版运行时。
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await runUpgradeCommand(process.execPath, [npm, 'ci', '--omit=dev'], { cwd: targetRoot });
  try { await runUpgradeCommand(process.execPath, [path.join(targetRoot, 'src/browser.mjs')], { cwd: targetRoot }); }
  catch (error) {
    if (error.exitCode !== 2) throw error;
    await runUpgradeCommand(process.execPath, [npm, 'run', 'browser:install'], { cwd: targetRoot });
    await runUpgradeCommand(process.execPath, [path.join(targetRoot, 'src/browser.mjs')], { cwd: targetRoot });
  }
  await quiesce(); assertReady();
  const configPath = path.join(directory, 'handoff.json');
  fs.writeFileSync(configPath, JSON.stringify({ oldPid: process.pid, node: process.execPath, oldRoot: projectRoot, targetRoot, installationRoot, runtimeDir, port, targetVersion }));
  report({ status: 'switching', phase: 'restart', message: '新版已准备好，正在保存数据并切换后台。' });
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/upgrade-handoff.mjs'), configPath], { detached: true, windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn'); child.unref();
  onStop();
}

export function assertUpgradeTasksReady(tasks, busy = false) {
  const pending = tasks.some(task => ['preparing', 'submitting', 'verifying', 'reconciling'].includes(task.state)
    || task.operation && !['completed', 'expired'].includes(task.state));
  if (pending) throw new AppError('UPDATE_TASK_PENDING', '存在提交或结果核对中的任务，请处理完成后再更新；不会中断或重复提交。', { status: 409 });
  if (busy) throw new AppError('BUSY', '当前正在读取页面，请稍后再更新。', { status: 409 });
}
