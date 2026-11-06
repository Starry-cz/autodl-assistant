import { fail } from './errors.mjs';
// 仅支持各人在自己电脑运行。此校验不把回环地址当作多用户身份认证。
export function assertLocalRequest(req) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
    fail('LOCAL_ONLY','此服务仅接受本机直接访问',{status:403});
  const host=req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) fail('HOST','此服务仅接受本机访问',{status:403});
  let authority;
  try { authority=new URL('http://'+host); } catch { fail('HOST','本地访问地址无效',{status:403}); }
  if (Number(authority.port || 80)!==req.socket.localPort) fail('HOST','本地访问端口不匹配',{status:403});
  if (Object.keys(req.headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-')))
    fail('PROXY','本地控制台不接受代理转发请求',{status:403});
  if (req.headers.origin && req.headers.origin!==authority.origin) fail('ORIGIN','不接受跨来源请求',{status:403});
  const site=req.headers['sec-fetch-site'];
  const navigation=req.method==='GET' && req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document';
  if (site && !['same-origin','none'].includes(site) && !navigation)
    fail('ORIGIN','不接受其他网站或端口发起的控制台请求',{status:403});
  if (!req.url.startsWith('/') || req.url.startsWith('//')) fail('URL','请求地址无效',{status:400});
  return host;
}

