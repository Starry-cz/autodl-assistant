import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notifications.mjs';
import { Store } from '../src/store.mjs';
import { fixture, gate } from './helpers.mjs';
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

