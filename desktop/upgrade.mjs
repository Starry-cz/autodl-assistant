import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions } from '../src/updates.mjs';

const execute = promisify(execFile);
const pointerPath = userData => path.join(userData, 'active-desktop.json');
const resultPath = userData => path.join(userData, 'desktop-upgrade-result.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeResult(plan, status, message = '') {
  const result = { status, version: plan.version, targetVersion: plan.version, phase: 'restart', message, error: status === 'error' ? message : null, at: Date.now() };
  fs.writeFileSync(resultPath(plan.userData), JSON.stringify(result));
  // 公共健康接口读取同一结果，外部浏览器连接桌面端口时也能结束等待并显示错误。
  fs.writeFileSync(path.join(plan.runtimeDir, 'upgrade-status.json'), JSON.stringify(result));
}

// 安装版和便携版均使用完整桌面 ZIP，程序与登录/任务目录始终分离。
export async function prepareDesktopUpdate({ release, userData, runtimeDir = path.join(userData, 'runtime'), report, fetchImpl = fetch, run = execute, platform = process.platform, arch = process.arch }) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('自动桌面更新仅支持 Windows x64');
  const version = release.latestVersion;
  const expected = `https://github.com/Starry-cz/autodl-assistant/releases/download/v${version}/autodl-assistant-desktop-${version}-win-x64.zip`;
  if (compareVersions(version, release.currentVersion) !== 1 || release.downloads?.desktopPortable !== expected) throw new Error('未找到可安装的正式桌面新版');
  const updatesDir = path.join(userData, 'updates');
  fs.mkdirSync(updatesDir, { recursive: true });
  writeResult({ userData, runtimeDir, version }, 'preparing');
  // 独立目录避免失败下载覆盖正在运行的版本，也允许网络恢复后重新尝试。
  const stage = fs.mkdtempSync(path.join(updatesDir, 'desktop-' + version + '-'));
  const archive = path.join(stage, 'desktop.zip'), target = path.join(stage, 'app');
  report({ status: 'preparing', phase: 'download', message: '正在下载完整桌面更新包…', targetVersion: version });
  const response = await fetchImpl(expected, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error('桌面更新包下载失败：HTTP ' + response.status);
  const size = Number(response.headers.get('content-length'));
  let received = 0, lastPercent = -1;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    const percent = size > 0 ? Math.min(100, Math.floor(received / size * 20) * 5) : null;
    if (percent !== null && percent !== lastPercent) {
      lastPercent = percent;
      report({ status: 'preparing', phase: 'download', message: `正在下载桌面更新包 ${percent}%`, targetVersion: version });
    }
    callback(null, chunk);
  } }), fs.createWriteStream(archive, { flags: 'wx' }));
  report({ status: 'preparing', phase: 'prepare', message: '正在解压并检查新版运行环境…', targetVersion: version });
  // 仅对解压子进程放开脚本策略，使 Windows 默认 Restricted 下也能加载内置 Archive 模块。
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:AUTODL_UPDATE_ARCHIVE -DestinationPath $env:AUTODL_UPDATE_TARGET"], {
    windowsHide: true, env: { ...process.env, AUTODL_UPDATE_ARCHIVE: archive, AUTODL_UPDATE_TARGET: target }, timeout: 300000,
  });
  const appRoot = path.join(target, 'resources', 'app'), executable = path.join(target, 'AutoDL Assistant.exe');
  const info = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  if (info.name !== 'autodl-gpu-watch' || info.version !== version || !fs.existsSync(executable)) throw new Error('桌面更新包结构或版本不匹配');
  // 用新版自带 Node 加载后端和 Playwright，确认环境完整；不会创建服务、读取账号或运行任务。
  await run(executable, ['--input-type=module', '-e', "import {pathToFileURL} from 'node:url'; import fs from 'node:fs'; await import(pathToFileURL(process.cwd()+'/src/server.mjs')); const {chromium}=await import('playwright'); if(!fs.existsSync(chromium.executablePath()))throw Error('内置浏览器缺失');"], {
    cwd: appRoot, windowsHide: true, timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(target, 'resources', 'browsers') },
  });
  // 已解压并通过环境检查，原压缩包不再参与交接；保留旧程序及完整新版目录。
  fs.unlinkSync(archive);
  return { version, executable, stage };
}

// 旧快捷方式仍启动原 EXE；入口只转发到已通过健康检查且版本更高的缓存程序。
export function activeDesktopTarget({ userData, currentVersion, executable }) {
  if (!fs.existsSync(pointerPath(userData))) return null;
  const target = JSON.parse(fs.readFileSync(pointerPath(userData), 'utf8'));
  if (compareVersions(target.version, currentVersion) !== 1) return null;
  const relative = path.relative(path.join(userData, 'updates'), target.executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(target.executable)) throw new Error('已更新的桌面程序不完整，请重新下载完整桌面包；账号数据仍保留');
  return path.resolve(target.executable) === path.resolve(executable) ? null : target.executable;
}

export async function launchDesktop(executable, userData, spawnImpl = spawn) {
  const env = { ...process.env, AUTODL_DESKTOP_DATA_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnImpl(executable, [], { cwd: path.dirname(executable), env, detached: true, windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn');
  child.unref();
  return child;
}

export async function startDesktopHandoff({ prepared, userData, runtimeDir, executable, pid = process.pid, spawnImpl = spawn }) {
  const planFile = path.join(prepared.stage, 'handoff.json');
  fs.writeFileSync(planFile, JSON.stringify({ ...prepared, userData, runtimeDir, previousExecutable: executable, previousPid: pid }));
  const child = spawnImpl(executable, [fileURLToPath(new URL('./handoff.mjs', import.meta.url)), planFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore',
  });
  await once(child, 'spawn');
  child.unref();
}

export async function performDesktopHandoff(plan, { alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } },
  launch = launchDesktop, fetchImpl = fetch, sleep = delay, attempts = 360 } = {}) {
  let child;
  try {
    // 等旧进程正常退出，不强杀；只有运行锁和浏览器资料释放后才启动新版。
    for (let attempt = 0; alive(plan.previousPid); attempt++) {
      if (attempt >= attempts) throw new Error('旧桌面后台仍未退出，更新尚未切换');
      await sleep(500);
    }
    child = await launch(plan.executable, plan.userData);
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (child.exitCode !== null && child.exitCode !== undefined) throw new Error('新版桌面程序启动失败');
      const portFile = path.join(plan.userData, 'local-port.json');
      if (fs.existsSync(portFile)) {
        const { port } = JSON.parse(fs.readFileSync(portFile, 'utf8'));
        try {
          const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
          const health = await response.json();
          if (response.ok && health.app === 'autodl-assistant' && health.ready === true && health.version === plan.version
            && path.resolve(health.runtimeDir) === path.resolve(plan.runtimeDir)
            && path.resolve(health.projectRoot) === path.resolve(path.dirname(plan.executable), 'resources', 'app')) { ready = true; break; }
        } catch { /* 新进程尚未开始监听时继续等候同一进程。 */ }
      }
      await sleep(500);
    }
    if (!ready) throw new Error('新版桌面程序未能完成启动，请查看 desktop.log');
    fs.writeFileSync(pointerPath(plan.userData), JSON.stringify({ version: plan.version, executable: plan.executable }));
    writeResult(plan, 'complete', '更新完成，已启动 v' + plan.version + '。');
  } catch (error) {
    writeResult(plan, 'error', error.message);
    // 仅在新版已退出且旧进程也结束时重开旧版，避免两个程序同时访问同一份任务和浏览器资料。
    if (!alive(plan.previousPid) && (!child || child.exitCode !== null && child.exitCode !== undefined)) await launch(plan.previousExecutable, plan.userData);
    throw error;
  }
}

export function desktopUpgradeResult(userData) {
  const file = resultPath(userData);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
