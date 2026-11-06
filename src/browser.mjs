import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.mjs';

// 启动器与账号浏览器共用同一选择顺序，避免预检通过后却启动另一种浏览器。
export async function resolveBrowserLaunchOptions(chromium, { env = process.env, platform = process.platform, access = fs.access } = {}) {
  const channel = env.AUTODL_BROWSER_CHANNEL?.trim();
  if (channel) return { channel };
  const exists = async file => {
    try { await access(file); return true; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  };
  if (await exists(chromium.executablePath())) return { channel: 'chromium' };
  if (platform === 'win32') {
    // Windows 的系统级及当前用户安装位置；直接使用发现的路径，不假设 Playwright 通道能定位同一安装。
    const roots = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean))];
    for (const relative of [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']]) {
      for (const root of roots) {
        const executablePath = path.win32.join(root, ...relative);
        if (await exists(executablePath)) return { executablePath };
      }
    }
  }
  throw new AppError('BROWSER_MISSING', '未找到可用的 Edge、Chrome 或 Chromium。请在项目目录执行 npm.cmd run browser:install 后重试。');
}

// 独立预检只打开临时空白浏览器，不使用 AutoDL 登录资料；退出码 2 供启动器触发首次安装。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { chromium } = await import('playwright');
    const options = await resolveBrowserLaunchOptions(chromium);
    const browser = await chromium.launch({ ...options, headless: true, chromiumSandbox: true });
    await browser.close();
    console.log('浏览器检查通过。');
  } catch (error) {
    const explicit = process.env.AUTODL_BROWSER_CHANNEL?.trim();
    console.error(error.code === 'BROWSER_MISSING' ? error.message
      : explicit ? '指定的浏览器通道无法启动：' + explicit + '。请检查 AUTODL_BROWSER_CHANNEL 和对应浏览器的安装。'
        : '浏览器检查失败，请确认浏览器可以运行；也可在项目目录执行 npm.cmd run browser:install 后重试。');
    process.exitCode = error.code === 'BROWSER_MISSING' ? 2 : 1;
  }
}
