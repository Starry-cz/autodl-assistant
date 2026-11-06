import { AppError } from '../errors.mjs';

// 只读接口事实来自 AutoDL 公开前端；请求在本项目专用页面中完成，网页 Token 不离开页面。
// instance-monitor.26dc789c.js / components.27efcd29.js / index.1981ed6c.js（2026-11-05核对）。
export async function readObservatoryInPage({ kind, params }) {
  const endpoints = {
    instances: { method: 'POST', path: '/api/v1/instance' },
    wallet: { method: 'GET', path: '/api/v1/wallet' },
    monitor: { method: 'GET', path: '/api/v1/instance/monitor' },
    bills: { method: 'POST', path: '/api/v1/bill/list' },
  };
  const endpoint = endpoints[kind];
  if (!endpoint || location.origin !== 'https://www.autodl.com') return { error: 'SESSION' };
  try {
    const token = localStorage.getItem('token');
    if (!token) return { error: 'AUTH' };
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const app = JSON.parse(localStorage.getItem('app_version') || '{"version":"0.0.0"}');
    // 官网对本轮四个接口统一使用子账号前缀；不把主账号钱包错误地展示给子账号。
    const prefix = user?.sub_name ? '/api/v1/sub_user' : '/api/v1';
    const url = new URL(endpoint.path.replace('/api/v1', prefix), location.origin);
    if (kind === 'monitor') url.searchParams.set('instance_uuid', params.instanceId);
    const headers = { Authorization: token, AppVersion: String(app.version || '0.0.0') };
    if (endpoint.method === 'POST') headers['Content-Type'] = 'application/json';
    const response = await fetch(url.href, { method: endpoint.method, headers, credentials: 'include',
      redirect: 'error', signal: AbortSignal.timeout(15000),
      ...(endpoint.method === 'POST' ? { body: JSON.stringify(params) } : {}) });
    if (response.status === 401 || response.status === 403) return { error: 'AUTH' };
    if (!response.ok) return { error: 'API' };
    const result = await response.json();
    if (result?.code === 'AuthorizeFailed') return { error: 'AUTH' };
    if (result?.code !== 'Success') return { error: 'API' };
    const data = result.data;
    if (!data || typeof data !== 'object') return { error: 'SCHEMA' };
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && Object.hasOwn(value, key)
      && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))).map(key => [key, value[key]]));
    const usageKeys = ['mem_limit', 'mem_usage', 'mem_usage_percent', 'cpu_usage_percent',
      'root_fs_total_size', 'root_fs_used_size', 'data_disk_total_size', 'data_disk_used_size'];
    if (kind === 'wallet') return { data: pick(data, ['assets', 'blocked_asset', 'voucher_balance']) };
    if (kind === 'monitor') return { data: { ...pick(data, ['uuid', 'instance_name', 'gpu_number', 'cpu_number']), UsageInfo: pick(data.UsageInfo, usageKeys) } };
    if (!Array.isArray(data.list)) return { error: 'SCHEMA' };
    // 不把原始响应带回服务：实例响应可能含 SSH 密码和 Jupyter 地址，本功能只需要下列字段。
    const list = data.list.map(row => kind === 'instances' ? {
      ...pick(row, ['uuid', 'name', 'status', 'start_mode', 'region_name', 'region_sign', 'gpu_type_name', 'req_gpu_amount',
        'machine_id', 'gpu_idle_num', 'gpu_all_num', 'created_at', 'root_fs_total_size', 'root_fs_used_size']),
      usage_info: pick(row.usage_info, usageKeys),
    } : {
      ...pick(row, ['uuid', 'id', 'product_uuid', 'bill_type', 'asset', 'created_at']),
      details: pick(row.details, ['charge_from']),
    });
    return { data: { list, result_total: Number.isSafeInteger(data.result_total) && data.result_total >= 0 ? data.result_total : null } };
  } catch {
    // 平台正文和异常可能包含凭据，不向 Node、日志或前端转发。
    return { error: 'NETWORK' };
  }
}

export async function readAutodlObservatory(adapter, kind, params = {}) {
  const page = adapter.page;
  if (adapter.session?.state !== 'ready' || !page || page.isClosed() || !page.url().startsWith('https://www.autodl.com/'))
    throw new AppError('OBSERVATORY_SESSION', '请先在专用浏览器完成 AutoDL 登录并检查状态', { status: 409 });
  let result;
  try { result = await page.evaluate(readObservatoryInPage, { kind, params }); }
  catch { throw new AppError('OBSERVATORY_UNAVAILABLE', 'AutoDL 只读查询未完成，请检查专用浏览器后重试', { status: 503 }); }
  if (result?.error === 'AUTH') {
    adapter.setSession('expired', { checked: true });
    throw new AppError('OBSERVATORY_AUTH', 'AutoDL 网页登录已失效，请重新登录并检查状态', { status: 409 });
  }
  if (result?.error || !result?.data)
    throw new AppError('OBSERVATORY_UNAVAILABLE', 'AutoDL 只读接口暂不可用或返回格式已变化，请稍后刷新', { status: 503 });
  return result.data;
}
