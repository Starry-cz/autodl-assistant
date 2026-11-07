import fs from 'node:fs';
import path from 'node:path';
import { inspectRunningBackend, stopRunningBackend } from '../src/server.mjs';
import { assertUpgradeTasksReady } from '../src/upgrade.mjs';

// 启动入口已确认新版环境可用，再核对原数据目录并请求旧后台正常退出。
const port = Number(process.env.PORT || 8787), base = 'http://127.0.0.1:' + port;
const health = await (await fetch(base + '/api/health')).json();
const runtime = path.resolve(process.env.AUTODL_RUNTIME_DIR);
if (health.app !== 'autodl-assistant' || path.resolve(health.runtimeDir).toLowerCase() !== runtime.toLowerCase()) throw Error('后台数据目录不符，未停止任何进程');
const state = JSON.parse(fs.readFileSync(path.join(runtime, 'state.json'), 'utf8').replace(/^\uFEFF/, ''));
assertUpgradeTasksReady(state.tasks || []);
if (!health.ready && (state.tasks || []).some(task => ['queued','watching'].includes(task.state))) throw Error('此旧版没有原子更新交接，请先暂停监测任务后重新启动；任务和登录资料会保留');
const info = await inspectRunningBackend(port);
if (!info.canStop) throw Error('旧后台不支持正常退出，请先从原目录停止后重试');
const stop = info.stop; info.stop = () => stop({ forUpdate: true });
const stopped = await stopRunningBackend(info, {pid: health.pid, port, lockPath: path.join(runtime, 'server.lock')});
if (!stopped) process.exitCode = 1;
