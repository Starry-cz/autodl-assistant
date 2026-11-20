import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../src/store.mjs';
import { fixture } from './helpers.mjs';

test('状态落盘后可读取任务、日志、提交记录和去重通知',t=>{
  const f=fixture(t);f.store.patch(f.task,{state:'submitting',operation:{stage:'click_started',at:f.clock()}});
  f.store.enqueueNotification(f.task,'attention','隔离合成通知');f.store.enqueueNotification(f.task,'attention','重复合成通知');
  const loaded=new Store(f.dir);assert.equal(loaded.get(f.task.id).operation.stage,'click_started');assert.equal(loaded.data.notifications.length,1);assert.equal(fs.existsSync(`${loaded.file}.tmp`),false);
});
test('同一事件恢复新一轮后才允许再次通知',t=>{
  const f=fixture(t);f.store.enqueueNotification(f.task,'attention','合成事件');f.store.patch(f.task,{notifyEpoch:1});f.store.enqueueNotification(f.task,'attention','新一轮合成事件');assert.equal(f.store.data.notifications.length,2);
});
test('公开状态掩码通知凭证，不将持久化凭证回显',t=>{
  const f=fixture(t);f.store.data.settings={webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify',webhookToken:'synthetic-secret-abc',wechatToken:'synthetic-secret-def'};
  const visible=f.store.publicState();assert.equal(visible.settings.webhookUrl,'***');assert.equal(visible.settings.wechatToken,'***');assert.equal(JSON.stringify(visible).includes('synthetic-secret'),false);assert.equal(f.store.data.settings.webhookToken,'synthetic-secret-abc');
});
test('损坏或不完整状态拒绝加载，不以空任务覆盖原文件',t=>{
  const f=fixture(t);for(const value of ['{broken','{"version":1,"tasks":[{}],"notifications":[]}']){
    fs.writeFileSync(f.store.file,value);assert.throws(()=>new Store(f.dir),/损坏/);assert.equal(fs.readFileSync(f.store.file,'utf8'),value);
  }
});
test('日志保留最近200条，公开状态只提供最近80条',t=>{
  const f=fixture(t);f.task.logs=Array.from({length:210},(_,i)=>({at:i,message:`合成日志${i}`,level:'info'}));f.store.log(f.task,'info','最后一条合成日志');assert.equal(f.task.logs.length,200);assert.equal(f.store.publicState().tasks[0].logs.length,80);
});

test('重建保存失败恢复新旧任务内存，磁盘保留可恢复旧记录',t=>{
  const f=fixture(t);f.store.patch(f.task,{state:'attention',lastError:'合成镜像失效'});
  const previous=structuredClone(f.task),disk=fs.readFileSync(f.store.file,'utf8'),save=f.store.save;
  f.store.save=()=>{throw Error('synthetic save failure');};
  try{assert.throws(()=>f.store.create({...f.task.config,name:'替换任务'},{replaces:f.task,balanceCheck:{pendingQuote:true}}),/save failure/);}
  finally{f.store.save=save;}
  assert.equal(f.store.tasks().length,1);assert.deepEqual(f.task,previous);assert.equal(fs.readFileSync(f.store.file,'utf8'),disk);assert.equal(new Store(f.dir).tasks()[0].state,'attention');
});

test('恢复落盘失败保留暂停状态，后续无关写入不会偷偷重启任务', t => {
  const f = fixture(t);
  f.store.patch(f.task, { state: 'paused' });
  const previous = structuredClone(f.task);
  f.advance(1000);
  const write = t.mock.method(f.store, 'save', () => { throw Error('合成写入失败'); });
  assert.throws(() => f.engine.control(f.task, 'resume'), /写入失败/);
  write.mock.restore();
  assert.deepEqual(f.task, previous);
  f.store.log(f.task, 'info', '其他操作');
  const restored = new Store(f.dir).get(f.task.id);
  assert.equal(restored.state, previous.state);
  assert.equal(Object.hasOwn(restored, 'notifyEpoch'), false);
});

for (const [action, state] of [['pause', 'paused'], ['cancel', 'cancelled']]) {
  test(`请求 ${action} 写盘失败时本进程先停止，明确提示重启可能读到旧状态`, async t => {
    const f = fixture(t);
    const diskState = f.task.state;
    const write = t.mock.method(f.store, 'save', () => { throw Error('合成写入失败'); });
    assert.throws(() => f.engine.control(f.task, action), /尚未保存.*重启/);
    assert.equal(f.task.state, state);
    assert.equal(new Store(f.dir).get(f.task.id).state, diskState);
    write.mock.restore();
    await f.engine.tick();
    assert.equal(f.submissions, 0);
    f.store.save();
    assert.equal(new Store(f.dir).get(f.task.id).state, state);
  });
}

test('日志和通知写入失败后可重试，重启后各保留一条', t => {
  const f = fixture(t);
  const initialLogs = structuredClone(f.task.logs);
  const write = t.mock.method(f.store, 'save', () => { throw Error('合成写入失败'); });
  assert.throws(() => f.store.log(f.task, 'warn', '磁盘重试'), /写入失败/);
  assert.throws(() => f.store.enqueueNotification(f.task, 'found', '找到资源'), /写入失败/);
  write.mock.restore();
  assert.deepEqual(f.task.logs, initialLogs);
  assert.equal(f.store.data.notifications.length, 0);
  f.store.log(f.task, 'warn', '磁盘重试');
  f.store.enqueueNotification(f.task, 'found', '找到资源');
  const restored = new Store(f.dir);
  assert.equal(restored.get(f.task.id).logs.filter(log => log.message === '磁盘重试').length, 1);
  assert.equal(restored.data.notifications.length, 1);
});

test('平台已受理后写盘失败仍保留回执，恢复写盘时能按原实例核对', t => {
  const f = fixture(t);
  f.store.patch(f.task, { state: 'submitting', operation: { stage: 'click_started', clickedAt: f.clock() } });
  const accepted = { ...f.task.operation, stage: 'accepted', receipt: { instanceId: 'synthetic-accepted' } };
  const write = t.mock.method(f.store, 'save', () => { throw Error('合成写入失败'); });
  assert.throws(() => f.store.patch(f.task, { state: 'verifying', operation: accepted }), /写入失败/);
  write.mock.restore();
  assert.deepEqual(f.task.operation, accepted);
  assert.equal(new Store(f.dir).get(f.task.id).operation.stage, 'click_started');
  f.store.patch(f.task, { state: 'verifying' });
  assert.deepEqual(new Store(f.dir).get(f.task.id).operation, accepted);
});

