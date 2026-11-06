import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Notifier } from '../src/notifications.mjs';
import { fixture } from './helpers.mjs';
test('旧演练任务保留原始配置和回执，迁移后不显示、不调度、不发送旧通知',async t=>{
  const f=fixture(t);f.task.config.provider='demo';
  const operation={stage:'accepted',at:f.clock(),receipt:{instanceId:'demo-old-receipt'}};
  f.store.patch(f.task,{state:'verifying',operation,result:{id:'demo-old-receipt'}});
  f.store.enqueueNotification(f.task,'completed','【演练】旧消息');
  f.store.data.settings={webhookEnabled:true,webhookUrl:'https://isolated.example.test/notify',rememberCredentials:false};
  // 模拟旧状态中的内存通知配置；不发送网络请求。
  const store=new Store(f.dir,{clock:f.clock}),task=store.get(f.task.id);
  assert.equal(task.state,'cancelled');assert.equal(task.legacyState,'verifying');assert.equal(task.legacyDisabled,true);
  assert.equal(task.config.provider,'demo');assert.deepEqual(task.operation,operation);assert.equal(task.result.id,'demo-old-receipt');
  assert.equal(store.publicState().tasks.length,0);assert.equal(store.publicState().notifications.length,0);
  assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).tasks.length,1);
  let calls=0;const forbidden=async()=>{calls++;throw Error('旧任务不能访问任何适配器');};
  const engine=new Engine(store,{autodl:{probe:forbidden,reconcile:forbidden,attach:forbidden}},{flush:async()=>{}},{clock:f.clock});
  await engine.tick();await engine.step(task);assert.equal(calls,0);
  assert.throws(()=>engine.control(task,'resume'),{code:'PROVIDER_REMOVED'});
  await assert.rejects(engine.attach(task,'synthetic-target'),{code:'PROVIDER_REMOVED'});
  store.data.settings=f.store.data.settings;
  const notifier=new Notifier(store,{fetchImpl:forbidden,clock:f.clock});await notifier.flush();assert.equal(calls,0);
  const logs=task.logs.length;const loaded=new Store(f.dir);assert.equal(loaded.get(task.id).logs.length,logs);assert.deepEqual(loaded.get(task.id).operation,operation);
  await engine.stop();await notifier.stop();
});

