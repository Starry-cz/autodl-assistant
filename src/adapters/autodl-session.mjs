// 登录检测仅使用网页可见信号，不读取输入值、Cookie 或账号资料。
export const SESSION_DETAILS = Object.freeze({
  not_open: { label: '未打开登录', message: '先打开专用浏览器，在 AutoDL 官方页面完成登录。' },
  unchecked: { label: '登录待检查', message: '浏览器已打开。完成登录后，请点击“检查登录状态”。' },
  checking: { label: '正在检查', message: '正在只读检查 AutoDL 实例列表，不会创建、开机或租用 GPU。' },
  ready: { label: '会话可用', message: '已确认 AutoDL 登录。资源同步与任务在后台运行，可以留在当前助手页面。' },
  login_required: { label: '未登录', message: '请从账号入口点击“打开登录”，在专用窗口完成 AutoDL 登录后检查连接。' },
  expired: { label: '登录已失效', message: '先前可用的会话已失效或已退出。请从账号入口点击“打开登录”，完成登录并检查后手动恢复任务。' },
  human_required: { label: '待人工验证', message: 'AutoDL 要求人工验证。请从账号入口点击“打开登录”，在专用窗口完成验证后检查连接；已经打开的验证页面会保留。' },
  unknown: { label: '无法确认', message: '页面尚未加载完成或结构无法识别，请稍后重新检查；需要人工处理时从账号入口点击“打开登录”。' },
  network_blocked: { label: '网络访问受限', message: '专用浏览器访问 AutoDL 被网络策略拒绝。请退出旧服务，从项目文件夹双击“启动监测台.cmd”重新启动，再打开登录；若仍失败，请检查浏览器的代理、防火墙或组织网络策略。' },
  error: { label: '检查未完成', message: '网络或页面异常导致检查未完成。请稍后重试；这不等于登录已失效。' },
  closed: { label: '浏览器已关闭', message: '专用浏览器已关闭，本机保存的会话未删除。重新打开后请检查登录。' },
});

// 仅识别 Chromium 的访问拒绝码，不把超时、DNS 故障或登录过期混为一谈。
export function isNetworkAccessDenied(error) {
  return /\b(?:net::)?ERR_(?:NETWORK_ACCESS_DENIED|ACCESS_DENIED|BLOCKED_BY_ADMINISTRATOR)\b/.test(String(error?.message || ''));
}

export function classifySessionSnapshot(snapshot, { previouslyReady = false } = {}) {
  let url;
  try { url = new URL(snapshot.url); } catch { return 'unknown'; }
  // 非官方页面、错误页和仅有控制台地址均不能成为登录成功的证据。
  if (url.origin !== 'https://www.autodl.com') return 'unknown';
  if (snapshot.humanRequired) return 'human_required';
  const loginRoute = /\/(?:login|register|signin)(?:[/.]|$)/i.test(url.pathname)
    || /(?:^#\/?|\/)(?:login|register|signin)(?:[/?]|$)/i.test(url.hash);
  if (loginRoute || snapshot.loginForm) return previouslyReady ? 'expired' : 'login_required';
  const instanceList = url.pathname.replace(/\/+$/, '') === '/console/instance/list';
  return instanceList && snapshot.consoleReady && !snapshot.loading ? 'ready' : 'unknown';
}

export async function readSessionSnapshot(page) {
  const signals = await page.evaluate(() => {
    const visible = node => {
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = selector => [...document.querySelectorAll(selector)].filter(visible);
    const textOf = node => (node.innerText || node.textContent || '').trim();
    const text = document.body?.innerText || '';
    const loginButton = nodes('button, [role="button"], input[type="submit"]').some(node =>
      /^(?:登\s*录|立即登录|登录\s*[\/／]\s*注册|登录并注册)$/.test(textOf(node)));
    const loginFields = nodes('input[type="password"], input[type="tel"], input[autocomplete="username"], input[placeholder*="手机号"], input[placeholder*="验证码"]').length > 0;
    const loginCopy = /验证码登录|密码登录|账号登录|扫码登录|微信登录|手机登录|手机号登录/.test(text);
    const humanPrompt = /请(?:先)?完成.{0,12}(?:安全|人机)?验证|拖动滑块|向右滑动.{0,12}验证|拖动.{0,12}拼图/;
    const humanRequired = humanPrompt.test(text) || nodes('[role="dialog"], .el-dialog, .geetest_panel, .geetest_window, .nc-container, .yidun_modal')
      .some(node => /安全验证|人机验证/.test(textOf(node)));
    // 短信“验证码登录”是正常登录方式，不等于滑块/人机验证。
    const loginForm = loginButton && (loginFields || loginCopy);
    const loading = nodes('.el-loading-mask, [aria-busy="true"]').length > 0;
    const headers = nodes('th, [role="columnheader"]').map(textOf).join(' ');
    const instanceHeaders = /实例/.test(headers) && /状态|配置|GPU|操作/i.test(headers);
    const instanceHeading = /容器实例|实例列表|我的实例/.test(text);
    const rows = nodes('table tbody tr, [role="rowgroup"] [role="row"]').some(node => textOf(node).length > 0);
    const empty = nodes('.el-table__empty-text, .ant-empty-description, [role="status"]').some(node =>
      /^(?:暂无数据|暂无实例|暂无记录|无数据)$/.test(textOf(node)));
    return { humanRequired, loginForm, loading, consoleReady: instanceHeading && instanceHeaders && (rows || empty) };
  });
  // 不向调用者返回正文、输入值、账户信息或查询参数。
  const url = new URL(page.url());
  return { ...signals, url: `${url.origin}${url.pathname}${url.hash.split('?')[0]}` };
}

