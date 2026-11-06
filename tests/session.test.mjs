import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { classifySessionSnapshot, readSessionSnapshot } from '../src/adapters/autodl-session.mjs';

// 全部为隔离合成页面/会话信号，不打开真实浏览器、不访问 AutoDL、不读取本机登录。
const LIST = 'https://www.autodl.com/console/instance/list';
const readySnapshot = patch => ({ url: LIST, consoleReady: true, loginForm: false, humanRequired: false, loading: false, ...patch });
function fixture({ url = LIST, signals = {}, status = 200, failure = false } = {}) {
  const a = new AutoDLBrowserAdapter('unused-synthetic-session-profile');
  const events = [];
  const tab = new EventEmitter();
  let tabUrl = url;
  Object.assign(tab, {
    isClosed: () => false,
    url: () => tabUrl,
    goto: async target => { events.push(['goto', target]); if (failure) throw Error('synthetic network failure cookie=not-a-real-cookie'); return { status: () => status }; },
    waitForLoadState: async () => {},
    evaluate: async () => ({ consoleReady: true, loginForm: false, humanRequired: false, loading: false, ...signals }),
    bringToFront: async () => { events.push(['front']); },
    close: async () => { events.push(['close']); },
  });
  const main = new EventEmitter();
  let mainClosed = false;
  Object.assign(main, {
    isClosed: () => mainClosed,
    url: () => 'https://www.autodl.com/create',
    goto: async () => { throw Error('must not navigate the user task page'); },
    bringToFront: async () => events.push(['main-front']),
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
  });
  a.page = main;
  a.context = { newPage: async () => { events.push(['new-page']); return tab; }, pages: () => [main] };
  a.setSession('unchecked');
  return { a, tab, main, events, setUrl: value => { tabUrl = value; }, closeMain: () => { mainClosed = true; } };
}

test('未打开浏览器时检查只返回指引，不自动启动浏览器或断言已登录', async () => {
  const a = new AutoDLBrowserAdapter('unused-synthetic-session-profile');
  a.browser = async () => { throw Error('must not launch'); };
  assert.equal((await a.checkLogin()).session.state, 'not_open');
  assert.equal(a.sessionStatus().browserOpen, false);
  assert.equal(a.sessionStatus().checkedAt, null);
});
test('控制台地址本身不能证明登录，必须具有已加载实例列表的正向证据', () => {
  assert.equal(classifySessionSnapshot({ url: LIST }), 'unknown');
  assert.equal(classifySessionSnapshot(readySnapshot()), 'ready');
  assert.equal(classifySessionSnapshot(readySnapshot({ loading: true })), 'unknown');
  assert.equal(classifySessionSnapshot(readySnapshot({ url: 'https://www.autodl.com/create' })), 'unknown');
});
test('外部页面、网络错误页及无效地址不会被判定为会话可用', () => {
  for (const url of ['about:blank', 'chrome-error://chromewebdata/', 'not-a-url', 'https://isolated.example.test/console/instance/list', 'http://www.autodl.com/console/instance/list'])
    assert.equal(classifySessionSnapshot(readySnapshot({ url })), 'unknown');
});
test('首次登录、内嵌登录框与已确认会话失效分别展示', () => {
  const login = readySnapshot({ url: 'https://www.autodl.com/login?next=synthetic' });
  assert.equal(classifySessionSnapshot(login), 'login_required');
  assert.equal(classifySessionSnapshot(login, { previouslyReady: true }), 'expired');
  assert.equal(classifySessionSnapshot(readySnapshot({ loginForm: true })), 'login_required');
  assert.equal(classifySessionSnapshot(readySnapshot({ url: 'https://www.autodl.com/#/login' })), 'login_required');
});
test('人工验证优先于登录或列表证据，不会被认作会话可用', () => {
  assert.equal(classifySessionSnapshot(readySnapshot({ humanRequired: true })), 'human_required');
  assert.equal(classifySessionSnapshot(readySnapshot({ url: 'https://www.autodl.com/login', humanRequired: true }), { previouslyReady: true }), 'human_required');
});
test('快照只带布尔信号和去除查询参数的地址，不暴露正文及账号资料', async () => {
  const snapshot = await readSessionSnapshot({ evaluate: async () => ({ consoleReady: true }), url: () => LIST + '?token=synthetic-private' });
  assert.deepEqual(snapshot, { consoleReady: true, url: LIST });
  assert.equal(JSON.stringify(snapshot).includes('synthetic-private'), false);
});
test('独立核验标签页确认会话并复用，完全不刷新任务表单或点击付费控件', async () => {
  const f = fixture();
  const first = await f.a.checkLogin();
  assert.equal(first.session.state, 'ready'); assert.equal(first.session.browserOpen, true);
  assert.equal(typeof first.session.checkedAt, 'number');
  await f.a.checkLogin();
  assert.equal(f.events.filter(event => event[0] === 'new-page').length, 1);
  assert.deepEqual(f.events.filter(event => event[0] === 'goto'), [['goto', LIST], ['goto', LIST]]);
  assert.equal(f.events.some(event => event[0] === 'close'), false);
  assert.equal(JSON.stringify(first).includes('unused-synthetic-session-profile'), false);
});
test('核验页已被用于其他表单时创建新的核验页，不刷新用户表单', async () => {
  const f = fixture();
  f.a.sessionPage = { isClosed: () => false, url: () => 'https://www.autodl.com/create',
    goto: async () => { throw Error('must not navigate the existing form tab'); } };
  await f.a.checkLogin();
  assert.equal(f.events.filter(event => event[0] === 'new-page').length, 1);
  assert.equal(f.a.sessionStatus().state, 'ready');
});
test('登录及人工验证页面保留并置前，用户可以继续手动处理', async () => {
  for (const [url, signals, state] of [
    ['https://www.autodl.com/login', {}, 'login_required'],
    [LIST, { humanRequired: true }, 'human_required'],
  ]) {
    const f = fixture({ url, signals }); const result = await f.a.checkLogin();
    assert.equal(result.session.state, state);
    assert.equal(f.events.some(event => event[0] === 'front'), true);
    assert.equal(f.events.some(event => event[0] === 'close'), false);
  }
});
test('已验证后再次出现登录页面标记失效，但网络异常不冒充登录失效', async () => {
  const expired = fixture({ url: 'https://www.autodl.com/login' });
  expired.a.setSession('ready'); assert.equal((await expired.a.checkLogin()).session.state, 'expired');
  const network = fixture({ failure: true }); network.a.setSession('ready');
  const result = await network.a.checkLogin(); assert.equal(result.session.state, 'error');
  assert.equal(JSON.stringify(result).includes('not-a-real-cookie'), false);
});
test('HTTP错误和无法识别的页面都不能通过核验', async () => {
  assert.equal((await fixture({ status: 503 }).a.checkLogin()).session.state, 'error');
  assert.equal((await fixture({ signals: { consoleReady: false } }).a.checkLogin()).session.state, 'unknown');
});
test('检查期间关闭主窗口不会留下错误的会话可用状态', async () => {
  const f = fixture(); f.tab.evaluate = async () => { f.closeMain(); return { consoleReady: true }; };
  const result = await f.a.checkLogin(); assert.equal(result.session.state, 'closed'); assert.equal(result.session.browserOpen, false);
});
test('打开登录仅展示浏览器，不会自动声称已登录或刷新已有手动页面', async () => {
  const f = fixture(); const result = await f.a.login();
  assert.equal(result.session.state, 'unchecked');
  assert.deepEqual(f.events, [['main-front']]);
});
test('任务执行遇到登录过期或人工验证时更新公开状态并交给现有暂停机制', async () => {
  const expired = fixture({ url: 'https://www.autodl.com/login' });
  expired.a.setSession('ready'); expired.a.page = expired.tab;
  await assert.rejects(() => expired.a.checkPage(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(expired.a.sessionStatus().state, 'expired');
  const human = fixture({ signals: { humanRequired: true } }); human.a.page = human.tab;
  await assert.rejects(() => human.a.checkPage(), error => error.code === 'HUMAN_REQUIRED');
  assert.equal(human.a.sessionStatus().state, 'human_required');
});
test('未核验的普通创建页面不能代替实例列表登录检查', async () => {
  const f = fixture({ url: 'https://www.autodl.com/create' }); f.a.page = f.tab;
  await assert.rejects(() => f.a.checkPage(), error => error.code === 'LOGIN_CHECK_REQUIRED');
  assert.equal(f.a.sessionStatus().state, 'unknown');
});
test('主标签页关闭后状态更新，且不会删除已保存的本机会话', async () => {
  const f = fixture(); f.a.page = null; await f.a.browser(); f.a.setSession('ready');
  f.main.emit('close');
  assert.equal(f.a.sessionStatus().state, 'closed');
  assert.equal(f.a.sessionStatus().browserOpen, false);
  assert.match(f.a.sessionStatus().message, /会话未删除/);
});


test('网络访问拒绝显示中文处理指引，保留浏览器且不回显导航日志', async () => {
  const f = fixture();
  f.a.page = f.tab; f.setUrl('about:blank');
  f.tab.goto = async () => { throw Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://example.invalid/?token=synthetic-private\n\x1b[2mCall log: navigating\x1b[22m'); };
  await assert.rejects(f.a.login(), error => error.code === 'BROWSER_NETWORK_DENIED'
    && error.status === 503 && /退出旧服务/.test(error.message) && !/page\.goto|Call log|synthetic-private|\x1b/.test(error.message));
  assert.equal(f.a.sessionStatus().state, 'network_blocked');
  assert.equal(f.a.sessionStatus().browserOpen, true);
  assert.equal(f.events.some(event => event[0] === 'close'), false);
});

test('检查登录遇到网络拒绝不会冒充会话失效，且可在恢复后重试同一核验页', async () => {
  const f = fixture(); f.a.setSession('ready');
  f.tab.goto = async () => { throw Error('net::ERR_NETWORK_ACCESS_DENIED'); };
  const result = await f.a.checkLogin();
  assert.equal(result.session.state, 'network_blocked');
  assert.equal(typeof result.session.checkedAt, 'number');
  let retries = 0;
  f.tab.goto = async () => { retries++; return { status: () => 200 }; };
  await f.a.login();
  assert.equal(retries, 1); assert.equal(f.a.sessionStatus().state, 'unchecked');
  assert.equal(f.events.some(event => event[0] === 'main-front'), false);
  assert.equal(f.events.filter(event => event[0] === 'new-page').length, 1);
  assert.equal((await f.a.checkLogin()).session.state, 'ready');
});

test('任务访问被网络策略拒绝时停止自动重试并保留准备信息', async () => {
  const f = fixture(); const prepared = { synthetic: true }; f.a.prepared = prepared;
  f.a.page = f.tab;
  f.tab.goto = async () => { throw Error('net::ERR_NETWORK_ACCESS_DENIED'); };
  await assert.rejects(f.a.goto(LIST), error => error.code === 'BROWSER_NETWORK_DENIED' && !error.retryable);
  assert.equal(f.a.sessionStatus().state, 'network_blocked');
  assert.equal(f.a.prepared, prepared);
});

test('网络拒绝状态下打开登录不会刷新已有准备表单', async () => {
  const f = fixture(); f.a.prepared = { synthetic: true }; f.a.setSession('network_blocked');
  await f.a.login();
  assert.deepEqual(f.events, [['main-front']]);
});

test('普通超时仍归类为网络异常，管理策略拒绝与网络拒绝可以识别', async () => {
  const { isNetworkAccessDenied } = await import('../src/adapters/autodl-session.mjs');
  for (const code of ['ERR_NETWORK_ACCESS_DENIED','ERR_ACCESS_DENIED','ERR_BLOCKED_BY_ADMINISTRATOR'])
    assert.equal(isNetworkAccessDenied(Error('net::' + code)), true);
  assert.equal(isNetworkAccessDenied(Error('Timeout 20000ms exceeded')), false);
  assert.equal(isNetworkAccessDenied(Error('net::ERR_NAME_NOT_RESOLVED')), false);
  const f = fixture(); f.a.page = f.tab;
  f.tab.goto = async () => { throw Error('Timeout 20000ms exceeded'); };
  await assert.rejects(f.a.goto(LIST), error => error.code === 'NETWORK' && error.retryable);
});

test('对外错误过滤终端颜色控制符并继续隐藏网址和凭据', async () => {
  const { redact } = await import('../src/errors.mjs');
  const text = redact('\x1b[2mpage.goto: net::ERR_NETWORK_ACCESS_DENIED at https://example.invalid/?token=synthetic-private\x1b[22m cookie=synthetic-cookie');
  assert.match(text, /ERR_NETWORK_ACCESS_DENIED/);
  assert.doesNotMatch(text, /\x1b|synthetic-private|synthetic-cookie/);
});


test('主登录页正在人工验证时重复检查只读观察，不刷新或新开验证页', async () => {
  const f = fixture();
  f.main.url = () => 'https://www.autodl.com/login';
  f.main.evaluate = async () => ({ loginForm: true, humanRequired: true });
  for (let i = 0; i < 3; i++) assert.equal((await f.a.checkLogin()).session.state, 'human_required');
  assert.deepEqual(f.events, [['main-front'], ['main-front'], ['main-front']]);
  assert.equal(f.a.sessionPage, null);
});

test('主页面待登录时保留表单，登录跳转后仍需独立实例列表核验', async () => {
  const f = fixture();
  let mainUrl = 'https://www.autodl.com/login';
  f.main.url = () => mainUrl;
  f.main.evaluate = async () => ({ consoleReady: true, loginForm: false, humanRequired: false });
  assert.equal((await f.a.checkLogin()).session.state, 'login_required');
  assert.deepEqual(f.events, [['main-front']]);
  mainUrl = LIST;
  assert.equal((await f.a.checkLogin()).session.state, 'ready');
  assert.deepEqual(f.events.filter(event => event[0] === 'goto'), [['goto', LIST]]);
  assert.equal(f.events.filter(event => event[0] === 'new-page').length, 1);
});

test('现有核验页的登录与验证交互均不会被重复检查重置', async () => {
  for (const [url, signals, state, previouslyReady] of [
    ['https://www.autodl.com/login', {}, 'login_required', false],
    ['https://www.autodl.com/login', {}, 'expired', true],
    [LIST, { humanRequired: true }, 'human_required', false],
    [LIST, { loginForm: true }, 'login_required', false],
  ]) {
    const f = fixture({ url, signals });
    f.a.sessionPage = f.tab;
    f.a.previouslyReady = previouslyReady;
    for (let i = 0; i < 2; i++) assert.equal((await f.a.checkLogin()).session.state, state);
    assert.deepEqual(f.events, [['front'], ['front']]);
    assert.equal(f.a.sessionPage, f.tab);
  }
});

test('旧核验页停留在登录界面时，主标签已加载的实例列表可以证明登录完成', async () => {
  const f = fixture({ url: 'https://www.autodl.com/login' });
  f.a.sessionPage = f.tab;
  f.main.url = () => LIST;
  f.main.evaluate = async () => ({ consoleReady: true, loginForm: false, humanRequired: false, loading: false });
  assert.equal((await f.a.checkLogin()).session.state, 'ready');
  // 不刷新仍打开的旧登录表单，也不切走用户当前的实例列表。
  assert.deepEqual(f.events, []);
  f.tab.evaluate = async () => ({ humanRequired: true });
  assert.equal((await f.a.checkLogin()).session.state, 'human_required');
  assert.deepEqual(f.events, [['front']]);
});

test('保留的人工验证完成后恢复独立核验，读不到页面时不导航重置交互', async () => {
  const f = fixture({ url: 'https://www.autodl.com/login' });
  f.a.sessionPage = f.tab;
  assert.equal((await f.a.checkLogin()).session.state, 'login_required');
  f.tab.evaluate = async () => { throw Error('synthetic page transition'); };
  assert.equal((await f.a.checkLogin()).session.state, 'error');
  assert.equal(f.events.some(event => event[0] === 'goto'), false);
  f.setUrl(LIST);
  f.tab.evaluate = async () => ({ consoleReady: true, humanRequired: false, loginForm: false });
  assert.equal((await f.a.checkLogin()).session.state, 'ready');
  assert.deepEqual(f.events.filter(event => event[0] === 'goto'), [['goto', LIST]]);
});

