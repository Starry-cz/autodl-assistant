import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { systemSecretProtector } from '../src/credentials.mjs';
import { Store } from '../src/store.mjs';
import { Wallet } from '../src/wallet.mjs';
import { AiAssistant } from '../src/ai.mjs';
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-secrets-isolated-')),key=randomBytes(32);let writes=0;
  const protector={available:true,method:'isolated AES test',protect(plain){writes++;const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return{data:Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};},unprotect(s){const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(s.iv,'base64'));cipher.setAuthTag(Buffer.from(s.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(s.data,'base64')),cipher.final()]).toString('utf8');}};
  const store=new Store(dir,{secretProtector:protector});
  t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('autodl-secrets-isolated-'));fs.rmSync(target,{recursive:true,force:true});});
  return{dir,store,protector,reload:()=>new Store(dir,{secretProtector:protector}),disk:()=>fs.readFileSync(store.file,'utf8'),get writes(){return writes;}};
}
test('Windows DPAPI 合成凭据可往返，错误不回显秘密，其他系统不明文降级',{skip:process.platform!=='win32'},()=>{
  const p=systemSecretProtector(),secret='sk-synthetic-dpapi-only-123456',sealed=p.protect(secret);
  assert.equal(p.unprotect(sealed),secret);assert.equal(JSON.stringify(sealed).includes(secret),false);
  assert.throws(()=>p.unprotect({...sealed,data:Buffer.from('invalid').toString('base64')}),e=>e.code==='CREDENTIALS_LOCKED'&&!e.message.includes(secret));
  const unavailable=systemSecretProtector({platform:'linux'});assert.equal(unavailable.available,false);assert.throws(()=>unavailable.protect(secret),{code:'CREDENTIALS_UNAVAILABLE'});
});
test('五类凭据加密落盘、重启恢复、公共状态不泄露，未变凭据复用密文',t=>{
  const f=fixture(t),secrets=['sk-synthetic-ai-123','synthetic-wallet-123','https://synthetic.example.test/private','synthetic-webhook-123','synthetic-wechat-123'];
  f.store.data.aiSettings={rememberKey:true,apiKey:secrets[0]};f.store.data.walletSettings={rememberToken:true,token:secrets[1]};f.store.data.settings={rememberCredentials:true,webhookUrl:secrets[2],webhookToken:secrets[3],wechatToken:secrets[4]};f.store.save();
  for(const s of secrets){assert.equal(f.disk().includes(s),false);assert.equal(JSON.stringify(f.store.publicState()).includes(s),false);}
  assert.equal(f.writes,1);f.store.save();assert.equal(f.writes,1);assert.ok(JSON.parse(f.disk()).protectedSecrets);
  const restored=f.reload();assert.equal(restored.data.aiSettings.apiKey,secrets[0]);assert.equal(restored.data.walletSettings.token,secrets[1]);assert.equal(restored.data.settings.wechatToken,secrets[4]);
});
test('不记住时只保留内存，重启通知渠道停用，配置文件没有秘密',t=>{
  const f=fixture(t);f.store.data.aiSettings={rememberKey:false,apiKey:'synthetic-not-remembered-ai'};f.store.data.walletSettings={rememberToken:false,token:'synthetic-not-remembered-wallet'};f.store.data.settings={rememberCredentials:false,webhookEnabled:true,webhookUrl:'https://synthetic.example.test',wechatEnabled:true,wechatToken:'synthetic-not-remembered-wechat'};f.store.save();
  assert.equal(f.writes,0);assert.equal(f.disk().includes('synthetic'),false);assert.equal(f.store.data.settings.webhookEnabled,true);assert.equal(f.reload().data.settings.webhookEnabled,false);
});
test('旧版已保存的明文自动迁移，清除非记住残留，不泄露到新状态',t=>{
  const f=fixture(t);f.store.data.aiSettings={rememberKey:true,apiKey:'synthetic-legacy-ai'};f.store.data.settings={wechatToken:'synthetic-legacy-wechat'};fs.writeFileSync(f.store.file,JSON.stringify(f.store.data));
  const restored=f.reload();assert.equal(restored.data.aiSettings.apiKey,'synthetic-legacy-ai');assert.equal(f.disk().includes('synthetic-legacy'),false);assert.ok(JSON.parse(f.disk()).protectedSecrets);
});
test('余额记住与取消记住不回填秘密，服务关闭保留记忆，清除同时移除磁盘凭据',t=>{
  const f=fixture(t),w=new Wallet({store:f.store});w.setToken('synthetic-wallet-persist',{rememberToken:true});assert.equal(w.publicState().rememberToken,true);w.close();
  const restored=new Wallet({store:f.reload()});assert.equal(restored.publicState().configured,true);restored.setToken('',{rememberToken:false});assert.equal(restored.publicState().configured,true);assert.equal(new Wallet({store:f.reload()}).publicState().configured,false);
  restored.setToken('synthetic-wallet-persist',{rememberToken:true});restored.clearToken();assert.equal(restored.publicState().configured,false);assert.equal(f.reload().data.walletSettings.rememberToken,false);
});
test('系统保护失败时撤销凭据修改且不创建明文临时文件，核心无Key配置仍可用',t=>{
  const f=fixture(t),unavailable=systemSecretProtector({platform:'linux'});f.store.secretStorage.protector=unavailable;const ai=new AiAssistant(f.store);
  assert.throws(()=>ai.saveSettings({enabled:true,rememberKey:true,apiKey:'sk-synthetic-denied-123456'}),{code:'CREDENTIALS_UNAVAILABLE'});assert.equal(ai.publicState().hasKey,false);assert.equal(fs.existsSync(f.store.file),false);assert.equal(fs.existsSync(f.store.file+'.tmp'),false);
  ai.saveSettings({enabled:true,rememberKey:false,apiKey:'sk-synthetic-memory-123456'});assert.equal(ai.publicState().ready,true);assert.equal(f.disk().includes('sk-synthetic'),false);ai.close();
});

