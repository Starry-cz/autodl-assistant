import { AppError, fail } from './errors.mjs';
export const BALANCE_URL = 'https://api.autodl.com/api/v1/dev/wallet/balance';
const MAX_AGE = 30000;
// 网络错误、超时、接口暂时不可用（非鉴权失败）：任务退避后自动重试，连续多次才转人工处理。
const BALANCE_RETRY = { retryable: true, maxRetries: 5 };
// AutoDL 下单页：租用多卡实例时钱包余额需大于 10 元（单位：千分之一元）。
const MULTI_CARD_MIN_MILLI = 10001;
// 读取响应正文，超过上限就停止读取并返回 null，不把超大响应读进内存。
async function cappedText(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) { const text = await response.text(); return text.length > limit ? null : text; }
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks).toString('utf8');
}
// 所有比较均使用千分元，向上取整预算，避免浮点误差使不足余额通过。
// 多卡时报价不低于“主机单卡价 × 卡数”：页面的配置费用若只显示单卡价或尚未刷新，按较高者估算，不低估预算。
export function estimateBudget(config, quote) {
  const listed = Number.isFinite(quote?.host?.price) && quote.host.price > 0 ? quote.host.price * config.gpuCount : 0;
  const hourly = quote == null ? config.maxTotalHourly : Number.isFinite(quote.hourly) ? Math.max(quote.hourly, listed) : quote.hourly;
  const storageDaily = quote == null ? config.maxStorageDaily : quote.storageDaily;
  const hours = config.expectedHours ?? 1, reserve = config.balanceReserve ?? 0;
  if (![hourly, storageDaily, hours, reserve].every(Number.isFinite) || hourly <= 0 || storageDaily < 0 || hours <= 0 || reserve < 0)
    fail('BALANCE_QUOTE', '费用或预计运行时长未知，无法检查余额');
  const days = Math.max(1, Math.ceil(hours / 24));
  const requiredMilli = Math.ceil((hourly * hours + storageDaily * days + reserve) * 1000 - 1e-8);
  if (!Number.isSafeInteger(requiredMilli)) fail('BALANCE_QUOTE', '预算超出可核实范围');
  return { hourly, storageDaily, hours, storageDays: days, reserve, requiredMilli, required: requiredMilli / 1000,
    basis: quote ? 'quote' : 'limits' };
}
// 余额下限：只按页面上的单卡价估算预计时长的 GPU 费用加保留余额，磁盘费未知时不计。低于它时一定不够。
// AutoDL 文档没有写开机所需的最低余额；这是本项目的保守预检，与 estimateBudget 的默认（1小时）一致。
export function minimumBudget(config, unitPrice) {
  const hours = config.expectedHours ?? 1, reserve = config.balanceReserve ?? 0;
  if (!(Number.isFinite(unitPrice) && unitPrice > 0) || !Number.isFinite(hours) || !Number.isFinite(reserve)) return null;
  const requiredMilli = Math.ceil((unitPrice * config.gpuCount * hours + reserve) * 1000 - 1e-8);
  return Number.isSafeInteger(requiredMilli) ? { requiredMilli, required: requiredMilli / 1000, hours } : null;
}
export function availableMilli(snapshot, config) {
  return Math.round(snapshot.balance * 1000) + (config.includeVouchers ? Math.round(snapshot.vouchers * 1000) : 0);
}
export class Wallet {
  #token = ''; #generation = 0; #pending = null;
  constructor({ store = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 10000 } = {}) {
    this.store = store;
    this.#token = store?.data.walletSettings?.rememberToken === true ? store.data.walletSettings.token || '' : '';
    this.fetchImpl = fetchImpl; this.clock = clock; this.timeoutMs = timeoutMs;
    this.snapshot = null; this.lastError = null;
  }
  publicState() {
    return { configured: !!this.#token, rememberToken: this.store?.data.walletSettings?.rememberToken === true, status: this.#pending ? 'refreshing' : this.lastError ? 'error' : this.snapshot ? 'ready' : this.#token ? 'connected' : 'unconfigured',
      snapshot: this.snapshot ? { ...this.snapshot } : null, lastError: this.lastError,
      stale: !this.snapshot || this.clock() - this.snapshot.checkedAt > MAX_AGE };
  }
  setToken(value, { rememberToken = false } = {}) {
    if (typeof rememberToken !== 'boolean') fail('WALLET_TOKEN','是否记住 Token 必须为布尔值');
    if (typeof value !== 'string') fail('WALLET_TOKEN','请填写有效的 AutoDL 开发者 Token');
    const next=value.trim() || this.#token;
    if (!next || next.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(next)) fail('WALLET_TOKEN', '请填写有效的 AutoDL 开发者 Token');
    if (this.store) {
      const previous=this.store.data.walletSettings;
      this.store.data.walletSettings={rememberToken,...(rememberToken?{token:next}:{})};
      try { this.store.save(); } catch(error) { this.store.data.walletSettings=previous; throw error; }
    }
    this.clearToken({forget:false}); this.#token=next;
  }
  clearToken({forget = true} = {}) {
    if(forget && this.store) {
      const previous=this.store.data.walletSettings; this.store.data.walletSettings={rememberToken:false};
      try { this.store.save(); } catch(error) { this.store.data.walletSettings=previous; throw error; }
    }
    this.#generation++; this.#pending?.controller.abort(); this.#pending = null;
    this.#token = ''; this.snapshot = null; this.lastError = null;
  }
  // maxAge：调用方可要求更新鲜的快照（不超过默认30秒）；进行中的查询会被复用，不重复请求。
  async refresh({ force = false, maxAge = MAX_AGE } = {}) {
    if (!this.#token) fail('BALANCE_TOKEN_REQUIRED', '余额保护需要配置 AutoDL 开发者 Token；也可主动关闭此任务的余额保护', { status: 409 });
    if (!force && !this.lastError && this.snapshot && this.clock() - this.snapshot.checkedAt <= Math.min(maxAge, MAX_AGE)) return this.snapshot;
    if (this.#pending) return this.#pending.promise;
    const generation = this.#generation, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const pending = { controller, promise: null };
    this.#pending = pending;
    pending.promise = (async () => {
      try {
        const response = await this.fetchImpl(BALANCE_URL, { method: 'POST', headers: { Authorization: this.#token },
          redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new AppError('BALANCE_API', response.status === 401 || response.status === 403
          ? '余额查询鉴权失败，请核对开发者 Token' : 'AutoDL 余额接口暂时不可用', { status: 409, ...(response.status === 401 || response.status === 403 ? {} : BALANCE_RETRY) });
        const text = await cappedText(response, 65536);
        if (text === null) throw new Error('oversize response');
        const result = JSON.parse(text), data = result?.data;
        if (result?.code !== 'Success') throw new AppError('BALANCE_API', 'AutoDL 拒绝余额查询，请检查开发者 Token 和账号状态', { status: 409 });
        if (!Number.isSafeInteger(data?.assets) || !Number.isSafeInteger(data?.voucher_balance) || data.voucher_balance < 0)
          throw new AppError('BALANCE_SCHEMA', '余额响应缺少有效金额，已停止余额判断', { status: 409 });
        if (generation !== this.#generation || controller.signal.aborted) throw Error('cancelled');
        this.snapshot = { balance: data.assets / 1000, vouchers: data.voucher_balance / 1000, checkedAt: this.clock() };
        this.lastError = null; return this.snapshot;
      } catch (error) {
        // 不转发平台 msg、网络错误或响应正文，避免凭证被回显到前端/任务日志。
        const safe = generation !== this.#generation ? new AppError('BALANCE_CHANGED', '余额凭证已变更，请重试', { status: 409 })
          : error instanceof AppError ? error : new AppError('BALANCE_UNAVAILABLE', controller.signal.aborted
            ? '余额查询已超时，请重试' : '余额查询失败，请检查网络与开发者 Token', { status: 409, ...BALANCE_RETRY });
        if (generation === this.#generation) this.lastError = safe.message;
        throw safe;
      } finally { clearTimeout(timer); if (this.#pending === pending) this.#pending = null; }
    })();
    return pending.promise;
  }
  async check(config, quote = null, { force = false, maxAge = MAX_AGE } = {}) {
    const generation = this.#generation, budget = estimateBudget(config, quote), snapshot = await this.refresh({ force, maxAge });
    if (generation !== this.#generation || snapshot !== this.snapshot || !this.#token)
      fail('BALANCE_CHANGED', '余额凭证已变更，请重新检查', { status: 409 });
    if (this.clock() - snapshot.checkedAt > MAX_AGE || this.lastError) fail('BALANCE_STALE', '余额已过期或查询失败，请重新同步', { status: 409 });
    const availableMilli = Math.round(snapshot.balance * 1000) + (config.includeVouchers ? Math.round(snapshot.vouchers * 1000) : 0);
    if (!Number.isSafeInteger(availableMilli)) fail('BALANCE_SCHEMA', '可用金额超出可核实范围', { status: 409 });
    const result = { ...budget, available: availableMilli / 1000, includeVouchers: config.includeVouchers === true,
      checkedAt: snapshot.checkedAt, credentialRevision: this.#generation, sufficient: availableMilli >= budget.requiredMilli };
    if (!result.sufficient) fail('BALANCE_INSUFFICIENT', '可用余额 ¥' + result.available.toFixed(3) + '，低于本次预检所需 ¥'
      + budget.required.toFixed(3) + '；请充值或调整运行时长、预算及保留余额', { status: 409 });
    // AutoDL 下单页的规则：租多卡时钱包余额（不含代金券）需大于 10 元，否则弹出“余额不足”。
    if (config.gpuCount > 1 && Math.round(snapshot.balance * 1000) < MULTI_CARD_MIN_MILLI) fail('BALANCE_INSUFFICIENT', '钱包余额 ¥' + snapshot.balance.toFixed(2)
      + '：AutoDL 规定租用多卡实例时钱包余额需大于 10 元（代金券不计），请先充值', { status: 409 });
    return result;
  }
  confirm(check) {
    if (!check || check.credentialRevision !== this.#generation || !this.#token || !this.snapshot || this.lastError
      || this.clock() - check.checkedAt > MAX_AGE || this.clock() - this.snapshot.checkedAt > MAX_AGE)
      fail('BALANCE_STALE', '提交前余额已失效或凭证已变更，未点击付费按钮', { status: 409 });
    const available = Math.round(this.snapshot.balance * 1000) + (check.includeVouchers ? Math.round(this.snapshot.vouchers * 1000) : 0);
    if (available < check.requiredMilli) fail('BALANCE_INSUFFICIENT', '余额检查后可用金额下降，已停止提交', { status: 409 });
  }
  // 监测期间的余额提醒用：不超过 maxAge 的快照直接返回，否则刷新。付费前的判断仍用 check()。
  async recentBalance(maxAge = 300000) {
    if (this.snapshot && !this.lastError && this.clock() - this.snapshot.checkedAt <= maxAge) return this.snapshot;
    return this.refresh({ force: true });
  }
  close() { this.clearToken({forget:false}); }
}

