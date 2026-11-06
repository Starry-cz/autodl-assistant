import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { SyntheticAdapter } from './fixtures/synthetic-adapter.mjs';
import { testConfig } from './fixtures/config.mjs';
// 所有实例、主机与消息均为隔离合成数据；不访问AutoDL或发送外部通知。
export function fixture(t, input = {}, { adapter: suppliedAdapter } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodl-isolated-test-'));
  let now = Date.now();
  const clock = () => now;
  const store = new Store(dir, {clock});
  const {availableAfter,copyFailure,...taskInput}=input;
  const task = store.create(testConfig({action:'execute',paidConsent:true,...taskInput}));
  const adapter = suppliedAdapter || new SyntheticAdapter({clock,availableAfter,copyFailure});
  const originalSubmit = adapter.submit.bind(adapter); let submissions = 0;
  adapter.submit = async (...args) => { submissions++; return originalSubmit(...args); };
  const notifier = {flush:async()=>{}};
  const engine = new Engine(store,{autodl:adapter},notifier,{clock,random:()=>0});
  t.after(async()=>{
    await engine.stop();
    const resolved=path.resolve(dir), parent=path.resolve(os.tmpdir())+path.sep;
    if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('autodl-isolated-test-')) throw Error('invalid isolated cleanup target');
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return {dir,store,task,adapter,engine,clock,notifier,get submissions(){return submissions;},
    advance(ms){now+=ms;},async due(ms=25000){now+=ms;await engine.tick();}};
}
export function gate() {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
