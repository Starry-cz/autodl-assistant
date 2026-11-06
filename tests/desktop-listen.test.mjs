import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenDesktop } from '../desktop/listen.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-desktop-listen-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('autodl-desktop-listen-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    file: path.join(dir, 'local-port.json'),
    server() { const server = http.createServer((_req, res) => res.end('desktop test')); servers.push(server); return server; },
  };
}

test('首启保存实际端口，重启同一桌面数据目录复用原端口', async t => {
  const f = fixture(t), first = f.server();
  const port = await listenDesktop(first, { portFile: f.file });
  assert.ok(Number.isInteger(port) && port > 0);
  assert.notEqual(port, 8787);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { port });
  await new Promise(resolve => first.close(resolve));
  const second = f.server();
  assert.equal(await listenDesktop(second, { portFile: f.file }), port);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'desktop test');
});

test('原端口被占用时重新分配并保存新端口，原服务保持运行', async t => {
  const f = fixture(t), occupied = f.server();
  const previous = await listenDesktop(occupied, { portFile: f.file });
  const replacement = f.server(), changes = [], initialListening = replacement.listeners('listening');
  const port = await listenDesktop(replacement, { portFile: f.file, onPortChanged: change => changes.push(change) });
  assert.notEqual(port, previous);
  assert.deepEqual(changes, [{ previous, port }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { port });
  assert.equal(await (await fetch(`http://127.0.0.1:${previous}`)).text(), 'desktop test');
  assert.equal(replacement.listenerCount('error'), 0);
  assert.deepEqual(replacement.listeners('listening'), initialListening);
});

test('两个独立数据目录各自保存端口，不复用另一工作台的服务', async t => {
  const first = fixture(t), second = fixture(t);
  const firstPort = await listenDesktop(first.server(), { portFile: first.file });
  const secondPort = await listenDesktop(second.server(), { portFile: second.file });
  assert.notEqual(firstPort, secondPort);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.file, 'utf8')), { port: firstPort });
  assert.deepEqual(JSON.parse(fs.readFileSync(second.file, 'utf8')), { port: secondPort });
});

test('非法端口记录不监听、不覆盖，网页版端口也不接管', async t => {
  const f = fixture(t);
  for (const port of [-1, 0, 65536, '43210', 8787]) {
    const content = JSON.stringify({ port });
    fs.writeFileSync(f.file, content);
    const server = f.server();
    await assert.rejects(listenDesktop(server, { portFile: f.file }), /桌面端口记录无效/);
    assert.equal(server.listening, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
  }
  fs.writeFileSync(f.file, '{broken json');
  await assert.rejects(listenDesktop(f.server(), { portFile: f.file }), SyntaxError);
});

test('非端口占用的监听错误直接传播，不尝试重新分配端口', async t => {
  const f = fixture(t), server = f.server(), initialListening = server.listeners('listening');
  fs.writeFileSync(f.file, JSON.stringify({ port: 43210 }));
  let calls = 0;
  const error = Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
  server.listen = () => { calls++; process.nextTick(() => server.emit('error', error)); return server; };
  await assert.rejects(listenDesktop(server, { portFile: f.file }), thrown => thrown === error);
  assert.equal(calls, 1);
  assert.equal(server.listenerCount('error'), 0);
  assert.deepEqual(server.listeners('listening'), initialListening);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { port: 43210 });
});
