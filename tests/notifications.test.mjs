import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notifications.mjs';
import { Store } from '../src/store.mjs';
import { fixture, gate } from './helpers.mjs';
import http from 'node:http';
const success=()=>({ok:true,json:async()=>({code:0})});
const queue=f=>f.store.enqueueNotification(f.task,'completed','【隔离演练】合成完成消息');

test('外部渠道未开启时只保留站内通知，不发送请求',async t=>{
  const f=fixture(t);queue(f);const notifier=new Notifier(f.store,{fetchImpl:async()=>{throw Error('不应联网');},clock:f.clock});await notifier.flush();assert.equal(f.store.data.notifications[0].attempts,0);
});
test('Webhook携带稳定去重标识与合成Bearer凭证，成功后不重复发送',async t=>{
  const f=fixture(t);f.store.data.settings={webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify',webhookToken:'synthetic-only'};queue(f);const sent=[];
  const notifier=new Notifier(f.store,{clock:f.clock,fetchImpl:async(url,options)=>{sent.push({url,options});return success();}});
  await notifier.flush();await notifier.flush();assert.equal(sent.length,1);assert.equal(sent[0].options.headers.Authorization,'Bearer synthetic-only');assert.equal(sent[0].options.headers['Idempotency-Key'],f.store.data.notifications[0].key);assert.match(JSON.parse(sent[0].options.body).content,/隔离演练/);
});
test('失败渠道按各自退避重试5次，成功的另一渠道不会被重发',async t=>{
  const f=fixture(t);f.store.data.settings={webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify',wechatEnabled:true,wechatToken:'synthetic-only'};queue(f);let hooks=0,wechat=0;
  const notifier=new Notifier(f.store,{clock:f.clock,fetchImpl:async(url)=>{if(url.includes('example.test')){hooks++;return {ok:false,status:503};}wechat++;return success();}});
  await notifier.flush();await notifier.flush();assert.equal(hooks,1);assert.equal(wechat,1);
  for(let i=0;i<6;i++){f.advance(301000);await notifier.flush();}
  assert.equal(hooks,5);assert.equal(wechat,1);assert.equal(f.store.data.notifications[0].deliveries.webhook.attempts,5);
});
test('微信使用原始Authorization，15秒节流并在重启后保留限速',async t=>{
  const f=fixture(t);f.store.data.settings={wechatEnabled:true,wechatToken:'synthetic-wechat-only'};queue(f);f.store.enqueueNotification(f.task,'attention','第二条隔离合成消息');let count=0;
  const fetchImpl=async(url,options)=>{count++;assert.equal(options.headers.Authorization,'synthetic-wechat-only');assert.equal(new URL(url).hostname,'www.autodl.com');return success();};
  const notifier=new Notifier(f.store,{clock:f.clock,fetchImpl});await notifier.flush();assert.equal(count,1);
  const afterRestart=new Notifier(new Store(f.dir,{clock:f.clock}),{clock:f.clock,fetchImpl});f.advance(14999);await afterRestart.flush();assert.equal(count,1);f.advance(1);await afterRestart.flush();assert.equal(count,2);
});
test('微信滚动24小时请求上限保留待发，不误报投递成功',async t=>{
  const f=fixture(t);f.store.data.settings={wechatEnabled:true,wechatToken:'synthetic-only'};queue(f);f.store.data.deliveryState={wechatAttempts:Array(50).fill(f.clock()-1000)};let calls=0;
  const notifier=new Notifier(f.store,{clock:f.clock,fetchImpl:async()=>{calls++;return success();}});await notifier.flush();assert.equal(calls,0);assert.equal(f.store.data.notifications[0].deliveries.wechat,undefined);
  f.advance(86400001);await notifier.flush();assert.equal(calls,1);
});
test('业务返回失败不能当发送成功，错误不回显URL或token',async t=>{
  const f=fixture(t);f.store.data.settings={webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify'};queue(f);const notifier=new Notifier(f.store,{clock:f.clock,fetchImpl:async()=>({ok:true,json:async()=>({success:false})})});await notifier.flush();assert.equal(f.store.data.notifications[0].deliveries.webhook.ok,false);
  f.advance(15001);notifier.fetch=async()=>{throw Error('https://isolated.example.test/?token=synthetic token=synthetic-private');};await notifier.flush();assert.equal(f.store.data.notifications[0].deliveries.webhook.error.includes('synthetic'),false);
});
test('Webhook 回执只读取有限长度：超长回执不读进内存，按状态码记为已送达', async t => {
  const f = fixture(t); f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://isolated.example.test/notify' }; queue(f);
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => new Response('x'.repeat(100000), { status: 200 }) });
  await notifier.flush(); assert.equal(f.store.data.notifications[0].deliveries.webhook.ok, true);
});

for (const channel of ['webhook', 'wechat']) test(`${channel} 回执流中断不能误报成功，恢复后按原退避重试`, async t => {
  const f = fixture(t); queue(f);
  f.store.data.settings = { [`${channel}Enabled`]: true, webhookUrl: 'https://isolated.example.test/notify', wechatToken: 'synthetic-only' };
  // 模拟已经收到 HTTP 200，但读取业务回执时连接中断；不发送真实通知。
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('回执连接中断')); },
  }), { status: 200 }) });
  await notifier.flush();
  const delivery = f.store.data.notifications[0].deliveries[channel];
  assert.equal(delivery.ok, false); assert.equal(delivery.pending, false);
  f.advance(15001); notifier.fetch = async () => success(); await notifier.flush();
  assert.equal(f.store.data.notifications[0].deliveries[channel].ok, true);
  assert.equal(f.store.data.notifications[0].deliveries[channel].attempts, 2);
});

test('微信需要明确成功回执，HTML、空对象及超长回执不能记为已送达', async t => {
  for (const body of ['<html>upstream error</html>', '{}', 'x'.repeat(20000)]) {
    const f = fixture(t); queue(f); f.store.data.settings = { wechatEnabled: true, wechatToken: 'synthetic-only' };
    await new Notifier(f.store, { clock: f.clock, fetchImpl: async () => new Response(body) }).flush();
    assert.equal(f.store.data.notifications[0].deliveries.wechat.ok, false);
  }
});

test('通用 Webhook 允许无正文的 204，微信识别明确 Success 回执', async t => {
  const f = fixture(t); queue(f);
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://isolated.example.test/notify', wechatEnabled: true, wechatToken: 'synthetic-only' };
  await new Notifier(f.store, { clock: f.clock, fetchImpl: async url => url.includes('example.test')
    ? new Response(null, { status: 204 }) : Response.json({ code: 'Success', data: null }) }).flush();
  assert.equal(f.store.data.notifications[0].deliveries.webhook.ok, true);
  assert.equal(f.store.data.notifications[0].deliveries.wechat.ok, true);
});

test('停止时完成正在发送的回执，不再启动下一渠道；重启只补发未发送渠道', async t => {
  const f = fixture(t), entered = gate(), release = gate(), sent = [];
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://isolated.example.test/notify',
    wechatEnabled: true, wechatToken: 'synthetic-only' };
  queue(f);
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async url => {
    sent.push(url);
    if (sent.length === 1) { entered.resolve(); await release.promise; }
    return success();
  } });
  // 用回执门控稳定复现“正在发送 Webhook 时退出”，不依赖网络时延。
  const flushing = notifier.flush();
  await entered.promise;
  const stopping = notifier.stop();
  release.resolve();
  await Promise.all([flushing, stopping]);
  assert.equal(sent.length, 1, '退出后不能再启动微信渠道');
  const saved = new Store(f.dir, { clock: f.clock });
  assert.equal(saved.data.notifications[0].deliveries.webhook.ok, true);
  assert.equal(saved.data.notifications[0].deliveries.wechat, undefined);
  await new Notifier(saved, { clock: f.clock, fetchImpl: async url => { sent.push(url); return success(); } }).flush();
  assert.equal(sent.length, 2);
  assert.equal(new URL(sent[1]).pathname, '/api/v1/wechat/message/send');
  assert.equal(saved.data.notifications[0].deliveries.wechat.ok, true);
});

test('测试通知只使用已保存渠道，发送明确测试内容且不产生任务或队列记录', async t => {
  const f = fixture(t), sent = [];
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.example.test/saved', webhookToken: 'saved-webhook-secret',
    wechatEnabled: true, wechatToken: 'saved-wechat-secret' };
  const taskBefore = JSON.stringify(f.store.tasks());
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    return url.includes('synthetic.example.test') ? new Response(null, { status: 204 }) : Response.json({ code: 'Success' });
  } });
  for (const channel of ['webhook', 'wechat']) {
    const result = await notifier.test(channel); assert.equal(result.channel, channel); assert.equal(result.success, true);
    assert.equal(result.at, f.clock()); assert.match(result.message, /已确认/);
  }
  assert.equal(sent[0].url, f.store.data.settings.webhookUrl);
  assert.equal(sent[0].options.headers.Authorization, 'Bearer saved-webhook-secret');
  assert.equal(sent[1].options.headers.Authorization, 'saved-wechat-secret');
  assert.equal(sent[0].body.event, 'test'); assert.equal(sent[0].body.taskId, null);
  assert.match(sent[1].body.title, /测试通知/); assert.match(sent[1].body.content, /不会创建或启动实例/);
  assert.equal(JSON.stringify(f.store.tasks()), taskBefore); assert.deepEqual(f.store.data.notifications, []);
});

test('未保存启用或缺少地址凭据时拒绝测试，未知渠道不会发送', async t => {
  const f = fixture(t); let calls = 0;
  const notifier = new Notifier(f.store, { fetchImpl: async () => { calls++; throw Error('不应发送'); } });
  for (const channel of ['webhook', 'wechat', 'unknown']) await assert.rejects(notifier.test(channel), error => error.code === 'CONFIG');
  f.store.data.settings = { webhookEnabled: true, wechatEnabled: true };
  await assert.rejects(notifier.test('webhook'), /接收地址/); await assert.rejects(notifier.test('wechat'), /Token/);
  assert.equal(calls, 0); assert.deepEqual(f.store.data.notifications, []);
});

test('测试失败给出可读原因并脱敏，一次点击失败后不自动重试', async t => {
  const f = fixture(t); f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.example.test/secret', webhookToken: 'private-synthetic-token' };
  const cases = [
    [() => new Response(null, { status: 401 }), /HTTP 401.*凭据/, 'NOTIFICATION_HTTP'],
    [() => new Response(null, { status: 429 }), /HTTP 429.*限流/, 'NOTIFICATION_HTTP'],
    [() => Response.json({ code: 'Unauthorized', msg: 'Token private-synthetic-token 未绑定微信 https://synthetic.example.test/secret' }), /未绑定微信/, 'NOTIFICATION_REJECTED'],
    [() => { throw new TypeError('fetch failed'); }, /网络/, 'NOTIFICATION_NETWORK'],
  ];
  for (const [response, expected, code] of cases) {
    let calls = 0;
    const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { calls++; return response(); } });
    const result = await notifier.test('webhook');
    assert.equal(result.success, false); assert.equal(result.code, code); assert.match(result.message, expected);
    assert.equal(JSON.stringify(result).includes('private-synthetic-token'), false);
    assert.equal(JSON.stringify(result).includes('https://'), false);
    await notifier.flush(); assert.equal(calls, 1); assert.deepEqual(f.store.data.notifications, []);
    f.advance(10000);
  }
});

test('服务错误包含超长凭据时先完整脱敏再截断，不泄漏 Token 前缀', async t => {
  const f = fixture(t), token = 'long-private-secret-' + 'x'.repeat(400);
  f.store.data.settings = { wechatEnabled: true, wechatToken: token };
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => Response.json({ code: 'InvalidToken', msg: `凭据 ${token} 无效` }) });
  const result = await notifier.test('wechat');
  assert.equal(result.success, false); assert.equal(result.message.includes('long-private-secret'), false);
  assert.match(result.message, /已隐藏/); assert.ok(result.message.length <= 500);
});

test('微信测试与任务共用持久限速，测试 Webhook 也限制连续点击', async t => {
  const f = fixture(t); let calls = 0;
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.example.test/notify', wechatEnabled: true, wechatToken: 'synthetic-token' };
  const fetchImpl = async () => { calls++; return success(); };
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl });
  await notifier.test('wechat'); queue(f);
  f.store.data.settings.webhookEnabled = false; f.store.save(); await notifier.flush(); assert.equal(calls, 1);
  await assert.rejects(notifier.test('wechat'), error => error.status === 429 && /15 秒/.test(error.message));
  const restored = new Notifier(new Store(f.dir, { clock: f.clock }), { clock: f.clock, fetchImpl });
  await assert.rejects(restored.test('wechat'), error => error.status === 429);
  f.advance(15000); await restored.flush(); assert.equal(calls, 2);
  await assert.rejects(restored.test('wechat'), error => error.status === 429);
  f.store.data.settings.webhookEnabled = true; await notifier.test('webhook');
  await assert.rejects(notifier.test('webhook'), error => error.status === 429 && /10 秒/.test(error.message));
  f.advance(10000); await notifier.test('webhook'); assert.equal(calls, 4);
  f.store.data.deliveryState.wechatAttempts = Array(50).fill(f.clock());
  await assert.rejects(notifier.test('wechat'), error => error.status === 429 && /86400 秒/.test(error.message));
});

test('测试持有发送锁，重复请求及任务发送不会并行，正常退出等待当前回执', async t => {
  const f = fixture(t), entered = gate(), release = gate(); let calls = 0;
  f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.example.test/notify' }; queue(f);
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { calls++; entered.resolve(); await release.promise; return success(); } });
  const sending = notifier.test('webhook'); await entered.promise;
  await assert.rejects(notifier.test('webhook'), error => error.code === 'NOTIFICATION_BUSY');
  await notifier.flush(); assert.equal(calls, 1);
  let stopped = false; const stopping = notifier.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release.resolve(); assert.equal((await sending).success, true); await stopping;
  assert.equal(notifier.busy, false); assert.equal(f.store.data.notifications[0].attempts, 0);
});

test('发送中切换配置或账号，不把旧接收端回执显示为当前配置成功', async t => {
  for (const changeSettings of [true, false]) {
    const f = fixture(t), entered = gate(), release = gate(); let sameAccount = true;
    f.store.data.settings = { webhookEnabled: true, webhookUrl: 'https://synthetic.example.test/notify' };
    const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { entered.resolve(); await release.promise; return success(); } });
    const pending = notifier.test('webhook', { isCurrent: () => sameAccount }); await entered.promise;
    if (changeSettings) f.store.data.settings = { ...f.store.data.settings }; else sameAccount = false;
    release.resolve(); await assert.rejects(pending, error => error.code === 'NOTIFICATION_CONTEXT_CHANGED');
    assert.equal(notifier.busy, false); assert.deepEqual(f.store.data.notifications, []);
  }
});

test('测试收到响应头后正文挂起也受超时约束，失败后释放发送锁', { timeout: 5000 }, async t => {
  const f = fixture(t), bodyStarted = gate(), closed = gate(), abort = new AbortController();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"code":');
    res.once('close', () => closed.resolve()); bodyStarted.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  // 只在本机挂起正文已读到时触发同一超时信号，避免真实等待十秒或外发任何消息。
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 10000); return abort.signal; });
  f.store.data.settings = { webhookEnabled: true, webhookUrl: `http://127.0.0.1:${server.address().port}` };
  const notifier = new Notifier(f.store, { clock: f.clock });
  const pending = notifier.test('webhook'); await bodyStarted.promise;
  abort.abort(new DOMException('timed out', 'TimeoutError'));
  const result = await pending; await closed.promise;
  assert.equal(result.success, false); assert.equal(result.code, 'NOTIFICATION_TIMEOUT'); assert.match(result.message, /暂不确定/);
  assert.equal(notifier.busy, false); assert.deepEqual(f.store.data.notifications, []);
});

test('发送前写盘失败不能耗尽任务通知重试次数，恢复后仍可投递', async t => {
  for (const channel of ['webhook', 'wechat']) {
    const f = fixture(t); queue(f); let calls = 0;
    f.store.data.settings = { [`${channel}Enabled`]: true, webhookUrl: 'https://synthetic.example.test/notify', wechatToken: 'synthetic-only' };
    const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { calls++; return success(); } });
    const save = f.store.save.bind(f.store);
    // 连续模拟写盘暂时失败；每次都发生在真正发送之前，不能消耗发送重试预算。
    f.store.save = () => { throw Error('synthetic write temporarily unavailable'); };
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(notifier.flush(), /temporarily unavailable/);
      f.advance(301000);
    }
    assert.equal(calls, 0);
    f.store.save = save;
    await notifier.flush();
    assert.equal(calls, 1, channel + ' 写盘恢复后应真正发送');
    assert.equal(f.store.data.notifications[0].deliveries[channel].attempts, 1);
    assert.equal(f.store.data.notifications[0].deliveries[channel].ok, true);
  }
});

test('测试通知写盘失败不占用微信最后一个额度或 Webhook 冷却', async t => {
  for (const channel of ['webhook', 'wechat']) {
    const f = fixture(t); let calls = 0;
    f.store.data.settings = { [`${channel}Enabled`]: true, webhookUrl: 'https://synthetic.example.test/notify', wechatToken: 'synthetic-only' };
    f.store.data.deliveryState = { wechatAttempts: Array(49).fill(f.clock() - 1000) };
    const before = structuredClone(f.store.data.deliveryState), save = f.store.save.bind(f.store);
    const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { calls++; return success(); } });
    f.store.save = () => { throw Error('synthetic write temporarily unavailable'); };
    await assert.rejects(notifier.test(channel), /temporarily unavailable/);
    assert.equal(calls, 0); assert.equal(notifier.busy, false);
    assert.deepEqual(f.store.data.deliveryState, before);
    f.store.save = save;
    assert.equal((await notifier.test(channel)).success, true);
    assert.equal(calls, 1);
  }
});

test('真实请求已发送后写盘失败，不能回滚已占用次数或再次发送成功消息', async t => {
  const f = fixture(t); queue(f); let calls = 0, saves = 0;
  f.store.data.settings = { wechatEnabled: true, wechatToken: 'synthetic-only' };
  const save = f.store.save.bind(f.store);
  f.store.save = () => { if (++saves === 2) throw Error('synthetic receipt save failed'); return save(); };
  const notifier = new Notifier(f.store, { clock: f.clock, fetchImpl: async () => { calls++; return success(); } });
  await assert.rejects(notifier.flush(), /receipt save failed/);
  assert.equal(calls, 1); assert.equal(f.store.data.deliveryState.wechatAttempts.length, 1);
  assert.equal(f.store.data.notifications[0].deliveries.wechat.attempts, 1);
  assert.equal(f.store.data.notifications[0].deliveries.wechat.ok, true);
  f.store.save = save; f.advance(301000); await notifier.flush();
  assert.equal(calls, 1);
});

