// 正常停止本机监测台后台：请求后台自行停止（等待当前页面操作结束、保存状态、关闭专用浏览器），
// 再等待端口与运行锁释放。不强制结束进程，不删除 .runtime 中的任何文件，不影响云端实例。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, inspectRunningBackend, stopRunningBackend, lockReleased } from '../src/server.mjs';
const port = Number(process.env.PORT || 8787), base = 'http://127.0.0.1:' + port;
const lock = path.join(process.env.AUTODL_RUNTIME_DIR || path.join(ROOT, '.runtime'), 'server.lock');
const alive = async () => { try { return (await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
if (!(await alive())) { console.log('端口 ' + port + ' 上没有运行中的监测台' + (fs.existsSync(lock) ? '；运行锁仍在，下次启动会核对其进程是否存在' : '')); process.exit(0); }
const info = await inspectRunningBackend(port);
if (info.kind === 'unreachable') { console.error('无法从本机页面读取访问令牌或状态，未停止后台'); process.exit(1); }
if (info.kind === 'legacy') {
  console.error('当前运行的是不支持此命令的旧版后台。请在其启动窗口按 Ctrl+C；没有窗口时，确认控制台中没有“提交中/验证实例与数据/等待绑定核对”的任务后，在任务管理器按 PID 结束该 node.exe（PID 可用 Get-NetTCPConnection -LocalPort ' + port + ' -State Listen 查询）。');
  process.exit(1);
}
let pid = null;
try { pid = Number(fs.readFileSync(lock, 'utf8')) || null; } catch {}
// 端口不再响应且运行锁已释放才算停止；读不到运行锁时只看端口。
const stopped = await stopRunningBackend(info, { pid, port, lockPath: lock, name: '后台',
  released: async () => !(await alive()) && lockReleased(lock, pid) });
if (stopped) console.log('后台已停止。可运行 npm.cmd start 重新启动。');
process.exit(stopped ? 0 : 1);

