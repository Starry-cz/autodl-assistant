import fs from 'node:fs';

function preferredPort(portFile) {
  let content;
  try { content = fs.readFileSync(portFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const value = JSON.parse(content);
  if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535 || value.port === 8787) {
    throw new Error(`桌面端口记录无效：${portFile}。请删除此端口记录后重新启动，不需要删除账号资料。`);
  }
  return value.port;
}

function listenOnLoopback(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', failed);
      server.off('listening', listening);
    };
    const failed = error => { cleanup(); reject(error); };
    const listening = () => { cleanup(); resolve(server.address().port); };
    server.once('error', failed);
    server.once('listening', listening);
    try { server.listen(port, '127.0.0.1'); }
    catch (error) { failed(error); }
  });
}

// 复用同一数据目录的来源，保留页面 localStorage；首次由系统分配端口，不占用网页版 8787。
export async function listenDesktop(server, { portFile, onPortChanged = () => {} }) {
  const preferred = preferredPort(portFile);
  let port;
  try { port = await listenOnLoopback(server, preferred); }
  catch (error) {
    // 只有已记录的端口被其他进程占用才重新分配；权限、参数及其他错误保留给启动错误提示。
    if (!preferred || error.code !== 'EADDRINUSE') throw error;
    port = await listenOnLoopback(server, 0);
  }
  if (port !== preferred) fs.writeFileSync(portFile, JSON.stringify({ port }) + '\n', 'utf8');
  if (preferred && port !== preferred) onPortChanged({ previous: preferred, port });
  return port;
}
