import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function desktopBrowserPreparation({ projectRoot = PROJECT_ROOT, platform = process.platform,
  arch = process.arch, env = process.env, execPath = process.execPath } = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('当前桌面安装包仅支持在 Windows x64 上构建。');
  const root = path.resolve(projectRoot);
  const require = createRequire(path.join(root, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  const browserDirectory = path.join(root, '.cache', 'desktop-browsers');
  return {
    command: execPath,
    installArgs: [cli, 'install', 'chromium', '--no-shell'],
    browserDirectory,
    options: { cwd: root, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory }, stdio: 'inherit', windowsHide: true },
  };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`桌面浏览器准备失败（${signal || '退出码 ' + code}），请检查上方下载或运行错误。`));
    });
  });
}

export async function prepareDesktop({ run = runCommand, log = console.log, ...options } = {}) {
  const preparation = desktopBrowserPreparation(options);
  log('正在准备桌面版内置浏览器（首次构建需要下载）……');
  // 使用当前锁定的 Playwright CLI 获取匹配版本；仅在构建时下载，不复制登录资料。
  await run(preparation.command, preparation.installArgs, preparation.options);
  // 在独立 Node 进程中加载 Playwright，确保浏览器路径按刚设置的环境变量初始化。
  await run(preparation.command, ['--input-type=module', '-e',
    "import fs from 'node:fs'; import { chromium } from 'playwright'; fs.accessSync(chromium.executablePath()); console.log('内置 Chromium 已就绪。');"], preparation.options);
  log('桌面版浏览器准备完成：' + preparation.browserDirectory);
  return preparation.browserDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareDesktop(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
