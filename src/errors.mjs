export class AppError extends Error {
  constructor(code, message, { retryable = false, status = 400, conflict, maxRetries, race = false, notCreated = false, unrecognized = false, absent = false, lateIds, hostProblem = false, noAutoBind = false } = {}) {
    super(message); this.name = 'AppError'; this.code = code;
    // race：候选在提交前被他人抢走或库存/价格变化，属于正常竞争，立即重查、不计错误、不退避。
    this.retryable = retryable || race; this.status = status;
    if (race) this.race = true;
    // notCreated：点击后平台明确拒绝，且两次读取实例列表都没有新实例，可清除提交记录。
    if (notCreated) this.notCreated = true;
    // unrecognized：确认未创建，但没有识别出平台给出的原因（例如页面没有任何新提示）。
    if (unrecognized) this.unrecognized = true;
    // absent：所选地区的页面筛选中没有该 GPU 型号。
    if (absent) this.absent = true;
    // lateIds：延迟创建保护发现的新实例 ID。
    if (Array.isArray(lateIds)) this.lateIds = lateIds;
    // hostProblem：点击之前就发现这台主机满足不了任务（如起租卡数），换主机并暂时不选它。
    if (hostProblem) this.hostProblem = true;
    // noAutoBind：平台已明确拒绝，但实例列表出现了新实例；它可能属于别的任务或手动创建，不自动绑定，交给用户核对。
    if (noAutoBind) this.noAutoBind = true;
    if (conflict) this.conflict = conflict;
    // 可短暂自愈但不能无限重试的页面问题：连续失败超过次数后转人工处理。
    if (Number.isInteger(maxRetries)) this.maxRetries = maxRetries;
  }
}
export const fail = (code, message, options) => { throw new AppError(code, message, options); };
export const messageOf = error => String(error?.message || error).slice(0, 800);
export function redact(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/https?:\/\/[^\s"<>]+/g, '[网址已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[隐藏]')
    .replace(/(\b(?:cookie|set-cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[隐藏]')
    .replace(/((?:x-api-key|api[_-]?key|access[_-]?token|token|password|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '$1[隐藏]')
    .slice(0, 1200);
}

