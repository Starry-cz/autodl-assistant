import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AppError } from '../src/errors.mjs';
import { accountOwnerId, normalizeAccountIdentity, taskBelongsToAccount, filterAccountTasks,
  filterAccountNotifications, assertTaskOwner, claimLegacyTasks } from '../src/account-scope.mjs';
import { readIdentityInPage, readAutodlIdentity } from '../src/adapters/autodl-account.mjs';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';

// 独立合成账号、页面和点击替身；不读取用户会话，不执行任何实际平台操作。
const identity = (accountId = 'synthetic-account-A', subAccountId = null) => normalizeAccountIdentity({ accountId, subAccountId,
  kind: subAccountId ? 'sub' : 'main', displayName: '合成账号' }, { now: 123 });
const A = identity(), B = identity('synthetic-account-B');
const task = (id, extra = {}) => ({ id, state: 'queued', config: { provider: 'autodl', mode: 'create' }, ...extra });

test('稳定owner键区分主账号和各子账号，不依赖显示名', () => {
  assert.notEqual(A.ownerId, B.ownerId); assert.notEqual(A.ownerId, identity(A.accountId, 'sub1').ownerId);
  assert.notEqual(identity(A.accountId, 'sub1').ownerId, identity(A.accountId, 'sub2').ownerId);
  assert.equal(normalizeAccountIdentity({ ...A, displayName: '改名', ownerId: 'forged' }).ownerId, A.ownerId);
  assert.equal(accountOwnerId('master', 'a:b'), 'autodl:["master","a:b"]');
});

test('身份缺少稳定ID时拒绝，不用手机号、数字id或旧ownerId替代', () => {
  for (const value of [{ kind: 'main', displayName: '合成', id: 1 }, { ...A, accountId: '' }, { ...A, kind: 'sub', subAccountId: null }])
    assert.throws(() => normalizeAccountIdentity(value), { code: 'ACCOUNT_IDENTITY' });
  const value = normalizeAccountIdentity({ ...A, displayName: '13800000000', phone: '13800000000', email: 'synthetic@example.test', token: 'synthetic-secret' });
  assert.equal(value.displayName, 'AutoDL 账号'); assert.doesNotMatch(JSON.stringify(value), /13800000000|synthetic-secret|email|phone/);
});

test('只显示当前账号任务与关联消息，未归属及孤立消息均不泄露', () => {
  const tasks = [task('A', { ownerId: A.ownerId }), task('B', { ownerId: B.ownerId }), task('legacy'),
    task('demo', { ownerId: A.ownerId, config: { provider: 'demo' } })];
  assert.deepEqual(filterAccountTasks(tasks, A).map(t => t.id), ['A']);
  assert.deepEqual(filterAccountTasks(tasks, null), []);
  assert.equal(taskBelongsToAccount(tasks[0], A.ownerId), true); assert.equal(taskBelongsToAccount(tasks[1], A), false);
  const notices = ['A', 'B', 'legacy', 'orphan', 'demo'].map(taskId => ({ taskId }));
  assert.deepEqual(filterAccountNotifications(notices, tasks, A), [{ taskId: 'A' }]);
});

test('执行校验分别阻断无账号、未归属和其他账号任务', () => {
  const owned = task('A', { ownerId: A.ownerId });
  assert.throws(() => assertTaskOwner(owned, null), { code: 'ACCOUNT_REQUIRED' });
  assert.throws(() => assertTaskOwner(task('legacy'), A), { code: 'ACCOUNT_UNCLAIMED' });
  assert.throws(() => assertTaskOwner(owned, B), { code: 'ACCOUNT_MISMATCH' });
  assert.doesNotThrow(() => assertTaskOwner(owned, A));
});

test('旧任务只凭完整清单中的精确目标ID认领，原数组不变', () => {
  const source = [task('done', { state: 'completed', result: { id: 'instance-one' } }),
    task('submitted', { operation: { stage: 'accepted', receipt: { instanceId: 'instance-two' } } }), task('unknown')];
  const result = claimLegacyTasks(source, A, [{ id: 'instance-one' }, { id: 'instance-two' }], { complete: true, now: 999 });
  assert.deepEqual(result.claimedTaskIds, ['done', 'submitted']); assert.equal(result.unclaimedCount, 1);
  assert.equal(result.tasks[0].ownerId, A.ownerId); assert.equal(result.tasks[0].ownerAssignedAt, 999);
  assert.deepEqual(result.tasks[1].ownerClaim, { instanceId: 'instance-two', evidence: 'receipt', at: 999 });
  assert.equal(source[0].ownerId, undefined); assert.equal(source[1].operation.stage, 'accepted');
  assert.equal(result.tasks[2], source[2]);
});

test('不完整清单不认领，既有owner不改，实例ID相似片段不匹配', () => {
  const source = [task('old', { result: { id: 'complete-instance' } }), task('B', { ownerId: B.ownerId, result: { id: 'complete-instance' } })];
  assert.deepEqual(claimLegacyTasks(source, A, [{ id: 'complete-instance' }]).claimedTaskIds, []);
  assert.deepEqual(claimLegacyTasks(source, A, [{ id: 'complete' }], { complete: true }).claimedTaskIds, []);
  const result = claimLegacyTasks(source, A, [{ id: 'complete-instance' }], { complete: true });
  assert.deepEqual(result.claimedTaskIds, ['old']); assert.equal(result.tasks[1].ownerId, B.ownerId);
});

test('开机与未提交克隆可按原实例认领，完成/已提交克隆不能借源实例猜目标', () => {
  const config = { provider: 'autodl', mode: 'clone', sourceId: 'source-instance' };
  const source = [task('clone-new', { config }), task('clone-done', { config, state: 'completed' }),
    task('clone-submitted', { config, operation: { stage: 'click_started' } }),
    task('clone-other-target', { config, state: 'completed', result: { id: 'other-target' } }),
    task('boot', { config: { ...config, mode: 'boot' }, state: 'completed' })];
  assert.deepEqual(claimLegacyTasks(source, A, [{ id: 'source-instance' }], { complete: true }).claimedTaskIds, ['clone-new', 'boot']);
});

function pageFixture({ storage = {}, data = { uuid: 'fresh-account', username: 'Fresh name' }, code = 'Success', status = 200, tokenChanges = false, rejects = false } = {}) {
  const values = { token: 'synthetic-token', user: '{"uuid":"stale-account","username":"stale-name"}', ...storage }, calls = [];
  const localStorage = { getItem: key => values[key] ?? null };
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method, headers: JSON.parse(JSON.stringify(options.headers)) });
    if (rejects) throw Error('synthetic-private-network-error');
    if (tokenChanges) values.token = 'synthetic-other-token';
    return new Response(JSON.stringify({ code, data, msg: 'synthetic-private-message' }), { status });
  };
  return { calls, run: async () => JSON.parse(JSON.stringify(await vm.runInNewContext(`(${readIdentityInPage.toString()})()`,
    { location: { origin: 'https://www.autodl.com' }, localStorage, fetch, AbortSignal }))) };
}

test('主账号身份读取新鲜官方detail，缓存账号信息不参与归属', async () => {
  const page = pageFixture({ data: { uuid: 'fresh-account', username: 'Fresh name', phone: '13800000000', token: 'do-not-return', email: 'private@example.test' } });
  const result = await page.run();
  assert.equal(page.calls[0].url, '/api/v1/user/detail'); assert.equal(page.calls[0].method, 'GET');
  assert.equal(page.calls[0].headers.Authorization, 'synthetic-token');
  assert.deepEqual(result, { data: { accountId: 'fresh-account', subAccountId: null, displayName: 'Fresh name', kind: 'main' } });
  assert.doesNotMatch(JSON.stringify(result), /stale|phone|email|token|13800000000/);
});

test('子账号身份来自新鲜子资料的uuid/sub_name/user_name', async () => {
  const page = pageFixture({ storage: { user: '{"sub_name":"stale-sub","uuid":"stale-master"}' },
    data: { uuid: 'fresh-master', sub_name: 'fresh-sub', user_name: 'Fresh sub name', username: 'not-the-sub-name' } });
  assert.deepEqual(await page.run(), { data: { accountId: 'fresh-master', subAccountId: 'fresh-sub', displayName: 'Fresh sub name', kind: 'sub' } });
  assert.equal(page.calls[0].url, '/api/v1/sub_user');
});

test('缺字段、鉴权失败、网络失败均不退回缓存身份；账号切换丢弃旧请求', async () => {
  assert.deepEqual(await pageFixture({ data: { username: 'no-id' } }).run(), { error: 'SCHEMA' });
  assert.deepEqual(await pageFixture({ code: 'AuthorizeFailed' }).run(), { error: 'AUTH' });
  assert.deepEqual(await pageFixture({ status: 401 }).run(), { error: 'AUTH' });
  assert.deepEqual(await pageFixture({ rejects: true }).run(), { error: 'NETWORK' });
  assert.deepEqual(await pageFixture({ tokenChanges: true }).run(), { error: 'CHANGED' });
  const empty = pageFixture({ storage: { token: null } }); assert.deepEqual(await empty.run(), { error: 'AUTH' }); assert.equal(empty.calls.length, 0);
});

test('手机号式用户名在页面内就移除，失败的adapter不返回旧identity', async () => {
  assert.equal((await pageFixture({ data: { uuid: 'fresh-account', username: '+86 13800000000' } }).run()).data.displayName, null);
  const adapter = Object.create(AutoDLBrowserAdapter.prototype);
  adapter.session = { state: 'ready' }; adapter.identity = A;
  adapter.page = { url: () => 'https://www.autodl.com/create', isClosed: () => false,
    evaluate: async () => ({ error: 'SCHEMA' }) };
  await assert.rejects(readAutodlIdentity(adapter), { code: 'ACCOUNT_IDENTITY' });
  adapter.page.evaluate = async () => ({ data: { accountId: 'fresh-account', subAccountId: null, displayName: 'Fresh', kind: 'main' } });
  const fresh = await adapter.readIdentity(); assert.equal(fresh.accountId, 'fresh-account'); assert.notEqual(fresh.ownerId, A.ownerId);
});

function clickFixture(mode, guard) {
  const events = [], adapter = Object.create(AutoDLBrowserAdapter.prototype);
  const t = task('synthetic-click', { ownerId: A.ownerId, config: { provider: 'autodl', mode, sourceId: 'source-instance', gpuModel: 'RTX 4090', gpuCount: 1, regions: ['北京B区'] } });
  adapter.verifyTaskOwner = async current => { assert.equal(current, t); events.push('verify-start'); await Promise.resolve(); await guard(); events.push('verify-end'); };
  adapter.markClickSignals = async () => {};
  const mark = () => events.push('mark'), paidClick = async () => events.push('paid-click');
  if (mode === 'boot') {
    const source = { id: 'source-instance', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1, stopped: true, cardless: false, starting: false };
    const button = click => ({ count: async () => 1, isEnabled: async () => true, click });
    const row = { getByRole: () => button(async () => events.push('open-confirm')) };
    const dialog = { filter() { return this; }, waitFor: async () => {}, count: async () => 1, getByRole: () => button(paidClick) };
    adapter.findInstanceRow = async () => ({ row, info: source }); adapter.readInstanceRow = async () => ({ ...source, starting: true });
    adapter.page = { locator: () => dialog }; adapter.clickSignals = async () => ({ toasts: [], dialogs: [] });
    return { events, run: () => adapter.boot(t, mark) };
  }
  const quote = { hourly: 1, storageDaily: 0 };
  adapter.verifyPreparedForm = async () => quote; adapter.submitButton = async () => ({ click: paidClick });
  adapter.page = { url: () => 'https://www.autodl.com/create' }; adapter.clickOutcome = async () => ({ kind: 'accepted' });
  adapter.scanInstances = async () => [];
  return { events, run: () => adapter.submit(t, quote, mark) };
}

test('新建/原实例付费点击前等待异步账号核验，随后同步mark再点击', async () => {
  for (const mode of ['create', 'boot']) {
    const fixture = clickFixture(mode, async () => {}); await fixture.run();
    assert.deepEqual(fixture.events.slice(-4), ['verify-start', 'verify-end', 'mark', 'paid-click']);
  }
});

test('新建/原实例确认前账号不匹配时既不mark也不点击付费确认', async () => {
  for (const mode of ['create', 'boot']) {
    const fixture = clickFixture(mode, async () => { throw new AppError('ACCOUNT_MISMATCH', '合成账号不同'); });
    await assert.rejects(fixture.run(), { code: 'ACCOUNT_MISMATCH' });
    assert.equal(fixture.events.includes('mark'), false); assert.equal(fixture.events.includes('paid-click'), false);
  }
});
