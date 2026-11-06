import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
// 内存中的会话状态，不启动浏览器、不访问 AutoDL。
test('readySince 记录本次进入“会话可用”的时间：保持可用时不变，离开后清除，再次核验通过时更新', async () => {
  const adapter = new AutoDLBrowserAdapter('unused-isolated-session-profile');
  assert.equal(adapter.sessionStatus().readySince, undefined);
  adapter.setSession('ready', { checked: true });
  const first = adapter.sessionStatus().readySince;
  assert.ok(Number.isFinite(first));
  await new Promise(resolve => setTimeout(resolve, 5));
  adapter.setSession('ready', { checked: true });
  assert.equal(adapter.sessionStatus().readySince, first);
  adapter.setSession('checking');
  assert.equal(adapter.sessionStatus().readySince, undefined);
  adapter.setSession('ready', { checked: true });
  assert.ok(adapter.sessionStatus().readySince > first);
});

