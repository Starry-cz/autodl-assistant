import { chromium } from 'playwright';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { isNetworkAccessDenied } from '../src/adapters/autodl-session.mjs';

// 只访问公共首页；临时无痕浏览器，不启动服务、不读 .runtime、不使用账号。
const HOMEPAGE = 'https://www.autodl.com/';
const codeOf = error => String(error?.message || '').match(/\bERR_[A-Z_]+\b/)?.[0]
  || (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED');
console.log('AutoDL 公共网络诊断：不登录账号，不创建或操作实例。');
const results = await Promise.allSettled([
  (async () => {
    try {
      const response = await fetch(HOMEPAGE, { method: 'HEAD', signal: AbortSignal.timeout(15000), redirect: 'follow' });
      return { name: 'Node 公共连接', ok: response.ok, status: response.status };
    } catch (error) { return { name: 'Node 公共连接', ok: false, code: codeOf(error) }; }
  })(),
  (async () => {
    let browser;
    try {
      const adapter = new AutoDLBrowserAdapter('unused-network-diagnostic-profile');
      const options = await adapter.launchChannel(chromium);
      browser = await chromium.launch({ ...options, headless: true, chromiumSandbox: true, timeout: 15000 });
      const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
      const page = await context.newPage();
      const response = await page.goto(HOMEPAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return { name: '专用浏览器公共连接', browser: options.channel || 'Playwright Chromium', ok: !!response?.ok(), status: response?.status() };
    } catch (error) {
      return { name: '专用浏览器公共连接', ok: false, code: codeOf(error), accessDenied: isNetworkAccessDenied(error) };
    } finally { await browser?.close().catch(() => {}); }
  })(),
]);
let failed = false;
for (const result of results) {
  const value = result.status === 'fulfilled' ? result.value : { name: '诊断', ok: false, code: 'DIAGNOSTIC_FAILED' };
  console.log(JSON.stringify(value));
  failed ||= !value.ok;
}
console.log(failed
  ? '若由受限工具或沙箱启动，请在普通 PowerShell 中运行 npm.cmd run diagnose:network 作对照；不要关闭全局防火墙或绕过组织策略。'
  : '公共网络可达。此结果不代表已经登录 AutoDL，请在监测台手动打开登录并核验。');
process.exitCode = failed ? 1 : 0;

