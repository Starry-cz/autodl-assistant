import path from 'node:path';
import fs from 'node:fs/promises';
import { AppError, fail, redact, messageOf } from '../errors.mjs';
import { gpuKey, archCudaProblem, candidateReasons, verifyQuote, requiredDiskGB, wantsDataDisk } from '../matching.mjs';
import { parseHostRow, parseInstanceRow, parseQuoteText, parseGpuStockLabel, readInstanceRowElements } from './dom.mjs';
import { SESSION_DETAILS, classifySessionSnapshot, readSessionSnapshot, isNetworkAccessDenied } from './autodl-session.mjs';
import { validateCloneSource, validateBootSource } from '../instances.mjs';
import { IMAGE_LEVELS, normalizeImagePrefix, imageLabel, imageCuda, exactImagePath } from '../images.mjs';
import { readAutodlObservatory } from './autodl-observatory.mjs';
import { readAutodlIdentity } from './autodl-account.mjs';
import { readGpuCatalogApi, readMarketHostsApi } from './autodl-inventory.mjs';
import { resolveBrowserLaunchOptions } from '../browser.mjs';
const BASE = 'https://www.autodl.com';
const LIST = `${BASE}/console/instance/list`;
const escaped = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ALL_OPTION = /^全部(?:\s*[(（]\s*\d+\s*\/\s*\d+\s*[)）])?$/;
// 型号标签按名称定位，并容许库存计数变化；不同后缀（4090D、48GB 等）不会被匹配。
const optionPattern = name => new RegExp('^\\s*' + escaped(name).replace(/\s+/g, '\\s+') + '(?:\\s*[(（]\\s*\\d+\\s*\\/\\s*\\d+\\s*[)）])?\\s*$');
const LIMITED_RETRY = { retryable: true, maxRetries: 2 };
const RACE = { race: true };
// 登录失效、人工验证、网络被拒等会话问题：换页面重读解决不了，直接报给用户。
const SESSION_ERRORS = ['LOGIN_REQUIRED', 'HUMAN_REQUIRED', 'LOGIN_CHECK_REQUIRED', 'BROWSER_NETWORK_DENIED'];
// 克隆页地址由 AutoDL 克隆对话框生成（2026-10-29 读取其公开前端代码）：id 为源实例；
// copy_data_disk 勾选数据盘时为 "1"、不勾选时为空字符串（不是 "0"），页面按“非空即复制”处理；
// use_address 非空会把源实例的自定义服务地址转给新实例，本程序要求它为空。返回问题说明，没有问题时返回空字符串。
function cloneUrlProblem(url, c) {
  if (!/\/cloneInstance$/.test(url.pathname)) return '不是 AutoDL 克隆页';
  const id = url.searchParams.get('id') || '';
  if (id !== c.sourceId) return '中的源实例是“' + id.slice(0, 40) + '”，与任务的源实例“' + c.sourceId + '”不一致';
  const copying = !!url.searchParams.get('copy_data_disk');
  if (copying !== wantsDataDisk(c)) return wantsDataDisk(c) ? '没有勾选复制数据盘，与任务设置不一致' : '勾选了复制数据盘，与任务设置不一致';
  if (url.searchParams.get('use_address')) return '选择了把源实例的自定义服务地址转给新实例；本程序不改动源实例';
  return '';
}
// 已绑定的目标实例与任务不符时，写明是哪一项（只写页面上读到的地区、型号、卡数，不写实例 ID）。
function identityProblem(instance, t) {
  if (!instance) return '已不在实例列表中（或列表中读不到这一行）';
  const c = t.config, wrong = [];
  if (!instance.region || !c.regions.includes(instance.region)) wrong.push('地区为“' + (instance.region || '未知') + '”');
  if (gpuKey(instance.gpuModel) !== gpuKey(c.gpuModel)) wrong.push('型号为“' + (instance.gpuModel || '无法识别') + '”');
  if (instance.gpuCount !== c.gpuCount) wrong.push('卡数为 ' + (instance.gpuCount ?? '无法识别'));
  if (instance.id === c.sourceId) wrong.push('是源实例');
  return '在列表中' + (wrong.join('、') || '与任务不符') + '，任务要求 ' + c.regions.join('、') + ' · ' + c.gpuModel + ' × ' + c.gpuCount;
}
// 对账只使用实例身份列的主键；名称、备注中的字符串不能成为实例 ID。
const idsOf = i => i?.id ? [i.id] : [];
const isNew = (i, baseline) => idsOf(i).some(id => !baseline.has(id));
// 新实例的 ID：取基线中没有的那个片段。
const freshId = (i, baseline) => idsOf(i).find(id => !baseline.has(id)) || i.id;
const hasId = (i, id) => idsOf(i).includes(id);
// 平台拒绝创建时的提示：账户类问题需要人工处理，其余（库存不足、已被占用等）按竞争失败继续监测。
const ACCOUNT_PROBLEM = /余额|欠费|充值|实名|认证|权限|封禁|冻结|限额|上限|配额/;
// 点击后新出现的提示是否表示失败。AutoDL 的“该主机已租满”是无图标、标题为“错误”的通知（2026-10-29 用户截图）。
const FAILURE_TEXT = /已租满|已满|租满|售罄|不足|不可用|无法创建|创建失败|开机失败|失败|错误|异常|请更换/;
// 不是 Element 提示组件的新元素，只有出现这些明确的失败说法才算报错，避免把页面其他变化当成拒绝。
const STRONG_FAILURE_TEXT = /已租满|租满|已满|售罄|库存不足|资源不足|GPU不足|余额不足|无法创建|创建失败|开机失败|请更换主机/;
// AutoDL 下单前的架构提示（如“Blackwell架构的GPU（如50系列等）, 该架构的GPU需使用CUDA12.8及以上版本的CUDA”）。
// 这类问题换主机也解决不了，识别后停止任务并说明，不反复点击。
const ARCH_DIALOG = /架构的\s*GPU[\s\S]{0,60}需使用\s*CUDA\s*\d/;
// 点击“创建并开机”前标记已显示的提示与弹窗，并记录此后新加入页面的元素；点击后只读取新出现的。
// 不依赖某一种提示组件：任何新出现的浮层、表单校验错误或气泡确认框都会被读到并写入诊断。只读页面，不点击任何弹窗按钮。
function clickSignals([mode, pattern, strongPattern]) {
  const failure = new RegExp(pattern.source, pattern.flags), strong = new RegExp(strongPattern.source, strongPattern.flags);
  const seen = window.__autodlClickSeen ||= new WeakSet();
  const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clean = s => (s || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const text = el => clean((el.querySelector('.el-notification__content, .el-message__content, .el-message-box__message, .el-popconfirm__main, .el-dialog__body, .el-drawer__body') || el).innerText);
  const alerts = [...new Set(document.querySelectorAll('.el-message, .el-notification, [role="alert"]'))].filter(visible);
  // Element UI 与 Element Plus（AutoDL 当前页面使用）的弹窗、抽屉、气泡确认框；同一弹窗的外层与内层只算一次。
  const dialogs = [...document.querySelectorAll('.el-message-box__wrapper, .el-dialog__wrapper, .el-drawer__wrapper, .el-overlay-message-box, .el-message-box, .el-overlay-dialog, .el-dialog, .el-drawer, .el-popconfirm, [role="dialog"], [role="alertdialog"]')].filter(visible);
  const formErrors = [...document.querySelectorAll('.el-form-item__error')].filter(visible);
  if (mode === 'mark') {
    [...alerts, ...dialogs, ...formErrors].forEach(el => seen.add(el));
    window.__autodlClickAdded = [];
    window.__autodlClickObserver?.disconnect();
    window.__autodlClickObserver = new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && window.__autodlClickAdded.length < 300) window.__autodlClickAdded.push(n); });
    window.__autodlClickObserver.observe(document.body, { childList: true, subtree: true });
    return null;
  }
  const fresh = list => list.filter(el => !seen.has(el));
  const success = el => /--success|el-icon-success/.test(String(el.className) + ' ' + el.innerHTML) || /成功/.test(el.innerText || '');
  const failed = el => !success(el) && (/el-message--(?:error|warning)|el-notification--(?:error|warning)/.test(String(el.className)) || !!el.querySelector('.el-icon-error, .el-icon-warning, .el-notification__icon.el-icon-error, .el-notification__icon.el-icon-warning, .el-notification--error, .el-notification--warning')
    || /^(?:错误|失败|警告|提示)$/.test((el.querySelector('.el-notification__title')?.innerText || '').trim()) && failure.test(el.innerText || '') || failure.test(text(el)));
  // 其他组件实现的浮层：新加入、位置为 fixed/absolute（或在这样的容器内）且含明确失败说法。
  const floating = el => { for (let n = el, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) if (/fixed|absolute/.test(getComputedStyle(n).position)) return true; return false; };
  const added = (window.__autodlClickAdded || []).filter(el => visible(el) && !seen.has(el) && clean(el.innerText).length >= 2);
  const roots = added.filter(el => !added.some(other => other !== el && other.contains(el)));
  const newAlerts = fresh(alerts), knownNodes = [...newAlerts, ...dialogs, ...formErrors];
  const newDialogs = fresh(dialogs).filter((el, i, list) => !list.some(other => other !== el && other.contains(el)));
  const strongNew = roots.filter(el => !knownNodes.some(k => k.contains(el) || el.contains(k)) && floating(el) && strong.test(clean(el.innerText)));
  const button = [...document.querySelectorAll('button, [role="button"]')].find(el => clean(el.innerText) === '创建并开机');
  return { toasts: [...newAlerts.filter(failed).map(text), ...fresh(formErrors).map(text), ...strongNew.map(el => clean(el.innerText))].filter(Boolean),
    dialogs: newDialogs.map(text).filter(Boolean),
    others: [...newAlerts.filter(el => !failed(el)).map(el => String(el.className || el.tagName) + '：' + text(el)),
      ...roots.filter(el => floating(el) && !strongNew.includes(el) && !knownNodes.some(k => k.contains(el) || el.contains(k))).map(el => String(el.className || el.tagName).slice(0, 60) + '：' + clean(el.innerText).slice(0, 60))].slice(0, 4),
    button: button ? { disabled: !!button.disabled || button.classList.contains('is-disabled'), loading: button.classList.contains('is-loading') || !!button.querySelector('.el-icon-loading, .is-loading') } : null,
    path: location.pathname };
}
// 在页面中读取复选框；Element 组件同时比较原生勾选与组件样式，二者不一致视为状态未确认。
function readCheckboxes(labels, pattern) {
  const regex = pattern ? new RegExp(pattern.source, pattern.flags) : null;
  return labels.filter(label => !regex || regex.test(label.innerText.trim())).map(label => {
    const input = label.querySelector('input[type="checkbox"]'), wrap = label.querySelector('.el-checkbox__input');
    const native = input ? input.checked : null;
    const styled = wrap ? label.classList.contains('is-checked') || wrap.classList.contains('is-checked') : native;
    return { name: label.innerText.trim(), missing: !input, checked: input && native === styled ? native : null,
      disabled: !!input?.disabled || label.classList.contains('is-disabled') };
  });
}
// 本轮扫描摘要：只陈述实际读取的范围；首页模式未翻页时不声称已遍历全部。
function scanSummary({ config, hosts, regions, found, firstPageOnly, timing }) {
  const where = regions.map(r => r.region + (r.missing ? '（没有此型号，已跳过）' : r.unavailable ? '（' + r.unavailable + '当前不可选，已跳过）' : r.found ? '（读到第 ' + r.pages + ' 页命中）' : r.stalled ? '（翻页停滞，已读 ' + r.pages + ' 页）'
    : r.exhausted ? '（' + r.pages + ' 页，已到末页）' : '（仅读第 1 页）')).join('、');
  const s = ms => (ms / 1000).toFixed(1);
  const head = (firstPageOnly ? '首页快速检查' : '完整翻页检查') + '：' + config.gpuModel + ' × ' + config.gpuCount + '，' + where
    + '，共读取 ' + hosts.length + ' 台主机，用时 ' + s(timing.totalMs) + ' 秒（打开页面 ' + s(timing.openMs) + '、筛选 ' + s(timing.filterMs) + '、读列表 ' + s(timing.scanMs) + '）';
  if (found) return head + '；找到合格候选，停止扫描并立即核验配置报价';
  if (regions.length && regions.every(r => r.unavailable || r.missing)) return head + '；所选地区的地区、型号或卡数选项当前都不可选，下一轮继续检查';
  if (regions.some(r => r.stalled)) return head + '；翻页后内容没有变化，本轮未读完列表，下轮重新检查';
  if (regions.every(r => r.exhausted)) return head + '；所选地区列表均已读到末页，未找到符合条件的主机';
  return head + '；已读页面未找到符合条件的主机，后续页面' + (config.fullScanSeconds ? '约每 ' + config.fullScanSeconds + ' 秒' : '定期') + '完整翻页检查一次';
}
// 最终集合：恰好一个目标型号且确认勾选，“全部”及其他型号全部确认未勾选；状态未知不算通过。
const exactModelFilter = options => options.filter(option => option.target).length === 1
  && options.every(option => option.checked === (option.target === true));
function describeModelFilter(options) {
  const list = filter => options.filter(filter).map(option => '“' + option.name + '”');
  const checked = list(option => option.checked === true), unknown = list(option => option.checked === null);
  return [checked.length ? '当前勾选 ' + checked.slice(0, 8).join('、') : '当前没有勾选项',
    unknown.length ? '状态无法确认 ' + unknown.slice(0, 8).join('、') : '',
    options.some(option => option.target) ? '' : '未找到目标型号'].filter(Boolean).join('；');
}
// 抢卡与实例变更仍操作官网 DOM；登录完成后在后台浏览器运行，监控使用官网只读查询接口。
export class AutoDLBrowserAdapter {
  constructor(runtimeDir) {
    this.runtimeDir = path.resolve(runtimeDir);
    this.profileDir = path.join(this.runtimeDir, 'browser-profile');
    this.context = null; this.page = null; this.sessionPage = null; this.prepared = null; this.probed = null;
    this.browserMode = null;
    this.previouslyReady = false; this.checkboxTimeoutMs = 5000;
    // 点击“创建并开机”后的观察时长；按钮仍在加载时最多等到 clickLoadingMs。测试中可缩短。
    this.clickOutcomeMs = 15000; this.clickLoadingMs = 65000; this.clickPollMs = 100; this.rejectGraceMs = 1500; this.rejectRecheckMs = 4000;
    // 镜像菜单标签页：保留时长、复用时等待展开标记的上限；imageReuse=false 表示本次运行不再复用。
    this.imageTab = null; this.imageTabTimer = null; this.imageTabTtlMs = 120000; this.imageExpandMs = 5000;
    this.catalogTab = null;
    // 克隆页地址缓存（仅内存）：减少展开源实例菜单的次数。
    this.cloneCache = null; this.cloneCacheMs = 10 * 60000;
    // 别的任务已绑定的实例 ID（由任务引擎提供），对账时不把它们当成本任务的新实例。
    this.claimedIds = () => new Set();
    this.session = { state: 'not_open', ...SESSION_DETAILS.not_open, checkedAt: null };
    this.lastStatus = this.session.message;
  }
  setSession(state, { checked = false, message = null } = {}) {
    // readySince：本次进入“会话可用”的时间（例如每次检查登录通过后）；网页据此在登录后自动刷新一次型号目录。
    const readySince = state === 'ready' ? (this.session?.state === 'ready' ? this.session.readySince : Date.now()) : null;
    this.session = { state, ...SESSION_DETAILS[state], ...(message ? { message } : {}), checkedAt: checked ? Date.now() : this.session.checkedAt, ...(readySince ? { readySince } : {}) };
    if (state === 'ready') this.previouslyReady = true;
    this.lastStatus = this.session.message;
    return this.sessionStatus();
  }
  sessionStatus() {
    // browserOpen 表示自动化浏览器仍存活，并不表示桌面有可见窗口；服务端依赖它判断会话可用。
    const browserOpen = !!this.context && !!this.page && !this.page.isClosed();
    return { ...this.session, browserOpen, background: browserOpen && this.browserMode === 'background',
      loginWindowOpen: browserOpen && this.browserMode === 'login' };
  }
  async launchChannel(chromium) {
    return resolveBrowserLaunchOptions(chromium);
  }
  async launchContext(mode) {
    const { chromium } = await import('playwright');
    await fs.mkdir(this.profileDir, { recursive: true });
    // 两种模式使用相同的专用持久资料及浏览器通道，不导出凭据或复制到另一个资料目录。
    return chromium.launchPersistentContext(this.profileDir, {
      headless: mode === 'background', chromiumSandbox: true,
      viewport: mode === 'background' ? { width: 1440, height: 1000 } : null, locale: 'zh-CN',
      ignoreDefaultArgs: ['--disable-client-side-phishing-detection', '--disable-component-update'],
      ...await this.launchChannel(chromium),
    });
  }
  async browser(mode = 'background') {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.context) {
      try {
        this.context = await this.launchContext(mode);
        this.browserMode = mode;
      } catch (e) {
        this.setSession('error');
        if (e.code === 'BROWSER_MISSING') throw e;
        throw new AppError('BROWSER', /Executable.*exist|browser.*install/i.test(e.message)
          ? process.env.AUTODL_BROWSER_CHANNEL ? '指定的浏览器通道未安装，请检查 AUTODL_BROWSER_CHANNEL 和对应浏览器的安装。' : '浏览器组件尚未安装，请运行 npm.cmd run browser:install 后重试。'
          : '无法启动专用浏览器；请确认浏览器可用，且没有另一进程占用 .runtime/browser-profile');
      }
      const context = this.context;
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = null; this.page = null; this.sessionPage = null; this.prepared = null; this.probed = null; this.browserMode = null;
        clearTimeout(this.imageTabTimer); this.imageTab = null; this.catalogTab = null; this.cloneCache = null; this.setSession('closed');
      });
    }
    // 镜像菜单、型号目录标签页只用于读取，不作为任务主页面。
    const page = this.context.pages().find(p => !p.isClosed() && p !== this.imageTab && p !== this.catalogTab) || await this.context.newPage();
    this.page = page;
    page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(30000);
    page.on('close', () => {
      if (this.page !== page) return;
      this.page = null; this.prepared = null; this.probed = null; this.setSession('closed');
    });
    this.setSession('unchecked');
    return page;
  }
  async login() {
    try {
      // 用户点连接时先尝试已保存的会话；有效就直接留在后台，不额外弹登录窗口。
      if (!this.context || this.browserMode === 'background') {
        const savedPage = await this.browser('background');
        if (!savedPage.url().startsWith(`${BASE}/`)) await savedPage.goto(LIST, { waitUntil: 'domcontentloaded' });
        const checked = await this.checkLogin();
        if (checked.session.state === 'ready') return checked;
        await this.close();
      }
      const page = await this.browser('login');
      const target = this.sessionPage && !this.sessionPage.isClosed() ? this.sessionPage : page;
      // 已打开的登录/验证页面保留；网络拒绝恢复后允许重试失败的核验页。
      // 准备中的任务表单不因“打开登录”被刷新。
      const retryBlocked = this.session.state === 'network_blocked' && (target !== page || !this.prepared);
      if (!target.url().startsWith(`${BASE}/`) || retryBlocked) {
        await target.goto(LIST, { waitUntil: 'domcontentloaded' });
        if (target === page) { this.prepared = null; this.probed = null; }
        this.setSession('unchecked');
      }
      await target.bringToFront();
      return { message: this.session.message, session: this.sessionStatus() };
    } catch (error) {
      if (error instanceof AppError && error.code === 'BROWSER') throw error;
      const open = this.page && !this.page.isClosed();
      this.setSession(open ? isNetworkAccessDenied(error) ? 'network_blocked' : 'error' : 'closed');
      if (this.session.state === 'network_blocked')
        throw new AppError('BROWSER_NETWORK_DENIED', this.session.message, { status: 503 });
      throw new AppError('BROWSER_NAVIGATION', '无法打开 AutoDL 页面。请检查网络后重试，不会创建任何实例');
    }
  }
  async checkLogin() {
    if (!this.context || !this.page || this.page.isClosed()) {
      if (this.session.state !== 'not_open') this.setSession('closed');
      return { message: this.session.message, session: this.sessionStatus() };
    }
    const context = this.context;
    this.setSession('checking');
    try {
      // 先只读观察现有登录/验证页；人工交互过程中不导航、不新开验证码页。
      const isCheckPage = page => {
        if (!page || page.isClosed()) return false;
        try {
          const url = new URL(page.url());
          return url.origin === BASE && (url.pathname.replace(/\/+$/, '') === '/console/instance/list'
            || /\/(?:login|register|signin)(?:[/.]|$)/i.test(url.pathname)
            || /(?:^#\/?|\/)(?:login|register|signin)(?:[/?]|$)/i.test(url.hash));
        } catch { return false; }
      };
      let tab = this.sessionPage;
      const reusable = tab !== this.page && isCheckPage(tab);
      const interactionPage = reusable ? tab : isCheckPage(this.page) ? this.page : null;
      const interactionState = interactionPage ? classifySessionSnapshot(await readSessionSnapshot(interactionPage),
        { previouslyReady: this.previouslyReady }) : null;
      // 独立核验页可能停留在旧登录表单；主页面已加载实例列表时可确认登录，且不重置任何表单。
      const mainReady = reusable && ['login_required','expired'].includes(interactionState) && isCheckPage(this.page)
        && classifySessionSnapshot(await readSessionSnapshot(this.page), { previouslyReady: this.previouslyReady }) === 'ready';
      if (mainReady) {
        this.setSession('ready', { checked: true });
      } else if (['login_required','expired','human_required'].includes(interactionState)) {
        this.setSession(interactionState, { checked: true });
        if (this.browserMode !== 'background') await interactionPage.bringToFront();
      } else {
        // 没有未完成的人工交互时，再使用独立标签页读取实例列表正向证据。
        if (!reusable) {
          tab = await context.newPage();
          this.sessionPage = tab;
          tab.on('close', () => { if (this.sessionPage === tab) this.sessionPage = null; });
        }
        const response = await tab.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await tab.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const snapshot = await readSessionSnapshot(tab);
        const state = classifySessionSnapshot(snapshot, { previouslyReady: this.previouslyReady });
        const httpFailed = response && response.status() >= 400;
        this.setSession(httpFailed && !['login_required','expired','human_required'].includes(state) ? 'error' : state, { checked: true });
        if (this.browserMode !== 'background' && ['login_required','expired','human_required'].includes(state)) await tab.bringToFront();
      }
    } catch (error) {
      const open = this.context === context && this.page && !this.page.isClosed();
      this.setSession(open ? isNetworkAccessDenied(error) ? 'network_blocked' : 'error' : 'closed', { checked: true });
    }
    // 用户在检查过程中关闭主窗口时，不能把临时页结果当作仍可操作。
    if (this.context !== context || !this.page || this.page.isClosed()) this.setSession('closed');
    if (this.session.state === 'ready' && this.browserMode === 'login') await this.startBackground();
    return { message: this.session.message, session: this.sessionStatus() };
  }
  async startBackground() {
    const incomplete = '后台连接未完成。请从账号入口点击“打开登录”重新登录，然后检查连接；任务尚未恢复。';
    try {
      const expected = await this.readIdentity();
      // 先等可见进程完全退出，释放 profile 锁并保存本地存储；不能同时启动两份相同资料的浏览器。
      await this.close();
      const page = await this.browser('background');
      this.setSession('checking');
      const response = await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const state = classifySessionSnapshot(await readSessionSnapshot(page), { previouslyReady: true });
      this.setSession(response && response.status() >= 400 && !['expired','human_required'].includes(state) ? 'error' : state, { checked: true });
      if (this.session.state !== 'ready') {
        if (['unknown','error'].includes(this.session.state)) this.setSession(this.session.state, { checked: true, message: incomplete });
        return;
      }
      // 不凭持久资料存在就假定登录成功；工作浏览器必须仍是移交前同一账号。
      const actual = await this.readIdentity();
      if (actual.ownerId !== expected.ownerId) this.setSession('error', { checked: true, message: incomplete });
    } catch (error) {
      if (!['expired','human_required'].includes(this.session.state))
        this.setSession(isNetworkAccessDenied(error) ? 'network_blocked' : 'error', { checked: true, message: incomplete });
    }
  }
  async marketHosts(options) { return readMarketHostsApi(this, options); }
  async checkPage() {
    const snapshot = await readSessionSnapshot(this.page);
    const state = classifySessionSnapshot(snapshot, { previouslyReady: this.previouslyReady });
    if (['login_required','expired','human_required'].includes(state)) {
      this.setSession(state, { checked: true });
      fail(state === 'human_required' ? 'HUMAN_REQUIRED' : 'LOGIN_REQUIRED', this.session.message);
    }
    if (state === 'ready') this.setSession('ready', { checked: true });
    else if (new URL(snapshot.url).origin !== BASE || this.session.state !== 'ready') {
      this.setSession('unknown', { checked: true });
      fail('LOGIN_CHECK_REQUIRED', '尚未确认 AutoDL 登录。请在“连接 AutoDL”中检查登录状态，然后恢复任务');
    }
  }
  async settle() {
    // 初始空表也可能只是异步加载，不能将其立刻当作零库存/空基线。
    await this.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await this.page.waitForFunction(() => [...document.querySelectorAll('.el-loading-mask')]
      .every(e => !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden'), null, { timeout: 15000 })
      .catch(() => { throw new AppError('LOADING', 'AutoDL 资源列表仍在加载', { retryable: true }); });
    await sleep(400);
  }
  async goto(url) {
    const p = await this.browser();
    try { await p.goto(url, { waitUntil: 'domcontentloaded' }); await this.settle(); await this.checkPage(); }
    catch (e) { if (e instanceof AppError) throw e;
      if (isNetworkAccessDenied(e)) {
        this.setSession('network_blocked');
        throw new AppError('BROWSER_NETWORK_DENIED', this.session.message, { status: 503 });
      }
      if (/ERR_|Timeout.*exceeded|net::/i.test(e.message)) throw new AppError('NETWORK', 'AutoDL 页面暂时无法加载，将退避后重试', { retryable: true });
      throw e;
    }
  }
  radioLabel(name) {
    return this.page.locator('label[role="radio"]').filter({ hasText: new RegExp(`^\\s*${escaped(name)}\\s*$`) });
  }
  async radio(name) {
    const label = this.radioLabel(name);
    if (await label.count() !== 1) fail('DOM_CHANGED', `无法唯一定位选项“${name}”，请检查 AutoDL 页面是否更新`);
    const input = label.locator('input[type="radio"]');
    if (!(await input.isEnabled())) fail('OPTION_DISABLED', `AutoDL 选项“${name}”不可用`);
    // 已选中时页面没有变化，不必再等待列表重新加载。
    if (await input.isChecked()) return;
    await label.click();
    await this.settle();
    if (!(await input.isChecked())) fail('DOM_CHANGED', `未能选中“${name}”`);
  }
  // control 读取匹配项并点击；name 用于错误提示，便于判断具体是哪个选项未生效。
  checkboxControl(label) {
    return { read: () => label.evaluateAll(readCheckboxes), click: () => label.click({ timeout: 5000 }) };
  }
  modelOptionControl(name) {
    const pattern = optionPattern(name), arg = { source: pattern.source, flags: pattern.flags };
    const labels = () => this.page.locator('label.el-checkbox');
    return {
      read: () => labels().evaluateAll(readCheckboxes, arg),
      // 点击前再次核对同一节点的可见文字，避免重渲染后按旧位置点错型号。
      click: async () => {
        const handles = await labels().elementHandles();
        try {
          const matched = [];
          for (const handle of handles) if (pattern.test((await handle.innerText()).trim())) matched.push(handle);
          if (matched.length !== 1) fail('CHECKBOX_STATE', '点击前型号选项“' + name + '”已变化（找到 ' + matched.length + ' 个），未点击；本次未提交', LIMITED_RETRY);
          await matched[0].click({ timeout: 5000 });
        } finally { await Promise.all(handles.map(handle => handle.dispose().catch(() => {}))); }
      },
    };
  }
  async checkbox(label, checked, name = '复选框') { return this.setCheckbox(this.checkboxControl(label), checked, name); }
  async setCheckbox(control, checked, name) {
    const want = checked ? '勾选' : '取消勾选';
    const describe = rows => rows.length !== 1 ? '页面上有 ' + rows.length + ' 个同名选项'
      : rows[0].checked === null ? '原生勾选与页面样式不一致' : rows[0].checked ? '仍为勾选' : '仍为未勾选';
    const settled = rows => rows.length === 1 && (rows[0].missing || rows[0].checked !== null);
    let rows = await control.read();
    for (const deadline = Date.now() + this.checkboxTimeoutMs; !settled(rows) && Date.now() < deadline;) { await sleep(100); rows = await control.read(); }
    if (rows.length !== 1) fail('DOM_CHANGED', '无法唯一定位复选框“' + name + '”（找到 ' + rows.length + ' 个），请检查 AutoDL 页面是否更新');
    if (rows[0].missing) fail('DOM_CHANGED', '复选框“' + name + '”缺少可核验的勾选控件，请检查 AutoDL 页面是否更新');
    if (rows[0].checked === null) fail('CHECKBOX_STATE', '复选框“' + name + '”的原生勾选与页面样式不一致，无法确认当前状态；本次未提交', LIMITED_RETRY);
    // 已是所需状态时不点击，即使平台把它设为只读也无需改动。
    if (rows[0].checked === checked) return;
    if (rows[0].disabled) fail('OPTION_DISABLED', 'AutoDL 选项“' + name + '”当前不可用，无法' + want + '；本次未提交');
    // 自己判定的“点击前已变化”表示没有点击，直接停止；浏览器异常无法确定是否已点击，只等待、不重复点击。
    let uncertain = false;
    try { await control.click(); }
    catch (error) {
      if (error instanceof AppError || this.page?.isClosed?.()) throw error;
      uncertain = true;
    }
    // 平台可能异步提交勾选结果：只等待、不重复点击，以免把已生效的选择又点回去。
    for (const deadline = Date.now() + this.checkboxTimeoutMs; ;) {
      rows = await control.read();
      if (rows.length === 1 && rows[0].checked === checked) return;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    fail('CHECKBOX_STATE', '复选框“' + name + '”' + (uncertain ? '点击时页面已变化，' : '') + '未按要求' + want + '（等待 ' + Math.round(this.checkboxTimeoutMs / 1000) + ' 秒后' + describe(rows) + '）；本次未提交', LIMITED_RETRY);
  }
  async readInstancePage(expectedModel = '') {
    const raw = await this.page.locator('table tbody tr').evaluateAll(readInstanceRowElements);
    const texts = raw.map(row => row.text), nonempty = raw.filter(row => row.text.trim());
    if (!nonempty.length) {
      const emptyLabels = await this.page.locator('.el-table__empty-text:visible').allInnerTexts();
      if (!emptyLabels.some(text => /^(?:暂无数据|暂无实例|暂无记录|无数据)$/.test(text.trim())))
        throw new AppError('LIST_LOADING', '实例列表尚无可核实的内容或空态，稍后重新读取，不会以空基线提交', { retryable: true });
      return { texts, instances: [], rows: [] };
    }
    const instances = nonempty.map(row => parseInstanceRow(row.text, expectedModel, row.instanceId));
    if (instances.some(instance => !instance))
      fail('DOM_CHANGED', '实例列表包含无法识别的行，已停止以免漏记提交前实例；请核对 AutoDL 页面');
    return { texts, instances, rows: nonempty };
  }
  async readInstanceRow(row, expectedModel = '') {
    const values = await row.evaluateAll(readInstanceRowElements);
    if (values.length !== 1) fail('INSTANCE', '实例行已变化，请重新读取列表');
    return parseInstanceRow(values[0].text, expectedModel, values[0].instanceId);
  }
  // settled：调用方刚完成导航与加载等待时，跳过第一次重复等待。
  async scanInstances(expectedModel = '', { settled = false } = {}) {
    const rows = new Map();
    for (let turn = 0; turn < 100; turn++) {
      if (turn || !settled) { await this.settle(); await this.checkPage(); }
      const { texts, instances } = await this.readInstancePage(expectedModel);
      // 同一页重复的主键无法唯一定位，停止对账，不把不完整列表当作“未创建”。
      const page = new Map();
      for (const info of instances) {
        const other = page.get(info.id);
        if (other) fail('DOM_CHANGED', '实例列表中有两行使用同一实例 ID“' + info.id + '”，请核对页面后重试');
        page.set(info.id, info);
      }
      for (const info of instances) rows.set(info.id, info);
      const next = this.page.locator('.el-pagination .btn-next:visible');
      if (!(await next.count()) || !(await next.isEnabled())) return [...rows.values()];
      const before = texts.join('|'); await next.click();
      await this.page.waitForFunction(old => [...document.querySelectorAll('table tbody tr')].map(r => r.innerText).join('|') !== old, before, { timeout: 12000 });
    }
    fail('PAGE_LIMIT', '实例分页超过100页，请缩小账号中的实例规模后检查');
  }
  // goto 已等待并核验第一页；后续翻页仍逐页等待，不在同一页重复执行加载等待。
  async instances(expectedModel = '') { await this.goto(LIST); return this.scanInstances(expectedModel, { settled: true }); }
  // 由服务端现有 browserWork 串行调用；不导航、不新开浏览器、不读取开发者 Token。
  async observatoryInstances({ pageIndex = 1, pageSize = 100 } = {}) {
    return readAutodlObservatory(this, 'instances', { date_from: '', date_to: '', page_index: pageIndex, page_size: pageSize, status: [], charge_type: [] });
  }
  async observatoryWallet() { return readAutodlObservatory(this, 'wallet'); }
  async readIdentity() { return readAutodlIdentity(this); }
  async observatoryMonitor(instanceId) { return readAutodlObservatory(this, 'monitor', { instanceId }); }
  async observatoryBills({ dateFrom, dateTo, pageIndex = 1, pageSize = 500 }) {
    return readAutodlObservatory(this, 'bills', { order_uuid: '', sub_name: '', date_from: dateFrom, date_to: dateTo,
      page_index: pageIndex, page_size: pageSize, bill_type: '' });
  }
  async inspectBoot(t) {
    const { info } = await this.findInstanceRow(t.config.sourceId, t.config.gpuModel);
    return validateBootSource(t.config, info);
  }
  // 已核对 2026-11-05 官方公开前端 index.7d7f696b.js：普通实例“开机”先弹出
  // “确认开机吗？”；点击对话框“确定”才提交有卡开机，不使用“更多”里的无卡入口。
  async boot(t, mark) {
    const { row, info } = await this.findInstanceRow(t.config.sourceId, t.config.gpuModel);
    validateBootSource(t.config, info);
    if (!info.stopped || info.gpuAvailable === false) return { notSubmitted: true, message: '原实例状态或库存已变化，未点击开机' };
    const start = row.getByRole('button', { name: '开机', exact: true });
    if (await start.count() !== 1 || !await start.isEnabled()) fail('BOOT_BUTTON', '原实例的开机按钮不可用，请在 AutoDL 核对');
    await this.markClickSignals();
    await start.click();
    const dialog = this.page.locator('.el-message-box:visible').filter({ hasText: '确认开机吗？' });
    try { await dialog.waitFor({ state: 'visible', timeout: 8000 }); }
    catch {
      const signals = await this.clickSignals(), message = signals.dialogs[0] || signals.toasts[0];
      fail('BOOT_CONFIRM', message || '没有出现“确认开机吗？”对话框；未确认开机，请查看专用浏览器');
    }
    if (await dialog.count() !== 1) fail('BOOT_CONFIRM', '开机确认对话框不唯一，未确认');
    const confirm = dialog.getByRole('button', { name: '确定', exact: true });
    if (await confirm.count() !== 1 || !await confirm.isEnabled()) fail('BOOT_CONFIRM', '开机确认按钮不可用，未确认');
    await this.markClickSignals();
    // 费用确认前重新核对任务所属账号；异步身份查询结束后仍由同步 mark 记录点击边界。
    if (this.verifyTaskOwner) await this.verifyTaskOwner(t);
    mark();
    await confirm.click();
    for (let turn = 0; turn < 20; turn++) {
      const signals = await this.clickSignals(), message = signals.toasts[0] || signals.dialogs[0];
      if (message) {
        // 缺卡是唯一自动重新提交的拒绝；余额、实名等其它错误留给用户处理。
        if (!ACCOUNT_PROBLEM.test(message) && /已租满|GPU\s*(?:库存)?不足|(?:暂无|没有|无)\s*(?:可用|空闲)\s*(?:GPU|显卡)|(?:GPU|显卡)[^。；]{0,20}(?:库存不足|资源不足)|当前主机[^。；]{0,20}(?:库存不足|资源不足)/i.test(message))
          return { noStock: true, message: '平台明确提示缺卡：' + redact(message) + '；继续等待原实例' };
        if (ACCOUNT_PROBLEM.test(message) || /开机失败|无法开机/.test(message))
          return { rejected: true, message: '平台拒绝开机：' + redact(message) };
        fail('BOOT_UNCLEAR', '开机确认后出现未识别的提示：' + redact(message));
      }
      const current = await this.readInstanceRow(row, t.config.gpuModel);
      if (!hasId(current, t.config.sourceId)) fail('BOOT_UNCLEAR', '开机后目标行身份发生变化，只核对原实例');
      if (current?.running || current?.starting) return {};
      await sleep(500);
    }
    // 页面没有结果不能视为失败，交给引擎只读核对，不再次点击。
    return { unclear: true };
  }
  async findInstanceRow(id, expectedModel = '') {
    await this.goto(LIST);
    for (let turn=0; turn<100; turn++) {
      const page = await this.readInstancePage(expectedModel);
      const matched = page.instances.map((info, i) => ({ info, raw: page.rows[i] })).filter(({ info }) => info.id === id);
      if (matched.length > 1) fail('INSTANCE', '同一实例 ID 出现在多行，无法确定目标');
      if (matched.length === 1) {
        // 定位器也绑定身份列中的精确 UUID，避免表格重排后 nth 指向另一行。
        const { info, raw } = matched[0];
        const identity = this.page.locator(`td:nth-child(${raw.identityColumn + 1}) div[style*="cursor"][style*="pointer"]`).filter({ hasText: new RegExp('^' + escaped(id) + '$') });
        const row = this.page.locator('table tbody tr').filter({ has: identity });
        if (await row.count() !== 1) fail('INSTANCE', '目标实例的身份列已变化，请重新读取列表');
        return { row, info };
      }
      const next = this.page.locator('.el-pagination .btn-next:visible');
      if (!(await next.count()) || !(await next.isEnabled())) break;
      const before = await this.page.locator('table tbody tr').allInnerTexts(); await next.click();
      await this.page.waitForFunction(old => [...document.querySelectorAll('table tbody tr')].map(r=>r.innerText).join('|') !== old, before.join('|'));
      await this.settle();
    }
    fail('SOURCE_NOT_FOUND', '未在当前账号中找到指定实例，请核对完整 ID 与账号');
  }
  // 克隆入口：对源实例只做“更多 → 克隆实例 → 继续”三次点击，打开 AutoDL 的克隆页，不改动源实例。
  // 克隆页地址在内存中保留约10分钟，期间直接打开，不再反复展开源实例的菜单；地址或页面不符时重新走一遍菜单。
  async openClone(t) {
    const c = t.config, key = [t.id, c.sourceId, wantsDataDisk(c)].join('|'), cached = this.cloneCache;
    // 复制数据盘时克隆页地址里的源数据盘容量只沿用 1 分钟：期间源数据盘若被扩容，重新打开才能读到新容量。
    const maxAge = wantsDataDisk(c) ? Math.min(this.cloneCacheMs, 60000) : this.cloneCacheMs;
    if (cached?.key === key && Date.now() - cached.at < maxAge) {
      try { await this.goto(cached.url); return { ...cached.info, ...this.readClonePage(c) }; }
      catch (error) { if (!['CLONE_URL', 'COPY_DISK', 'DISK_UNKNOWN'].includes(error.code)) throw error; }
      this.cloneCache = null;
    }
    this.cloneCache = null;
    const { row, info } = await this.findInstanceRow(c.sourceId, c.gpuModel);
    validateCloneSource(c, info);
    // 点击前再核对这一行仍是源实例，避免列表重排后点到别的实例。
    if (!hasId(await this.readInstanceRow(row, c.gpuModel), c.sourceId)) fail('SOURCE_GUARD', '源实例所在行在点击前发生变化，未点击任何按钮');
    await this.cloneClick(row.getByRole('button', { name: '更多', exact: true }), '更多');
    const item = this.page.getByText('克隆实例', { exact: true }).filter({ visible: true });
    await item.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await item.count() !== 1) { await this.page.keyboard.press('Escape').catch(() => {}); fail('CLONE_DOM', '“更多”菜单中没有唯一的“克隆实例”（找到 ' + await item.count() + ' 个），未点击；请检查 AutoDL 页面是否更新'); }
    if (await item.evaluate(el => !!el.closest('.is-disabled, [aria-disabled="true"], [disabled]'))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      fail('SOURCE_UNAVAILABLE', 'AutoDL 中该实例的“克隆实例”当前不可用（需要源实例已关机）；程序不会开关机或改动源实例', { status: 409 });
    }
    await this.cloneClick(item, '克隆实例');
    const dialog = this.page.getByRole('dialog').filter({ hasText: '克隆实例' }).filter({ visible: true });
    await dialog.first().waitFor({ state: 'visible' });
    await this.checkCloneDialog(dialog);
    const copy = dialog.locator('label.el-checkbox').filter({ hasText: /^\s*数据盘\s*$/ });
    await this.checkbox(copy, wantsDataDisk(c), '数据盘');
    const next = dialog.getByRole('button', { name: '继续', exact: true });
    if (await next.count() !== 1) fail('CLONE_DOM', '克隆对话框中没有唯一的“继续”按钮，未继续');
    if (!(await next.isEnabled())) fail('CLONE_LIMIT', 'AutoDL 克隆对话框的“继续”不可用，可能今天的克隆次数已用完；源实例未受影响');
    await this.cloneClick(next, '继续');
    await this.page.waitForURL('**/cloneInstance?**'); await this.settle();
    const page = this.readClonePage(c);
    this.cloneCache = { key, url: this.page.url(), info, at: Date.now() };
    return { ...info, ...page };
  }
  // 只允许点击这三个文字完全相同的按钮；点击前再读一次文字，不符就不点。
  async cloneClick(locator, label) {
    if (!['更多', '克隆实例', '继续'].includes(label)) fail('SOURCE_GUARD', '克隆流程不允许点击“' + label + '”');
    if (await locator.count() !== 1) fail('CLONE_DOM', '没有唯一的“' + label + '”可点击，未点击');
    const text = (await locator.innerText()).trim().replace(/\s+/g, '');
    if (text !== label) fail('SOURCE_GUARD', '要点击的元素文字是“' + text.slice(0, 20) + '”，不是“' + label + '”，未点击');
    await locator.click();
  }
  // AutoDL 克隆对话框写明“克隆后源实例不受影响，不会释放也不会清理数据”；看不到这句或选中了“克隆给他人”就停止。
  async checkCloneDialog(dialog) {
    const text = (await dialog.first().innerText()).replace(/\s+/g, '');
    if (!text.includes('源实例不受影响')) fail('CLONE_DOM', '克隆对话框中没有“克隆后源实例不受影响”的说明，页面可能已更新；未继续，源实例未改动');
    const others = dialog.locator('label').filter({ hasText: /^\s*克隆给他人\s*$/ });
    if (await others.count() && await others.first().evaluate(el => el.classList.contains('is-active') || el.classList.contains('is-checked') || !!el.querySelector('input:checked')))
      fail('CLONE_DOM', '克隆对话框选中了“克隆给他人”，本程序只克隆到自己的账号；未继续');
  }
  // 读取 AutoDL 克隆页地址中的源实例、数据盘与源环境 CUDA（克隆对话框写入，见 AutoDL 前端 clone-instance 路由）。
  readClonePage(c) {
    const url = new URL(this.page.url()), problem = cloneUrlProblem(url, c);
    if (problem) fail(/数据盘/.test(problem) ? 'COPY_DISK' : 'CLONE_URL', '克隆页面' + problem);
    const raw = url.searchParams.get('expand_size'), bytes = Number(raw || 0);
    // 复制数据盘时必须读到明确的源数据盘容量（纯数字）；为空或缺失时不能当作 0，否则目标数据盘可能装不下。
    if ((wantsDataDisk(c) && !/^\d+$/.test(raw || '')) || !Number.isFinite(bytes) || bytes < 0) fail('DISK_UNKNOWN', '无法核实源数据盘扩容容量');
    const sourceCuda = String(url.searchParams.get('image_cuda') || '').match(/1\d\.\d{1,2}/)?.[0];
    if (!sourceCuda) fail('CUDA_SOURCE', 'AutoDL 克隆页没有给出源实例镜像的 CUDA 版本，无法筛选宿主驱动；请在 AutoDL 核对源实例镜像');
    const arch = archCudaProblem(c.gpuModel, sourceCuda);
    if (arch) fail('CUDA_ARCH', arch + '。克隆会原样复制源实例的系统盘（CUDA、Python、PyTorch 不变），换到该型号上很可能无法运行；请改选其他 GPU 型号，或先在源实例中升级环境');
    return { extraDiskGB: Math.ceil(bytes / (1024 ** 3)), sourceCuda };
  }
  // 读取型号筛选：只纳入可解析为“型号(空闲/总数)”的选项和“全部”，不触碰扩容等其他复选框。
  async modelFilter(model) {
    const rows = await this.page.locator('label.el-checkbox').evaluateAll(readCheckboxes);
    return rows.flatMap(row => {
      if (ALL_OPTION.test(row.name)) return [{ ...row, kind: 'all' }];
      const parsed = parseGpuStockLabel(row.name)?.gpuModel;
      return parsed ? [{ ...row, kind: 'model', model: parsed, target: gpuKey(parsed) === gpuKey(model) }] : [];
    });
  }
  async selectModel(model) {
    const initial = await this.modelFilter(model), targets = initial.filter(option => option.target);
    // absent：当前地区的型号筛选里没有这个型号（多地区任务据此跳过该地区）；多个同名项仍按页面异常停止。
    if (!targets.length) throw new AppError('MODEL_MISSING', '当前地区的 GPU 型号筛选中没有“' + model + '”，请在表单中点“同步 AutoDL 型号”核对该地区的官方型号；不会改用其他显卡', { absent: true });
    if (targets.length !== 1) fail('MODEL_MISSING', '无法唯一找到指定 GPU 型号“' + model + '”，请核对官方完整名称；不会改用默认显卡');
    if (initial.filter(option => option.kind === 'all').length > 1) fail('MODEL_FILTER', '页面上有多个“全部”筛选，无法确定 GPU 型号筛选范围；未改动筛选，本次未提交');
    if (targets[0].disabled && targets[0].checked !== true) fail('OPTION_DISABLED', 'GPU 型号“' + targets[0].name + '”当前不可选；未改用其他型号，本次未提交');
    const control = option => option.kind === 'all' ? this.modelOptionControl('全部') : this.modelOptionControl(option.model);
    // 已经只选中目标型号时不点击、不等待重新加载。
    if (exactModelFilter(initial)) return;
    // 先勾选目标，再取消“全部”和其他型号：兼容“至少保留一项”和“全部”互斥等规则。
    // 每步都重新读取并按名称定位，页面重排或重渲染后不会沿用旧位置。
    let options = initial;
    for (let pass = 0; pass < 2; pass++) {
      // 同一轮内同一选项需要再次改动，说明页面撤销了刚才的选择：停止本轮，按最终集合判断，不来回点击。
      const acted = new Set();
      for (let step = 0; step <= options.length + 2; step++) {
        options = await this.modelFilter(model);
        const target = options.find(option => option.target);
        const next = !target ? null : target.checked !== true ? [target, true]
          : (() => { const extra = options.find(option => !option.target && option.checked !== false); return extra ? [extra, false] : null; })();
        const key = next && (next[0].kind === 'all' ? 'all' : next[0].model);
        if (!next || acted.has(key)) break;
        acted.add(key);
        await this.setCheckbox(control(next[0]), next[1], next[0].kind === 'all' ? '全部' : next[0].model);
      }
      await this.settle();
      options = await this.modelFilter(model);
      if (exactModelFilter(options)) return;
    }
    fail('MODEL_FILTER', 'GPU 型号筛选未能只保留“' + model + '”（' + describeModelFilter(options) + '）；可能被页面重置，本次未提交', LIMITED_RETRY);
  }
  async readHosts(region, expectedModel = '') {
    const raw = await this.page.locator('table tbody tr').evaluateAll(rows => rows.map(row => {
      const radio = row.querySelector('input[type="radio"]');
      return { id: radio?.value || '', disabled: radio?.disabled || false,
        cells: [...row.querySelectorAll('td')].map(td => td.innerText.trim()) };
    }).filter(row => row.id && row.cells.length >= 7));
    return raw.map(r => parseHostRow(r, region, expectedModel));
  }
  // 当前列表之后是否还有内容：可用的下一页按钮，或尚未滚到底的表格。
  async moreHosts() {
    const next = this.page.locator('.el-pagination .btn-next:visible');
    if (await next.count() && await next.isEnabled()) return 'page';
    const scrollable = await this.page.locator('.el-table__body-wrapper').evaluateAll(elements =>
      elements.some(el => el.scrollTop + el.clientHeight < el.scrollHeight - 1));
    return scrollable ? 'scroll' : null;
  }
  // firstPageOnly 只读当前第一页/首屏；untilId 用于提交前精确找回候选，始终可翻页。
  // skip：暂时不选的主机（最近被平台拒绝），不算命中，继续往后找。
  // 返回 exhausted 表示确实读到列表末尾；stalled 表示翻页后内容始终不变，不能当作已遍历。
  async scanHosts(region, { config = null, source = null, untilId = null, firstPageOnly = false, skip = () => false } = {}) {
    const hosts = new Map(); let previous = null, stable = 0, pages = 0, waiting = 0;
    for (let turn = 0; turn < 100; turn++) {
      await this.settle();
      const current = await this.readHosts(region, config?.gpuModel); current.forEach(h => hosts.set(h.id, h));
      const signature = current.map(h => h.id).join('|'), changed = signature !== previous;
      if (changed) pages++;
      stable = changed ? 0 : stable + 1; previous = signature;
      const result = extra => ({ hosts: [...hosts.values()], pages, exhausted: false, stalled: false, ...extra });
      const found = untilId ? hosts.has(untilId) : !!config && current.some(h => !skip(h) && !candidateReasons(h, config, source).length);
      if (found) return result({ found: true });
      // 点击下一页后内容还没变化：继续等待加载，不再次点击，以免跳过一页。
      if (waiting) {
        if (changed) waiting = 0;
        else if (waiting++ < 3) continue;
        else return result({ stalled: true });
      }
      const more = await this.moreHosts();
      if (firstPageOnly && !untilId && (more || stable >= 1)) return result({ exhausted: !more });
      if (more === 'page') { await this.page.locator('.el-pagination .btn-next:visible').click(); waiting = 1; continue; }
      // 滚动没有实际移动（例如容器不可滚动）时按已到底处理，不空转到上限。
      if (more === 'scroll' && await this.page.locator('.el-table__body-wrapper').evaluateAll(elements => {
        let moved = false;
        for (const el of elements) { const before = el.scrollTop; el.scrollTop += Math.max(200, el.clientHeight - 60); moved ||= el.scrollTop > before; }
        return moved;
      })) continue;
      // 列表末尾再读一次确认稳定，避免把仍在加载的空表当作遍历完成。
      if (stable >= 1) return result({ exhausted: true });
    }
    fail('PAGE_LIMIT', '资源列表扫描达到保护上限，请检查页面翻页控件');
  }
  async collectHosts(region, options = {}) { return (await this.scanHosts(region, options)).hosts; }
  async probe(t, { scope = 'full', skip = () => false } = {}) {
    this.prepared = null; this.probed = null;
    const started = Date.now(), firstPageOnly = scope === 'first-page';
    let catalogMs = 0;
    if (t.config.mode === 'create') {
      // 型号汇总只用于确认“所有目标地区空闲为零”；不足所需卡数、未知或缺项仍进入原主机精确扫描。
      // 请求失败直接交给引擎退避，不再额外导航 DOM 形成第二次请求；克隆保持原源实例校验流程。
      const catalog = await this.gpuCatalog(t.config.regions, { strict: true });
      catalogMs = Date.now() - started;
      const noStock = t.config.regions.every(region => {
        const row = catalog?.regions?.find(item => item.region === region);
        if (!row || row.missing || row.disabled || row.error) return false;
        const models = (row.models || []).filter(item => gpuKey(item.model) === gpuKey(t.config.gpuModel));
        if (models.length !== 1) return false;
        const model = models[0];
        return Number.isInteger(model.available) && Number.isInteger(model.total)
          && model.total >= 0 && model.available === 0;
      });
      if (noStock) {
        this.lastSource = null;
        return { source: null, hosts: [], complete: true, scope, catalogOnly: true,
          // 这里是精确型号在全部请求地区的汇总总卡数，不是扫描到的主机数量。
          catalogTotal: t.config.regions.reduce((sum, region) => sum + catalog.regions.find(row => row.region === region)
            .models.find(model => gpuKey(model.model) === gpuKey(t.config.gpuModel)).total, 0),
          summary: '型号汇总确认无空闲，本轮不进入主机列表',
          timing: { catalogMs, openMs: 0, filterMs: 0, scanMs: 0, totalMs: Date.now() - started } };
      }
    }
    const openStarted = Date.now();
    let source = null;
    if (t.config.mode === 'clone') source = await this.openClone(t);
    else await this.goto(`${BASE}/create`);
    const opened = Date.now();
    await this.radio('按量计费');
    const hosts = [], regions = []; let scanMs = 0;
    for (const region of t.config.regions) {
      // 多地区监测时，某个地区的型号筛选里没有此型号就跳过该地区；所有所选地区都没有才报错停止。
      // 地区、型号或卡数选项当前不可选（灰色）：本轮跳过该地区，不点击，下一轮再看；不当作页面故障停下任务。
      let step = '地区';
      try {
        await this.radio(region); step = '型号'; await this.selectModel(t.config.gpuModel);
        step = '卡数'; await this.radio(String(t.config.gpuCount));
      } catch (error) {
        if (error.code === 'OPTION_DISABLED') { regions.push({ region, pages: 0, exhausted: false, stalled: false, found: false, unavailable: step }); continue; }
        if (!error.absent || t.config.regions.length < 2) throw error;
        regions.push({ region, pages: 0, exhausted: true, stalled: false, found: false, missing: true });
        continue;
      }
      const scanStarted = Date.now();
      const scan = await this.scanHosts(region, { config: t.config, source, firstPageOnly, skip });
      scanMs += Date.now() - scanStarted;
      hosts.push(...scan.hosts); regions.push({ region, pages: scan.pages, exhausted: scan.exhausted, stalled: scan.stalled, found: !!scan.found });
      if (scan.found) break;
    }
    if (regions.length && regions.every(r => r.missing))
      fail('MODEL_MISSING', '所选地区（' + t.config.regions.join('、') + '）的 GPU 型号筛选中都没有“' + t.config.gpuModel + '”，请点“同步 AutoDL 型号”核对后重新选择；不会改用其他显卡或地区');
    // 源实例信息（地区、型号、数据盘、源环境 CUDA）随观察结果返回；克隆页地址只在适配器内存中。
    this.lastSource = source;
    const found = regions.some(r => r.found), complete = !found && regions.length === t.config.regions.length && regions.every(r => r.exhausted);
    // 命中时记住当前表单：同一轮 prepare 可直接在此页继续，不再重新打开页面和设置筛选。
    if (found) this.probed = { taskId: t.id, region: regions.at(-1).region, page: this.page, url: this.page.url?.() || '', at: Date.now() };
    const timing = { catalogMs, openMs: opened - openStarted, filterMs: Date.now() - opened - scanMs, scanMs, totalMs: Date.now() - started };
    const summary = scanSummary({ config: t.config, hosts, regions, found, firstPageOnly, timing });
    return { source, hosts, summary, scope, complete, timing };
  }
  async openImageMenu() {
    await this.radio('基础镜像');
    const cascader = this.page.locator('.el-cascader:visible');
    if (await cascader.count() !== 1) fail('IMAGE_DOM', '无法唯一定位基础镜像菜单，目前仅支持官方基础镜像');
    // 已展开时不再点击，以免把菜单收起。只读取可见 DOM，不访问页面私有状态。
    if (!(await this.page.locator('.el-cascader-menu:visible').count())) await cascader.locator('input').click();
    return cascader;
  }
  async imageLevel(level) {
    const menu = this.page.locator('.el-cascader-menu:visible').nth(level);
    await menu.waitFor({state:'visible'});
    const nodes = menu.locator('.el-cascader-node:visible');
    // 一次读取整级选项，避免逐个节点多次往返。
    const rows = await nodes.evaluateAll(list => list.map(el => ({
      text: (el.querySelector('.el-cascader-node__label') || el).innerText,
      disabled: el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.querySelector('input:disabled') })));
    const entries = [];
    rows.forEach((row, i) => {
      const label = imageLabel(row.text, level);
      if (!label || label === IMAGE_LEVELS[level]) return;
      if (entries.some(entry => entry.label === label)) fail('IMAGE_AMBIGUOUS', '官方镜像菜单存在同名选项“'+label+'”，已停止自动选择，请核对页面');
      entries.push({node:nodes.nth(i),label,disabled:row.disabled});
    });
    if (!entries.length) fail('IMAGE_EMPTY', IMAGE_LEVELS[level]+'菜单尚无可读取的选项，请重新同步');
    return entries;
  }
  // expanded：点击非末级选项后的确认，读取同步选项时用于保证下一级菜单属于刚点的分支。
  async chooseImagePath(parts, expanded = null) {
    for (let level=0; level<parts.length; level++) {
      const entries = await this.imageLevel(level), label = imageLabel(parts[level], level);
      const entry = entries.find(item => item.label === label && !item.disabled);
      if (!entry) {
        const available = entries.filter(item => !item.disabled).slice(0,12).map(item => item.label).join('、') || '暂无';
        fail('IMAGE_MISSING', '官方基础镜像的'+IMAGE_LEVELS[level]+'不支持“'+parts[level]+'”。当前可选：'+available+'。请在新建表单同步官方镜像，重新选择完整环境；旧任务不会自动更换版本');
      }
      await entry.node.click();
      if (expanded && level < 3) await expanded(entry.node, label);
    }
  }
  // Element 级联菜单展开完成后，节点带 in-active-path 且不再显示加载图标；此后下一级菜单才是该分支的选项。
  // strict（复用已打开的菜单）时必须看到该标记，否则无法排除上一分支残留的菜单；新开页面时最多等一会儿。
  async imageExpanded(node, label, { strict }) {
    const state = () => node.evaluate(el => ({ active: el.classList.contains('in-active-path') || el.classList.contains('is-active'),
      loading: !!el.querySelector('.el-icon-loading, .is-loading') })).catch(() => ({ active: false, loading: false }));
    const limit = strict ? this.imageExpandMs : this.imageSignal === false ? 0 : 1500, root = this.adapter || this;
    for (const deadline = Date.now() + limit; ; await sleep(50)) {
      const now = await state();
      if (now.active && !now.loading) { root.imageSignal = true; return; }
      if (Date.now() >= deadline) break;
    }
    if (strict) fail('IMAGE_REUSE', '复用镜像菜单时无法确认“' + label + '”已展开');
    if (this.imageSignal === undefined) root.imageSignal = false;
  }
  // 官方镜像菜单在单独标签页中读取，读完保留约2分钟：逐级选择时直接在已打开的菜单上展开下一级，
  // 不再每级重新打开创建页。点“同步官方镜像”（第一级）总是重新打开页面读取最新菜单。
  async imageOptions(prefix = []) {
    prefix = normalizeImagePrefix(prefix);
    clearTimeout(this.imageTabTimer);
    await this.browser();
    const context = this.context, main = this.page;
    const tab = this.imageTab, reusable = prefix.length > 0 && this.imageReuse !== false && tab && !tab.isClosed() && this.imageTabContext === context;
    try {
      if (reusable) {
        try { return await this.readImageOptions(tab, prefix, { reuse: true }); }
        catch (error) {
          // 登录失效等会话问题不靠重新打开页面解决；其余情况（含无法确认展开）改用新页面重读。
          if (SESSION_ERRORS.includes(error.code)) throw error;
          if (error.code === 'IMAGE_REUSE') this.imageReuse = false;
        }
      }
      await this.closeImageTab();
      const fresh = await context.newPage();
      fresh.setDefaultTimeout(12000); fresh.setDefaultNavigationTimeout(30000);
      this.imageTab = fresh; this.imageTabContext = context; this.imageTabAt = Date.now();
      return await this.readImageOptions(fresh, prefix, { reuse: false });
    } catch (error) { await this.closeImageTab(); throw error; }
    finally {
      if (this.context !== context || !main || main.isClosed()) { this.page = null; this.prepared = null; this.probed = null; await this.closeImageTab(); this.setSession('closed'); }
      else this.scheduleImageTabClose();
    }
  }
  async readImageOptions(tab, prefix, { reuse }) {
    const adapter = this;
    const view = Object.create(this, {
      page: { value: tab, writable: true },
      adapter: { value: adapter },
      browser: { value: async () => { if (tab.isClosed()) fail('IMAGE_TAB', '镜像菜单标签页已关闭'); return tab; } },
      setSession: { value: (...args) => adapter.setSession(...args) },
    });
    if (reuse) await view.checkPage(); else await view.goto(BASE+'/create');
    await view.openImageMenu();
    await view.chooseImagePath(prefix, (node, label) => view.imageExpanded(node, label, { strict: reuse }));
    const entries = await view.imageLevel(prefix.length);
    return {prefix,level:prefix.length,options:entries.map(({label,disabled}) => ({label,disabled:disabled || (prefix.length===3 && !imageCuda(label))})),
      source:'AutoDL 官方基础镜像菜单',checkedAt:reuse ? this.imageTabAt : Date.now(),reused:reuse};
  }
  async closeImageTab() {
    clearTimeout(this.imageTabTimer);
    const tab = this.imageTab; this.imageTab = null;
    if (tab) await tab.close().catch(() => {});
  }
  scheduleImageTabClose() {
    clearTimeout(this.imageTabTimer);
    if (!this.imageTab) return;
    this.imageTabTimer = setTimeout(() => void this.closeImageTab(), this.imageTabTtlMs);
    this.imageTabTimer.unref?.();
  }
  // 目录直接读取当前登录会话的只读接口；不导航或新建页面，任务提交仍走原表单核验。
  async gpuCatalog(regions, options) { return readGpuCatalogApi(this, regions, options); }
  async selectImage(c) {
    const cascader = await this.openImageMenu();
    await this.chooseImagePath(c.imagePath);
    const selected = await cascader.locator('input').inputValue();
    if (!exactImagePath(selected,c.imagePath)) fail('IMAGE_VERIFY', '所选基础镜像未完整匹配任务路径');
    if (imageCuda(c.imagePath.at(-1)) !== c.cuda) fail('IMAGE_CUDA', '基础镜像最后一级 CUDA 必须与任务 CUDA 完全一致');
    return selected;
  }
  // 探测命中后同一轮立即准备：仍是同一任务、同一地区、同一页面且未离开时，可直接复用当前表单。
  canReuseProbe(t, candidate) {
    const p = this.probed;
    return !!p && p.taskId === t.id && p.region === candidate.region && p.page === this.page && !this.page?.isClosed?.()
      && this.page.url?.() === p.url && Date.now() - p.at < 30000;
  }
  // 在另一个标签页读取实例全集，作为提交前对账基线；主标签页同时继续填写表单。
  // Playwright 启动的浏览器中非当前标签页不降频（2026-10-29 本机 Edge 实测），读取与等待可正常进行。
  async startBaseline(model) {
    const main = this.page, tab = await this.context.newPage(), adapter = this;
    tab.setDefaultTimeout(12000); tab.setDefaultNavigationTimeout(30000);
    await main.bringToFront().catch(() => {});
    const view = Object.create(this, {
      page: { value: tab, writable: true },
      browser: { value: async () => { if (tab.isClosed()) fail('BASELINE', '读取实例基线的标签页已关闭'); return tab; } },
      setSession: { value: (...args) => adapter.setSession(...args) },
    });
    const done = view.goto(LIST); done.catch(() => {});
    return {
      collect: async () => { await done; return view.scanInstances(model, { settled: true }); },
      close: () => tab.close().catch(() => {}),
    };
  }
  async prepare(t, candidate, source) {
    const c = t.config, started = Date.now(), reuse = this.canReuseProbe(t, candidate);
    this.probed = null;
    // 提交前保存实例全集作为对账基线：与表单准备并行，在点击前读取完成。
    const baseline = await this.startBaseline(c.gpuModel);
    try {
      if (!reuse) {
        if (c.mode === 'clone') source = await this.openClone(t);
        else await this.goto(`${BASE}/create`);
      }
      // 复用时这些选项通常已是所需状态，只核对、不点击也不等待。
      await this.radio('按量计费'); await this.radio(candidate.region); await this.selectModel(c.gpuModel); await this.radio(String(c.gpuCount));
      // 主机排序可能把刚命中的候选移到更前页；先精确定位（必要时回第一页），再读取当前库存与报价。
      // scanHosts 只向后翻页，不能先用它把仍在前页的候选误判为已被抢走。
      await this.locateHost(candidate.id);
      const scan = await this.scanHosts(candidate.region,{config:c,source,untilId:candidate.id}), current = scan.hosts.find(h => h.id === candidate.id);
      if (!current && scan.stalled) fail('PAGE_STUCK', '提交前找回候选主机时资源列表翻页没有前进；本次未提交', LIMITED_RETRY);
      if (!current || candidateReasons(current,c,source).length) throw new AppError('RESOURCE_GONE', '候选主机库存或价格已改变，继续监测', RACE);
      await this.radio(candidate.id);
      // 有的主机要求多卡起租（rent_mode，如“该主机2卡起租”）：选中后平台会把 GPU 数量改大或让原数量不可选。
      // 这台主机满足不了任务的卡数，换下一台；不当作页面故障停下任务。
      await this.checkGpuCountKept(c.gpuCount);
      const extraDiskGB = requiredDiskGB(c,source);
      const expand = this.page.locator('label.el-checkbox').filter({hasText:/^\s*需要扩容\s*$/});
      // 这台主机给不了所需扩容（“需要扩容”不可选，或填入的容量被页面改小）：未点击，换下一台主机并暂时不选它。
      try {
        await this.checkbox(expand,extraDiskGB > 0,'需要扩容');
        if (extraDiskGB > 0) {
          const spin = this.page.getByRole('spinbutton');
          if (await spin.count() !== 1) fail('DISK_DOM', '无法唯一定位数据盘扩容输入框');
          await spin.fill(String(extraDiskGB)); await spin.blur();
          if (Number(await spin.inputValue()) !== extraDiskGB) throw new AppError('DISK_REFUSED', '这台主机没有接受 ' + extraDiskGB + ' GB 数据盘扩容');
        }
      } catch (error) {
        if (!['OPTION_DISABLED', 'DISK_REFUSED'].includes(error.code)) throw error;
        throw new AppError('DISK_HOST', messageOf(error) + '；未提交，改试其他主机', { ...RACE, hostProblem: true });
      }
      let image = '继承源实例系统盘';
      if (c.mode === 'create') image = await this.selectImage(c);
      await this.settle();
      const formMs = Date.now() - started;
      // 源实例状态的读取时间记为读取实例列表之前，不把读取所花的时间算作“刚核验过”。
      const listedAt = Date.now();
      const before = await baseline.collect();
      this.lateCreation(t, before);
      // 克隆：用同一份实例列表复核源实例仍存在、已关机且规格不变。
      if (c.mode === 'clone') { const row = before.find(i => hasId(i, c.sourceId)); validateCloneSource(c, row && { ...row, id: c.sourceId }); }
      const money = parseQuoteText(await this.page.locator('body').innerText());
      const quote = { host:current, gpuCount:c.gpuCount, extraDiskGB, copyDataDisk: c.mode === 'clone' && !!new URL(this.page.url()).searchParams.get('copy_data_disk'),
        ...money, baselineIds: [...new Set(before.flatMap(idsOf))], imageVerified:true, image, preparedAt:Date.now(),
        timing:{ reused:reuse, formMs, totalMs:Date.now() - started } };
      const reasons = verifyQuote(quote,c,source);
      if (reasons.length) fail('QUOTE', `最终费用或配置校验失败：${reasons.join('、')}`);
      if (!(await (await this.submitButton()).isEnabled())) fail('SUBMIT_DISABLED', 'AutoDL 的“创建并开机”按钮不可用，请检查余额、镜像与配置');
      this.prepared = { taskId:t.id, quote, source, sourceCheckedAt: c.mode === 'clone' ? listedAt : null }; return quote;
    } finally { await baseline.close(); }
  }
  // 此前被拒绝或确认未创建的点击之后（30分钟内），实例列表出现了与任务相符的新实例：可能是平台延迟创建，停止并请用户核对，不再点击。
  // 不限于被拒绝时的那台主机，否则延迟创建在 A 主机、下一次在 B 主机点击成功，会多租一台。别的任务已绑定的实例不算。
  lateCreation(t, instances) {
    const claimed = this.claimedIds(t);
    for (const rejection of (t.submitRejections || []).filter(r => Date.now() - r.at < 30 * 60000 && Array.isArray(r.baselineIds))) {
      const baseline = new Set(rejection.baselineIds);
      const late = instances.filter(i => isNew(i, baseline)).map(i => ({ ...i, id: freshId(i, baseline) }))
        .filter(i => !claimed.has(i.id) && this.verifyIdentity(i, t));
      if (late.length) throw new AppError('SUBMIT_LATE', (rejection.hostNumber ? '此前在 ' + rejection.hostNumber + ' 被拒绝或确认未创建的提交' : '此前被拒绝或确认未创建的提交')
        + '之后，实例列表出现了与任务相符的新实例 ' + late.map(i => i.id + (i.hostNumber ? '（' + i.hostNumber + '）' : '')).slice(0, 3).join('、')
        + '，可能是延迟创建；已停止自动提交，避免多租。请到 AutoDL 核对，确认后再恢复任务', { lateIds: [...new Set(late.flatMap(idsOf).concat(late.map(i => i.id)))] });
    }
  }
  // 绑定了本次的新实例之后，再看 30 分钟内被拒绝或确认未创建的点击之后，别的主机上是否也出现了与任务相符的新实例（延迟创建）。
  // 只用于提醒“可能多租了一台”，不改变本次的绑定。
  strays(t, instances, boundId) {
    const recent = (t.submitRejections || []).filter(r => Date.now() - r.at < 30 * 60000 && Array.isArray(r.baselineIds));
    if (!recent.length) return [];
    const now = new Set(t.operation?.baselineIds || []), claimed = this.claimedIds(t), known = new Set(t.lateInstanceIds || []);
    return instances.filter(i => isNew(i, now) && recent.some(r => isNew(i, new Set(r.baselineIds)))).map(i => ({ ...i, id: freshId(i, now) }))
      .filter(i => i.id !== boundId && !claimed.has(i.id) && !known.has(i.id) && this.verifyIdentity(i, t)).map(i => i.id);
  }
  // 选中主机后 GPU 数量仍是任务要求的数量；否则这台主机有起租卡数等限制，按竞争失败换下一台，并暂时不选它。
  async checkGpuCountKept(count) {
    const label = this.radioLabel(String(count));
    const kept = await label.count() === 1 && await label.locator('input').isChecked() && await label.locator('input').isEnabled();
    if (!kept) throw new AppError('GPU_COUNT', '选中这台主机后 GPU 数量不再是 ' + count + ' 卡（该主机可能有起租卡数要求，如“2卡起租”）；未提交，改试其他主机', { ...RACE, hostProblem: true });
  }
  // 唯一定位“创建并开机”；找不到时列出页面上的按钮文字，便于判断平台是否改名。
  async submitButton({ race = false } = {}) {
    const button = this.page.getByRole('button',{name:'创建并开机',exact:true}), count = await button.count();
    if (count === 1) return button;
    if (race) throw new AppError('RESOURCE_GONE', '提交按钮已变化，重新监测', RACE);
    const names = await this.page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')]
      .filter(el => el.getClientRects().length).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 8)).catch(() => []);
    fail('SUBMIT_DOM', '页面上' + (count ? '有 ' + count + ' 个' : '没有') + '“创建并开机”按钮' + (names.length ? '（可见按钮：' + names.join('、') + '）' : '') + '，请检查 AutoDL 页面是否更新');
  }
  async locateHost(id) {
    // scanHosts 通常停在候选所在页，先查当前页；找不到再回到第一页逐页查找。
    const target = () => this.radioLabel(id);
    if (await target().count() === 1) { await target().scrollIntoViewIfNeeded(); return; }
    const first = this.page.locator('.el-pagination .number').filter({hasText:/^1$/});
    if (await first.count()) { await first.first().click(); await this.settle(); }
    await this.page.locator('.el-table__body-wrapper').evaluateAll(elements => { elements.forEach(e=>e.scrollTop=0); });
    let previous = null, unchanged = 0, exhausted = false;
    for (let i=0;i<100;i++) {
      if (await target().count() === 1) { await target().scrollIntoViewIfNeeded(); return; }
      // 翻页或滚动后内容没有变化时，多等两次加载，再停止而不是空转到上限或连点跳页。
      const signature = (await this.readHosts('')).map(h => h.id).join('|');
      if (signature === previous) { if (unchanged++ >= 2) break; await this.settle(); continue; }
      previous = signature; unchanged = 0;
      const more = await this.moreHosts();
      if (more === 'page') { await this.page.locator('.el-pagination .btn-next:visible').click(); await this.settle(); continue; }
      if (more === 'scroll') {
        await this.page.locator('.el-table__body-wrapper').evaluateAll(es => es.forEach(e => { e.scrollTop += Math.max(200, e.clientHeight - 60); }));
        await this.settle(); continue;
      }
      exhausted = true; break;
    }
    // 确认翻到末尾才算资源竞争；翻页卡住时保留读取错误，不能伪造主机已消失。
    if (exhausted) throw new AppError('RESOURCE_GONE','候选主机已不在资源列表中，继续监测',RACE);
    throw new AppError('RESOURCE_SCAN','尚未完整确认候选主机列表，请稍后重试',LIMITED_RETRY);
  }
  async revalidateSource(t) {
    const main = this.page;
    if (!this.context || !main || main.isClosed()) fail('SOURCE_CHECK', '无法重新核验源实例，请重新连接 AutoDL');
    const check = await this.context.newPage();
    try {
      check.setDefaultTimeout(12000); check.setDefaultNavigationTimeout(30000);
      this.page = check;
      const { info } = await this.findInstanceRow(t.config.sourceId, t.config.gpuModel);
      return validateCloneSource(t.config, info);
    } finally { this.page = main; await check.close(); }
  }
  async verifyPreparedForm(t, quote) {
    if (t.config.action !== 'execute' || !t.config.paidConsent) fail('CONSENT','此任务未授权付费提交');
    if (this.prepared?.taskId !== t.id || this.prepared.quote !== quote) fail('PREPARATION','创建表单与当前任务不一致');
    if (Date.now() - quote.preparedAt > 60000) throw new AppError('QUOTE_STALE','报价已超过60秒，重新检查资源',RACE);
    await this.checkPage();
    const selected = this.radioLabel(quote.host.id).locator('input[type=radio]');
    if (!(await selected.isChecked())) throw new AppError('SELECTION_CHANGED','候选主机选择已改变（可能已被占用），重新监测',RACE);
    const freshHosts = await this.readHosts(quote.host.region,t.config.gpuModel), host = freshHosts.find(h=>h.id===quote.host.id);
    const money = parseQuoteText(await this.page.locator('body').innerText());
    const freshQuote = {...quote,host:host || {},...money};
    // 库存、价格等在点击前变化属于竞争失败：不点击，立即重新监测。
    if (verifyQuote(freshQuote,t.config,this.prepared.source).length) throw new AppError('QUOTE_CHANGED','点击前库存或费用已改变，未提交，重新监测',RACE);
    if (!(await this.radioLabel('按量计费').locator('input').isChecked())) fail('BILLING','计费方式已改变');
    await this.checkGpuCountKept(t.config.gpuCount);
    if (!(await this.radioLabel(quote.host.region).locator('input').isChecked())) fail('REGION_CHANGED','监测地区选择已改变');
    const expand = await this.page.locator('label.el-checkbox').filter({hasText:/^\s*需要扩容\s*$/}).evaluateAll(readCheckboxes);
    if (expand.length !== 1 || expand[0].checked !== (quote.extraDiskGB > 0)) fail('DISK_CHANGED','扩容开关已改变或状态无法确认');
    if (quote.extraDiskGB > 0 && Number(await this.page.getByRole('spinbutton').inputValue()) !== quote.extraDiskGB) fail('DISK_CHANGED','扩容容量已改变');
    if (t.config.mode === 'create') {
      const image = await this.page.locator('.el-cascader:visible input').inputValue();
      if (image !== quote.image) fail('IMAGE_CHANGED','基础镜像选择已改变');
    }
    if (t.config.mode === 'clone') {
      const problem = cloneUrlProblem(new URL(this.page.url()), t.config);
      if (problem) fail('COPY_DISK', '点击前克隆页面' + problem + '；未提交');
    }
    const button = await this.submitButton({ race: true });
    if (!(await button.isEnabled())) throw new AppError('RESOURCE_GONE','提交按钮已不可用，重新监测',RACE);
    return freshQuote;
  }
  async submit(t, quote, mark, beforeClick = async () => {}) {
    const freshQuote = await this.verifyPreparedForm(t, quote);
    await beforeClick(freshQuote);
    // 准备阶段已用点击前的实例列表复核源实例；间隔较长时再单独核验一次。
    if (t.config.mode === 'clone' && !(Date.now() - (this.prepared.sourceCheckedAt || 0) < 15000)) await this.revalidateSource(t);
    const finalQuote = await this.verifyPreparedForm(t, quote);
    if (finalQuote.hourly !== freshQuote.hourly || finalQuote.storageDaily !== freshQuote.storageDaily)
      throw new AppError('QUOTE_CHANGED', '余额/源实例检查期间报价改变，未提交，重新监测', RACE);
    if (t.state === 'paused' || t.state === 'cancelled') fail('CANCELLED', '任务已暂停或停止，未提交');
    const button = await this.submitButton({ race: true }), formUrl = this.page.url();
    await this.markClickSignals();
    // 提交瞬间再次确认账号，防止用户在准备表单后切换登录；不改变 mark 的同步合同。
    if (this.verifyTaskOwner) await this.verifyTaskOwner(t);
    mark(); // 从此以后任何异常一律对账，不重试创建。
    await button.click();
    // 只读取页面结果；未经验证的弹窗不会被猜测确认，防止触发其他付费/破坏操作。
    const outcome = await this.clickOutcome(formUrl), seconds = Math.round((outcome.waitedMs ?? this.clickOutcomeMs) / 1000);
    // 明确识别出的平台拒绝（失败提示、余额不足等弹窗、架构与 CUDA 不符）：立即两次核对实例列表，没有新实例就清除记录继续监测。
    const arch = outcome.kind === 'dialog' && ARCH_DIALOG.test(outcome.message);
    const known = outcome.kind === 'rejected' || arch || outcome.kind === 'dialog' && STRONG_FAILURE_TEXT.test(outcome.message);
    if (known) return this.confirmNotCreated(t, quote, outcome.message, { archBlocked: arch });
    // 其余情况（按钮仍在加载、没有识别出结果、未识别的弹窗）：请求可能仍在处理，保留提交记录，点击约 2 分钟后再读实例列表核对；
    // 不立即判定“未创建”，避免实例延迟出现时被当成未创建、下一轮又点一次而多租。
    if (outcome.kind !== 'accepted') {
      this.prepared = null;
      const seen = outcome.kind === 'dialog' ? '点击后出现未识别的弹窗：' + redact(outcome.message).slice(0, 80)
        : outcome.busy ? '点击后 ' + seconds + ' 秒按钮仍在加载，平台可能仍在处理'
        : '点击后 ' + seconds + ' 秒内页面没有回到实例列表，也没有识别出失败提示' + (outcome.others?.length ? '（新出现：' + redact(outcome.others.join('；')).slice(0, 160) + '）' : '（页面上没有新出现的提示）');
      fail('SUBMIT_UNCLEAR', seen + '；保留提交记录，约 2 分钟后只读核对实例列表，任务不会再次创建');
    }
    this.prepared = null;
    // 页面已跳回实例列表：平台已受理。之后读取实例列表失败也保留“已受理”，不会被当成结果不明而在之后判为未创建。
    const receipt = { acceptedAt: Date.now(), instanceId: null, evidence: 'accepted-navigation-only' };
    try {
      const instances = await this.scanInstances(t.config.gpuModel);
      // 仅有一个位于指定主机的精确匹配新增实例时自动绑定；缺少主机号或出现多个候选时必须人工核对。
      const candidates = this.newTargets(instances, t);
      if (candidates.length === 1) Object.assign(receipt, { instanceId: candidates[0].id, evidence: 'unique-new-instance-on-selected-host', lateIds: this.strays(t, instances, candidates[0].id) });
    } catch {}
    return receipt;
  }
  // 点击后的页面结果：回到实例列表=已受理；表单页新出现失败提示=平台拒绝；新弹窗或超时=不明。
  // 点击前用 markClickSignals 标记已显示的元素，之后只把新出现的当作本次结果。
  markClickSignals() { return this.page.evaluate(clickSignals, ['mark', this.signalPatterns.failure, this.signalPatterns.strong]).catch(() => null); }
  clickSignals() { return this.page.evaluate(clickSignals, ['read', this.signalPatterns.failure, this.signalPatterns.strong]).catch(() => ({ toasts: [], dialogs: [], others: [], button: null, path: '' })); }
  get signalPatterns() { return { failure: { source: FAILURE_TEXT.source, flags: FAILURE_TEXT.flags }, strong: { source: STRONG_FAILURE_TEXT.source, flags: STRONG_FAILURE_TEXT.flags } }; }
  async clickOutcome(formUrl) {
    const accepted = () => { try { const url = new URL(this.page.url()); return url.href !== formUrl && /^\/console\/instance(?:\/|$)/.test(url.pathname); } catch { return false; } };
    let last = { others: [], button: null, path: '' };
    // 按钮仍在加载时继续等到 clickLoadingMs：AutoDL 下单后会每秒查一次实例，最长约1分钟，成功跳回实例列表、失败给出提示。
    // 按钮仍在加载时出现的失败提示不立即当作结果（请求可能还没返回），等加载结束再判断。
    const started = Date.now(), busy = s => s.button?.loading === true;
    for (let deadline = started + this.clickOutcomeMs; ; await sleep(this.clickPollMs)) {
      if (accepted()) return { kind: 'accepted' };
      const now = await this.clickSignals(), toast = now.toasts[0], dialog = now.dialogs[0];
      if (now.others?.length || now.button || now.path) last = { others: now.others?.length ? now.others : last.others, button: now.button, path: now.path };
      if (dialog) return { kind: 'dialog', message: dialog };
      if (toast && !(busy(now) && Date.now() < started + this.clickLoadingMs)) {
        // 报错后再观察片刻：若页面仍跳回实例列表，按已受理处理。
        for (const grace = Date.now() + this.rejectGraceMs; Date.now() < grace; await sleep(this.clickPollMs)) if (accepted()) return { kind: 'accepted' };
        return busy(now) ? { kind: 'unknown', others: [toast], busy: true, path: now.path, waitedMs: Date.now() - started } : { kind: 'rejected', message: toast };
      }
      if (Date.now() >= deadline) {
        if (busy(now) && Date.now() < started + this.clickLoadingMs) { deadline = started + this.clickLoadingMs; continue; }
        break;
      }
    }
    // busy：等满上限后按钮仍在加载（或已禁用），请求可能还没有返回，不能马上认定未创建。
    return accepted() ? { kind: 'accepted' } : { kind: 'unknown', others: last.others, busy: last.button?.loading === true || last.button?.disabled === true, path: last.path, waitedMs: Date.now() - started };
  }
  // 平台已明确拒绝：间隔两次读取完整实例列表核对。都没有提交前基线之外的实例才认定未创建。
  // 出现了基线之外的实例时不自动绑定（拒绝之后出现的新实例可能属于别的任务或手动创建），保留提交记录交给用户核对。
  async confirmNotCreated(t, quote, message, { archBlocked = false } = {}) {
    this.prepared = null;
    const baseline = new Set(quote.baselineIds || []), shown = redact(message).slice(0, 160);
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await sleep(this.rejectRecheckMs);
      let rows;
      for (let attempt = 0; ; attempt++) {
        try { rows = await this.instances(t.config.gpuModel); break; }
        catch (error) { if (error.code !== 'LIST_LOADING' || attempt >= 2) throw error; await sleep(1500); }
      }
      const extra = rows.filter(i => isNew(i, baseline)).map(i => freshId(i, baseline));
      if (extra.length) fail('SUBMIT_UNCLEAR', '平台提示“' + shown + '”，但实例列表出现提交前没有的实例 ' + extra.slice(0, 3).join('、')
        + '；不自动绑定（可能属于别的任务或手动创建），请核对后绑定。任务不会再次创建', { noAutoBind: true });
    }
    const account = ACCOUNT_PROBLEM.test(message);
    // 架构与 CUDA 不匹配：换主机也不会成功，停止并说明，不当作竞争失败反复点击。
    if (archBlocked) throw new AppError('CUDA_ARCH', 'AutoDL 提示：“' + shown + '”。两次核对实例列表均无新实例，未产生实例；换主机也不会通过，已停止自动提交。请改选其他 GPU 型号或环境后再建任务',
      { notCreated: true });
    throw new AppError('SUBMIT_REJECTED', '平台拒绝创建：“' + shown + '”；两次核对实例列表均无新实例，未产生实例' + (account ? '。请处理账户问题后恢复任务' : '，继续监测'),
      { notCreated: true, race: !account });
  }
  verifyIdentity(instance,t) {
    return instance && instance.region && t.config.regions.includes(instance.region)
      && gpuKey(instance.gpuModel) === gpuKey(t.config.gpuModel) && instance.gpuCount === t.config.gpuCount
      && instance.id !== t.config.sourceId;
  }
  // 本次提交的候选：提交前基线之外、与任务相符、位于所选主机（地区与主机号都要一致）、不是别的任务已绑定的实例。
  newTargets(instances,t) {
    const host = t.operation?.quote?.host;
    if (!host?.number || !Array.isArray(t.operation?.baselineIds)) return [];
    const baseline = new Set(t.operation.baselineIds), claimed = this.claimedIds(t);
    return instances.filter(i => isNew(i, baseline)).map(i => ({ ...i, id: freshId(i, baseline) }))
      .filter(i => this.verifyIdentity(i,t) && i.hostNumber === host.number && (!host.region || i.region === host.region) && !claimed.has(i.id));
  }
  async reconcile(t) {
    if (t.operation.stage === 'click_started' && !t.operation.receipt?.instanceId) return this.reconcileUnclear(t);
    const instances = await this.instances(t.config.gpuModel);
    const id = t.operation.receipt?.instanceId;
    if (id) {
      const found = instances.find(i => hasId(i, id)), instance = found && { ...found, id };
      if (!instance && Date.now() - t.operation.receipt.acceptedAt < 90000) return {pending:true,reason:'等待平台实例列表显示已绑定的目标实例'};
      if (!this.verifyIdentity(instance,t)) return {ambiguous:true,reason:'已绑定目标实例' + identityProblem(instance, t) + '，请到 AutoDL 核对'};
      return {instance:{...instance,gpuVerified:true}, lateIds: this.strays(t, instances, id)};
    }
    const candidates = this.newTargets(instances,t);
    if (t.operation.stage === 'accepted' && t.operation.receipt?.acceptedAt && candidates.length === 1) {
      return { receipt:{...t.operation.receipt,instanceId:candidates[0].id,evidence:'unique-new-instance-on-selected-host'},
        instance:{...candidates[0],gpuVerified:true}, lateIds: this.strays(t, instances, candidates[0].id) };
    }
    if (t.operation.stage === 'accepted' && t.operation.receipt?.acceptedAt && candidates.length === 0 && Date.now() - t.operation.receipt.acceptedAt < 90000) {
      return {pending:true,reason:'创建页面已返回，等待目标实例出现在平台列表；不会再次提交'};
    }
    return {ambiguous:true,reason: candidates.length === 1
      ? `发现一个新增且匹配的实例 ${candidates[0].id}；请核对后将此 ID 绑定到任务。此任务不会再次创建`
      : '提交回执未提供可验证实例 ID，请在 AutoDL 核对新实例并绑定。此任务不会再次创建'};
  }
  // 点击结果不明（无法识别页面结果、服务中断等）：点击约2分钟后读取完整实例列表两次。
  // 都没有提交前基线之外的实例才认定未创建；目标主机上恰好一个匹配的新实例则绑定；其余情况交给用户核对。
  async reconcileUnclear(t) {
    const op = t.operation;
    // 从实际点击时算起（意图落盘到点击之间可能有十几秒）；旧记录没有点击时间时用意图时间。
    if (Date.now() - (op.clickedAt || op.at) < 2 * 60000) return { pending: true, reason: '点击结果暂不明确，约 2 分钟后自动核对实例列表；不会再次创建' };
    const baseline = new Set(op.baselineIds || []);
    let rows = await this.instances(t.config.gpuModel);
    if (!rows.some(i => isNew(i, baseline))) { await sleep(this.rejectRecheckMs); rows = await this.instances(t.config.gpuModel); }
    const extra = rows.filter(i => isNew(i, baseline)).map(i => freshId(i, baseline)), mine = this.newTargets(rows, t);
    if (!extra.length) return { notCreated: true, reason: '点击结果不明，自动核对：完整实例列表两次都只有点击前已有的实例，确认未创建' };
    // 平台曾明确拒绝本次点击（noAutoBind）：之后出现的新实例不自动绑定，交给用户核对。
    if (mine.length === 1 && !op.noAutoBind) return { receipt: { acceptedAt: op.at, instanceId: mine[0].id, evidence: 'unique-new-instance-on-selected-host-after-unclear-click' },
      instance: { ...mine[0], gpuVerified: true }, lateIds: this.strays(t, rows, mine[0].id) };
    return { ambiguous: true, reason: '点击结果不明，实例列表出现提交前没有的实例 ' + extra.slice(0, 3).join('、')
      + (op.noAutoBind ? '，但平台曾提示拒绝创建，可能属于别的任务或手动创建' : mine.length > 1 ? '，其中有多个与本次配置相符' : '，但无法确认哪个属于本次提交') + '；请核对后绑定目标实例。此任务不会再次创建' };
  }
  async attach(t,id) {
    if (!/^[a-z0-9]+-[a-z0-9]+$/i.test(id)) fail('INSTANCE','实例 ID 格式不正确');
    const found = (await this.instances(t.config.gpuModel)).find(i => hasId(i, id)), instance = found && { ...found, id };
    if (!this.verifyIdentity(instance,t)) fail('INSTANCE','目标实例的地区/精确 GPU 型号/数量不匹配，或选中了源实例');
    if ((t.operation.baselineIds || []).includes(id)) fail('INSTANCE','目标实例已存在于提交前基线，请避免将原有实例错误绑定为此次新实例');
    // 人工绑定同样遵守单任务归属，不能把另一个任务的目标当作本次提交的结果。
    if (this.claimedIds(t).has(id)) fail('INSTANCE','目标实例已被其他任务绑定，请核对本次提交对应的实例');
    return {instanceId:id,acceptedAt:t.operation.at,manual:true};
  }
  // 重新读取完整实例列表，返回提交前基线之外的全部实例（不限型号，任何新增都不能当作“未创建”）。
  async recheckSubmission(t) {
    const baseline = new Set(t.operation.baselineIds || []);
    const rows = await this.instances(t.config.gpuModel);
    return { extra: rows.filter(i => isNew(i, baseline)).map(i => ({ id: freshId(i, baseline), region: i.region, gpuModel: i.gpuModel, gpuCount: i.gpuCount })) };
  }
  async logout() {
    // 仅允许清理本项目的专用资料目录，不能触及系统默认浏览器或运行目录其他文件。
    const expected=path.resolve(this.runtimeDir,'browser-profile'), target=path.resolve(this.profileDir);
    if(target!==expected || path.dirname(target)!==this.runtimeDir || path.basename(target)!=='browser-profile')
      fail('PROFILE_PATH','专用浏览器目录异常，已停止清理');
    await this.close();
    let info; try { info=await fs.lstat(target); } catch(error) { if(error.code!=='ENOENT')throw error; }
    if(info?.isSymbolicLink())fail('PROFILE_PATH','专用浏览器目录不能是符号链接，未递归清理');
    if(info) {
      try { await fs.rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
      catch { fail('PROFILE_BUSY','专用浏览器资料仍被占用，未能完整清除；请关闭该窗口后重试退出'); }
    }
    this.context=null;this.page=null;this.sessionPage=null;this.prepared=null;this.probed=null;this.imageTab=null;this.catalogTab=null;this.cloneCache=null;this.previouslyReady=false;this.browserMode=null;
    this.setSession('not_open',{checked:true});
    return {session:this.sessionStatus(),message:'已退出本项目的 AutoDL 登录并清除专用浏览器资料；云端实例与数据盘保留'};
  }
  async close() { if(this.context) await this.context.close(); }
}

