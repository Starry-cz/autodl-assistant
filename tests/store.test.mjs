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

