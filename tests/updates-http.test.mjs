import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApplication } from '../src/server.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';

async function fixture(t, updatesOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-updates-http-'));
  // 合成未登录会话：更新检查不要求 AutoDL 账号，也不得调用浏览器适配器。
  const autodl = Object.assign(new SyntheticAdapter(), { readIdentity: async () => { throw Error('更新检查不应访问账号'); }, sessionStatus: () => ({ state: 'closed', browserOpen: false }) });
  const app = createApplication({ runtimeDir: dir, adapters: { autodl }, startEngine: false, updatesOptions });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, data) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Local-Token': app.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  t.after(async () => {
    await app.close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('autodl-updates-http-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { app, base, request };
}

test('状态轮询不访问GitHub，未登录可显式检查，但仍需本地令牌和同源请求', async t => {
  let calls = 0;
  const f = await fixture(t, { currentVersion: 'fake-override', channel: 'desktop', fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false,
      html_url: 'https://github.com/Starry-cz/autodl-assistant/releases/tag/v99.0.0', assets: [], body: '合成正式发布' }));
  } });
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.updates.status, 'idle'); assert.equal(state.updates.channel, 'desktop');
  assert.notEqual(state.updates.currentVersion, 'fake-override'); assert.equal(calls, 0); assert.equal(state.account.identity, null);
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(f.base + '/api/updates/check', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(f.base + '/api/updates/check', { method: 'POST', headers: { ...headers, 'X-Local-Token': f.app.token, Origin: 'https://foreign.example.test' }, body: '{}' })).status, 403);
  assert.equal((await f.request('/api/updates/check', { force: 'yes' })).status, 400);
  assert.equal(calls, 0);
  const checked = await f.request('/api/updates/check', { force: false }); assert.equal(checked.status, 200);
  const updates = (await checked.json()).updates; assert.equal(updates.status, 'available'); assert.equal(calls, 1);
  assert.deepEqual((await (await f.request('/api/state')).json()).updates, updates);
  await f.request('/api/updates/check', { force: true }); assert.equal(calls, 1);
});

test('服务器正常关闭会取消更新网络请求，检查失败不影响原任务状态', async t => {
  let entered, aborted = false;
  const entry = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } });
  const taskCount = f.app.store.tasks().length;
  const pending = f.request('/api/updates/check', {}); await entry;
  const closing = f.app.close();
  assert.equal((await pending).status, 200); await closing;
  assert.equal(aborted, true); assert.equal(f.app.store.tasks().length, taskCount);
});

test('退出时完整回复正在检查的keep-alive请求，然后自动关闭连接与后台', async t => {
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const agent = new http.Agent({ keepAlive: true });
  let timeout;
  try {
    // 更新网络尚未结束时启动退出；浏览器原本会将这条HTTP连接留给后续状态轮询。
    const received = new Promise((resolve, reject) => {
      const req = http.request(f.base + '/api/updates/check', { method: 'POST', agent,
        headers: { 'X-Local-Token': f.app.token, 'Content-Type': 'application/json', 'Content-Length': 2 } }, res => {
        let content = ''; res.setEncoding('utf8'); res.on('data', part => { content += part; });
        res.on('end', () => resolve({ status: res.statusCode, complete: res.complete, content }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end('{}');
    });
    await entry;
    const closing = f.app.close();
    const result = await received;
    assert.equal(result.status, 200); assert.equal(result.complete, true);
    assert.equal(JSON.parse(result.content).updates.status, 'idle');
    await Promise.race([closing, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error('完整回复后后台仍在等待keep-alive连接')), 500); })]);
    assert.equal(f.app.server.listening, false);
  } finally { clearTimeout(timeout); agent.destroy(); }
});
