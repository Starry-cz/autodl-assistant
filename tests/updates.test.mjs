import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseUpdates, compareVersions, RELEASE_API, UPDATE_CACHE_MS, UPDATE_RETRY_MS } from '../src/updates.mjs';

const repository = 'https://github.com/Starry-cz/autodl-assistant';
function release(version = '1.2.0') {
  const tag = 'v' + version;
  const names = [`autodl-assistant-desktop-${version}-setup-x64.exe`, `autodl-assistant-desktop-${version}-win-x64.zip`,
    `autodl-assistant-v${version}.zip`, 'autodl-assistant-setup.cmd'];
  return { tag_name: tag, draft: false, prerelease: false, html_url: `${repository}/releases/tag/${tag}`,
    published_at: '2026-11-06T12:00:00Z', body: '合成更新说明', assets: names.map(name => ({ name, state: 'uploaded', browser_download_url: `${repository}/releases/download/${tag}/${name}` })) };
}
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('按稳定语义版本比较，1.10大于1.9，预发布及格式错误不能当正式版', () => {
  for (const [left, right, expected] of [['v1.10.0', '1.9.9', 1], ['1.2.10', '1.2.9', 1], ['2.0.0', '10.0.0', -1],
    ['1.2.0+build.7', 'v1.2.0', 0], ['1.2.0-beta.1', '1.1.1', null], ['01.2.0', '1.1.1', null], ['1.2', '1.1.1', null]]) {
    assert.equal(compareVersions(left, right), expected, `${left} / ${right}`);
  }
});

test('公开发布检查不附带账号数据，并返回四种当前版本附件', async () => {
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', channel: 'desktop', fetchImpl: async (url, options) => {
    assert.equal(url, RELEASE_API);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
    assert.equal(options.body, undefined);
    return response(release());
  } });
  const state = await checker.check();
  assert.equal(state.status, 'available'); assert.equal(state.updateAvailable, true);
  assert.equal(state.currentVersion, '1.1.1'); assert.equal(state.channel, 'desktop');
  assert.equal(state.latestVersion, '1.2.0'); assert.equal(Object.values(state.downloads).filter(Boolean).length, 4);
  assert.equal(state.notes, '合成更新说明');
  state.downloads.source = 'mutated';
  assert.notEqual(checker.publicState().downloads.source, 'mutated');
  checker.close();
});

test('当前版和开发中的较新本地版都不会提示降级', async () => {
  for (const [currentVersion, expected] of [['1.2.0', 'current'], ['1.3.0', 'ahead']]) {
    const checker = new ReleaseUpdates({ currentVersion, fetchImpl: async () => response(release()) });
    const state = await checker.check();
    assert.equal(state.status, expected); assert.equal(state.updateAvailable, false); checker.close();
  }
});

test('并发检查只发送一次，普通检查缓存6小时，强制检查仍间隔至少60秒', async () => {
  let now = 1000000, calls = 0, releaseFetch;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => now, fetchImpl: async () => {
    calls++; await new Promise(resolve => { releaseFetch = resolve; }); return response(release());
  } });
  const first = checker.check(), second = checker.check({ force: true });
  assert.equal(first, second); assert.equal(checker.publicState().status, 'checking');
  await Promise.resolve(); releaseFetch(); await first;
  await checker.check({ force: true }); assert.equal(calls, 1);
  now += 60000; await checker.check(); assert.equal(calls, 1);
  const forced = checker.check({ force: true }); await Promise.resolve(); releaseFetch(); await forced; assert.equal(calls, 2);
  now += UPDATE_CACHE_MS;
  const expired = checker.check(); await Promise.resolve(); releaseFetch(); await expired; assert.equal(calls, 3);
  checker.close();
});

test('离线后不谎称最新版，保留已知新版入口，失败15分钟后自动重试', async () => {
  let now = 1000000, calls = 0;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => now, fetchImpl: async () => {
    calls++; if (calls === 2) throw new TypeError('fetch failed'); return response(release());
  } });
  const initial = await checker.check(); now += 60000;
  const failed = await checker.check({ force: true });
  assert.equal(failed.status, 'error'); assert.equal(failed.updateAvailable, true);
  assert.equal(failed.checkedAt, initial.checkedAt); assert.deepEqual(failed.downloads, initial.downloads);
  assert.match(failed.error, /网络/); assert.equal(failed.nextCheckAt, now + UPDATE_RETRY_MS);
  now += UPDATE_RETRY_MS - 1; await checker.check(); assert.equal(calls, 2);
  now++; assert.equal((await checker.check()).status, 'available'); assert.equal(calls, 3); checker.close();
});

test('首次网络失败可再次检查，同步抛出的fetch也不会留下永久pending', async () => {
  let now = 1000000, calls = 0;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => now, fetchImpl: () => {
    calls++; if (calls === 1) throw new TypeError('synthetic offline'); return Promise.resolve(response(release()));
  } });
  const failed = await checker.check(); assert.equal(failed.status, 'error'); assert.equal(failed.updateAvailable, false); assert.equal(failed.checkedAt, null);
  now += 60000; assert.equal((await checker.check({ force: true })).status, 'available'); assert.equal(calls, 2); checker.close();
});

test('状态序号区分失败前的旧快照，进入检查和结束各推进一次，纯读与缓存不推进', async () => {
  let now = 1000000, rejectFetch, calls = 0;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => now, fetchImpl: async () => {
    calls++;
    if (calls === 1) return response(release());
    return new Promise((_resolve, reject) => { rejectFetch = reject; });
  } });
  const initialRevision = checker.publicState().revision;
  const first = checker.check();
  const firstPendingRevision = checker.publicState().revision;
  assert.ok(firstPendingRevision > initialRevision);
  const success = await first; assert.ok(success.revision > firstPendingRevision);
  assert.equal((await checker.check()).revision, success.revision); assert.equal(checker.publicState().revision, success.revision);
  now += 60000;
  const retry = checker.check({ force: true });
  const pending = checker.publicState(); assert.equal(pending.status, 'checking'); assert.ok(pending.revision > success.revision);
  await Promise.resolve(); rejectFetch(new TypeError('synthetic offline'));
  const failed = await retry;
  assert.equal(failed.status, 'error'); assert.ok(failed.revision > pending.revision);
  assert.equal(failed.checkedAt, success.checkedAt); assert.equal(failed.updateAvailable, true);
  assert.equal(checker.publicState().revision, failed.revision); assert.equal((await checker.check()).revision, failed.revision);
  checker.close();
});

test('同版本后台重启的初始状态晚于旧快照，revision不使用缓存测试时钟', async () => {
  const previous = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => 1000, fetchImpl: async () => {
    // 模拟真实异步请求；缓存时钟刻意保持在历史值，与状态序号时钟分离。
    await new Promise(resolve => setTimeout(resolve, 5)); return response(release());
  } });
  const oldState = await previous.check(); previous.close();
  await new Promise(resolve => setTimeout(resolve, 2));
  const restarted = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => 1000 });
  const newState = restarted.publicState();
  assert.equal(newState.currentVersion, oldState.currentVersion); assert.equal(newState.status, 'idle');
  assert.ok(newState.revision > oldState.revision); assert.ok(newState.revision > 1000);
  restarted.close();
});

test('草稿、预发布和无效tag不成为正式更新', async () => {
  for (const invalid of [{ ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), tag_name: 'v1.2.0-beta' }]) {
    const checker = new ReleaseUpdates({ currentVersion: '1.1.1', fetchImpl: async () => response(invalid) });
    const state = await checker.check(); assert.equal(state.status, 'error'); assert.equal(state.latestVersion, null);
    assert.equal(state.updateAvailable, false); checker.close();
  }
});

test('没有正式发布及服务失败清楚返回错误状态，界面不会显示最新', async () => {
  for (const status of [404, 500]) {
    const checker = new ReleaseUpdates({ currentVersion: '1.1.1', fetchImpl: async () => new Response('', { status }) });
    const state = await checker.check(); assert.equal(state.status, 'error'); assert.equal(state.checkedAt, null); assert.ok(state.error); checker.close();
  }
});

test('触发GitHub限流后遵循恢复时间，手动点击不能持续请求', async () => {
  let now = 1000000, calls = 0;
  const reset = now + 3600000;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', clock: () => now, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('', { status: 403, headers: { 'x-ratelimit-reset': String(reset / 1000) } }) : response(release());
  } });
  const failed = await checker.check(); assert.equal(failed.nextCheckAt, reset); assert.match(failed.error, /受限/);
  now += UPDATE_RETRY_MS; await checker.check({ force: true }); assert.equal(calls, 1);
  now = reset; assert.equal((await checker.check()).status, 'available'); assert.equal(calls, 2); checker.close();
});

test('只允许本仓库同版本的已上传附件，其他链接不作为下载入口', async () => {
  const data = release();
  data.assets[0].browser_download_url = 'https://unrelated.example.test/setup.exe';
  data.assets[1].state = 'new';
  data.assets[2].browser_download_url = `${repository}/releases/download/v1.1.1/autodl-assistant-v1.1.1.zip`;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', fetchImpl: async () => response(data) });
  const state = await checker.check();
  assert.equal(state.status, 'available'); assert.equal(state.downloads.desktopInstaller, null);
  assert.equal(state.downloads.desktopPortable, null); assert.equal(state.downloads.source, null); assert.ok(state.downloads.onlineInstaller);
  checker.close();
  const wrong = new ReleaseUpdates({ currentVersion: '1.1.1', fetchImpl: async () => response({ ...release(), html_url: 'https://unrelated.example.test/' }) });
  assert.equal((await wrong.check()).status, 'error'); wrong.close();
});

test('请求超时会中止网络并提供可重试错误', async () => {
  let signal;
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', timeoutMs: 15, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const state = await checker.check(); assert.equal(signal.aborted, true); assert.equal(state.status, 'error'); assert.match(state.error, /超时/); checker.close();
});

test('退出中止未完成检查，关闭后不再联网', async () => {
  let entered, signal, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const checker = new ReleaseUpdates({ currentVersion: '1.1.1', fetchImpl: async (_url, options) => {
    calls++; signal = options.signal; entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = checker.check(); await started; checker.close();
  assert.equal((await pending).status, 'idle'); assert.equal(signal.aborted, true);
  await checker.check({ force: true }); assert.equal(calls, 1);
});
