import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalRequest } from '../src/local-access.mjs';
import { testConfig } from './fixtures/config.mjs';
const request=(headers={},socket={})=>({headers:{host:'127.0.0.1:8787',...headers},socket:{remoteAddress:'127.0.0.1',localPort:8787,...socket},method:'GET',url:'/api/state'});
test('回环请求允许本机IP及localhost，拒绝伪造Host和错误端口',()=>{
  for(const host of ['127.0.0.1:8787','localhost:8787'])assert.equal(assertLocalRequest(request({host})),host);
  for(const host of ['untrusted.example.test:8787','127.0.0.1:9999','localhost','127.0.0.1.evil.test:8787','localhost:99999'])assert.throws(()=>assertLocalRequest(request({host})),e=>e.status===403);
});
test('伪造回环Host不能放行远端连接，IPv6回环可用',()=>{
  for(const remoteAddress of ['192.0.2.5','10.1.1.2','::ffff:192.0.2.5'])assert.throws(()=>assertLocalRequest(request({}, {remoteAddress})),{code:'LOCAL_ONLY'});
  for(const remoteAddress of ['::1','::ffff:127.0.0.1'])assert.equal(assertLocalRequest(request({}, {remoteAddress})),'127.0.0.1:8787');
});
test('转发头不会给本地控制台授予代理访问权限',()=>{
  for(const key of ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto'])assert.throws(()=>assertLocalRequest(request({[key]:'synthetic'})),{code:'PROXY'});
});
test('浏览器跨网站及跨端口子请求被拒绝，直接导航仍可打开页面',()=>{
  for(const site of ['cross-site','same-site'])assert.throws(()=>assertLocalRequest(request({'sec-fetch-site':site})),{code:'ORIGIN'});
  for(const origin of ['null','https://untrusted.example.test','http://127.0.0.1:8788'])assert.throws(()=>assertLocalRequest(request({origin})),{code:'ORIGIN'});
  assert.equal(assertLocalRequest(request({origin:'http://127.0.0.1:8787','sec-fetch-site':'same-origin'})),'127.0.0.1:8787');
  const navigation=request({'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});navigation.url='/';assert.equal(assertLocalRequest(navigation),'127.0.0.1:8787');
});
test('拒绝代理形式及协议相对的请求地址',()=>{
  for(const url of ['http://untrusted.example.test/api/state','//untrusted.example.test/api/state'])assert.throws(()=>assertLocalRequest({...request(),url}),{code:'URL'});
});
test('检查间隔为1到600秒整数，默认20秒；生产配置拒绝演练',()=>{
  assert.equal(testConfig().provider,'autodl');assert.equal(testConfig().pollSeconds,20);
  for(const pollSeconds of [1,2,14,15,20,600,'1','600'])assert.equal(testConfig({pollSeconds}).pollSeconds,Number(pollSeconds));
  for(const pollSeconds of [-1,0,0.5,1.5,14.9,601,Infinity,'abc'])assert.throws(()=>testConfig({pollSeconds}),/检查间隔/);
  assert.throws(()=>testConfig({provider:'demo'}),/仅支持真实 AutoDL/);
});

