import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeDir = process.env.AUTODL_RUNTIME_DIR || path.join(projectRoot, '.runtime');
const opened = [];
try {
  // 文件描述符直接传给后台，路径按字面读取；启动器退出后日志仍由后台独立持有。
  const output = fs.openSync(path.join(runtimeDir, 'server.log'), 'w');
  opened.push(output);
  const error = fs.openSync(path.join(runtimeDir, 'server-error.log'), 'w');
  opened.push(error);
  const child = spawn(process.execPath, [path.join(projectRoot, 'src/server.mjs')], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', output, error],
  });
  await once(child, 'spawn');
  child.unref();
  // 标准输出仅返回 PID，供 PowerShell 等待健康检查时判断后台是否提前退出。
  process.stdout.write(String(child.pid));
} finally {
  for (const descriptor of opened) fs.closeSync(descriptor);
}
