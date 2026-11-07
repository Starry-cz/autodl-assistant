import fs from 'node:fs';
import path from 'node:path';
import { performDesktopHandoff } from './upgrade.mjs';

// 此进程由旧桌面程序启动，旧窗口退出后继续完成交接；计划文件不包含任何凭据。
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
try { await performDesktopHandoff(plan); }
catch (error) {
  fs.appendFileSync(path.join(plan.userData, 'desktop.log'), `${new Date().toISOString()} [update] ${error.message}\n`);
  process.exitCode = 1;
}
