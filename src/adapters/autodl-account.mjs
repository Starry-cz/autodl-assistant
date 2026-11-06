import { AppError } from '../errors.mjs';
import { normalizeAccountIdentity } from '../account-scope.mjs';

// 来源：官网 service-code.bb17a80f.js 的 getUserDetails，以及 index.54faf558.js 子账号资料页。
// 只用 localStorage.user 判断官网路由；账号ID和昵称必须来自本次已鉴权的只读资料响应。
export async function readIdentityInPage() {
  if (location.origin !== 'https://www.autodl.com') return { error: 'SESSION' };
  try {
    const token = localStorage.getItem('token');
    if (!token) return { error: 'AUTH' };
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const kind = user?.sub_name ? 'sub' : 'main';
    const app = JSON.parse(localStorage.getItem('app_version') || '{"version":"0.0.0"}');
    const response = await fetch(kind === 'sub' ? '/api/v1/sub_user' : '/api/v1/user/detail', {
      method: 'GET', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: token, AppVersion: String(app.version || '0.0.0') },
    });
    if (response.status === 401 || response.status === 403) return { error: 'AUTH' };
    if (!response.ok) return { error: 'API' };
    const result = await response.json();
    if (result?.code === 'AuthorizeFailed') return { error: 'AUTH' };
    if (result?.code !== 'Success') return { error: 'API' };
    // 用户在专用浏览器切换账号时，不让旧请求的回复覆盖新会话。
    if (localStorage.getItem('token') !== token) return { error: 'CHANGED' };
    const data = result.data;
    if (typeof data?.uuid !== 'string' || !data.uuid.trim() || kind === 'sub' && (typeof data.sub_name !== 'string' || !data.sub_name.trim()))
      return { error: 'SCHEMA' };
    let displayName = kind === 'sub' ? data.user_name : data.username;
    if (typeof displayName !== 'string' || /^\+?[\d\s()-]{7,}$/.test(displayName.trim())) displayName = null;
    // 白名单投影在页面内完成：token、电话、邮箱、实名等资料均不会进入 Node。
    return { data: { accountId: data.uuid, subAccountId: kind === 'sub' ? data.sub_name : null, displayName, kind } };
  } catch {
    return { error: 'NETWORK' };
  }
}

export async function readAutodlIdentity(adapter) {
  const page = adapter.page;
  if (adapter.session?.state !== 'ready' || !page || page.isClosed() || !page.url().startsWith('https://www.autodl.com/'))
    throw new AppError('ACCOUNT_SESSION', '请先在专用浏览器完成登录并检查状态', { status: 409 });
  let result;
  try { result = await page.evaluate(readIdentityInPage); }
  catch { throw new AppError('ACCOUNT_IDENTITY', '当前账号身份未能读取，请重新检查登录', { status: 409 }); }
  if (result?.error === 'AUTH') {
    adapter.setSession('expired', { checked: true });
    throw new AppError('ACCOUNT_AUTH', 'AutoDL 登录已失效，请重新登录', { status: 409 });
  }
  if (result?.error || !result?.data)
    throw new AppError('ACCOUNT_IDENTITY', result?.error === 'CHANGED' ? '查询期间账号已切换，请重新检查登录' : '当前账号身份未能确认，请重新检查登录', { status: 409 });
  return normalizeAccountIdentity(result.data);
}
