import { AppError } from '../errors.mjs';
import { TASK_PRECHECK_LIMITS } from '../config.mjs';
import { gpuKey } from '../matching.mjs';
import { validateBootSource, validateCloneSource } from '../instances.mjs';
import { collectObservatoryPages } from '../observatory.mjs';
import { readAutodlIdentity } from './autodl-account.mjs';
import { readAutodlObservatory } from './autodl-observatory.mjs';
import { catalogRegionHasNoStock, readTaskGpuCatalogApi } from './autodl-inventory.mjs';

const ORIGIN = 'https://www.autodl.com';
const READER_URL = ORIGIN + '/__autodl_helper_readonly__';
const cancelled = () => new AppError('PRECHECK_CANCELLED', '本轮只读预检已取消');
const changed = () => new AppError('LOGIN_CHECK_REQUIRED', '读取期间账号或浏览器会话已变化，请重新核验连接', { status: 409 });

// 此页只承载已经核对的查询。空白文档由本地提供，不额外加载官网界面、脚本和它们的轮询。
// 同源 Cookie/localStorage 仍由同一专用 context 管理，不复制凭据，不允许任何付费接口。
export async function routeReadonlyPrecheck(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (url.href === READER_URL && method === 'GET' && request.isNavigationRequest())
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>AutoDL 只读预检</title>' });
  const path = url.pathname, sameOrigin = url.origin === ORIGIN;
  const identity = method === 'GET' && ['/api/v1/user/detail', '/api/v1/sub_user'].includes(path);
  const regions = method === 'GET' && /^\/api\/v1\/(?:sub_user\/)?region\/list$/.test(path);
  const data = method === 'POST' && /^\/api\/v1\/(?:sub_user\/)?(?:machine\/region\/gpu_type|instance)$/.test(path);
  if (sameOrigin && !request.isNavigationRequest() && (identity || regions || data)) return route.fallback();
  return route.abort('blockedbyclient');
}

// 快照只存在只读页内；返回值仅为是否相同，不把 Token 传到 Node 或日志。
function sessionStamp(begin = false) {
  const current = { token: localStorage.getItem('token'), user: localStorage.getItem('user') };
  if (begin) globalThis.__autodlReadonlySession = current;
  const saved = globalThis.__autodlReadonlySession;
  return !!current.token && !!saved && saved.token === current.token && saved.user === current.user;
}

function sourceFromApi(row) {
  return { id: row.uuid, region: row.region_name, gpuModel: row.gpu_type_name, gpuCount: row.req_gpu_amount,
    stopped: row.status === 'shutdown', running: row.status === 'running', starting: row.status === 'starting',
    cardless: ['running', 'starting'].includes(row.status) && row.start_mode === 'non_gpu',
    failed: ['shutdown_by_starting_error', 'shutdown_by_running_error'].includes(row.status),
    gpuAvailable: null };
}

export class IsolatedTaskPrechecks {
  constructor(adapter) { this.adapter = adapter; this.active = new Set(); this.accepted = new WeakMap(); this.closing = false; }

  run(task, { signal, expectedOwnerId = task.ownerId, maxParallel = TASK_PRECHECK_LIMITS[0] } = {}) {
    if (signal?.aborted || this.closing) return Promise.reject(cancelled());
    if (!TASK_PRECHECK_LIMITS.includes(maxParallel)) return Promise.reject(new AppError('CONFIG', '并行预检数请选择 2 或 3'));
    if (this.active.size >= maxParallel) return Promise.reject(new AppError('PRECHECK_BUSY', '只读预检通道正在使用', { status: 409, retryable: true }));
    // 任务快照不随用户编辑、暂停或恢复而改变；调度器仍须在消费结果时核验 epoch。
    const snapshot = { id: task.id, ownerId: task.ownerId, config: structuredClone(task.config),
      operation: task.operation ? { id: task.operation.id, stage: task.operation.stage } : null };
    const job = { page: null, cancelled: false, done: null, closingPage: null };
    const closePage = () => job.closingPage ||= job.page ? job.page.close().catch(() => {}) : null;
    const abort = () => { job.cancelled = true; void closePage(); };
    job.abort = abort; this.active.add(job);
    signal?.addEventListener('abort', abort, { once: true });
    job.done = this.execute(snapshot, job, expectedOwnerId).finally(async () => {
      signal?.removeEventListener('abort', abort);
      await closePage(); this.active.delete(job);
    });
    return job.done;
  }

  async execute(task, job, expectedOwnerId) {
    const adapter = this.adapter, context = adapter.context, startedAt = Date.now();
    const kind = task.config.mode === 'boot' || task.config.raceBoot ? 'boot' : 'market';
    let evidenceAt = startedAt;
    // 零库存有效期从相关查询开始计时；慢分页/多地区串行读取不能把早先的零刷新成“刚读取”。
    const result = (verdict, extra = {}) => ({ verdict, kind, taskId: task.id, ownerId: expectedOwnerId,
      checkedAt: verdict === 'empty' ? evidenceAt : Date.now(), ...extra });
    // 组合任务只预检原机；boot 的 empty 仅供原机步骤使用，不能替代后续的同区克隆检查。
    if (task.operation || !['create', 'boot', 'clone'].includes(task.config.mode)) return result('unknown');
    if (!context || adapter.session?.state !== 'ready' || !expectedOwnerId || expectedOwnerId !== task.ownerId) throw changed();
    const checkCurrent = () => {
      if (job.cancelled) throw cancelled();
      if (adapter.context !== context || adapter.session?.state !== 'ready') throw changed();
    };
    try {
      job.page = await context.newPage(); checkCurrent();
      await job.page.route('**/*', routeReadonlyPrecheck);
      await job.page.goto(READER_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }); checkCurrent();
      if (!await job.page.evaluate(sessionStamp, true)) throw changed();
      // 每次查询前后比对整个批次的会话；旧账号响应不能变成新账号的“无卡”证据。
      const page = { url: () => job.page.url(), isClosed: () => job.page.isClosed(), evaluate: async (fn, args) => {
        checkCurrent(); if (!await job.page.evaluate(sessionStamp)) throw changed();
        const data = await job.page.evaluate(fn, args);
        checkCurrent(); if (!await job.page.evaluate(sessionStamp)) throw changed();
        return data;
      } };
      // 各读取函数只操作这个局部 facade；认证失败不让迟到的预检改写主页面或新会话状态。
      const reader = { page, session: { state: 'ready' }, setSession() {} };
      const identity = await readAutodlIdentity(reader);
      if (identity.ownerId !== expectedOwnerId) throw changed();
      evidenceAt = Date.now();
      if (task.config.mode !== 'create') {
        const { rows, pagination } = await collectObservatoryPages(({ pageIndex, pageSize }) => readAutodlObservatory(reader,
          'instances', { date_from: '', date_to: '', page_index: pageIndex, page_size: pageSize, status: [], charge_type: [] }), { pageSize: 100, strict: true });
        const matches = rows.filter(row => row.uuid === task.config.sourceId);
        if (!pagination.complete || matches.length !== 1) return result('unknown');
        const raw = matches[0], source = sourceFromApi(raw);
        // 看板字段可能暂缺；这种情况交还既有 DOM 核验，而不把未知状态误当成缺卡。
        try { (kind === 'boot' ? validateBootSource : validateCloneSource)(task.config, source); }
        catch { return result('unknown'); }
        if (kind === 'boot') {
          const countsKnown = Number.isSafeInteger(raw.gpu_idle_num) && raw.gpu_idle_num >= 0
            && Number.isSafeInteger(raw.gpu_all_num) && raw.gpu_all_num >= task.config.gpuCount && raw.gpu_idle_num <= raw.gpu_all_num;
          if (source.stopped && typeof raw.machine_id === 'string' && raw.machine_id.trim() && countsKnown && raw.gpu_idle_num === 0)
            return result('empty', { instance: { ...source, gpuAvailable: false }, summary: '原实例主机明确无空闲 GPU' });
          return result(countsKnown && raw.gpu_idle_num > 0 ? 'candidate' : 'unknown');
        }
      }
      // 每个任务占用一路，任务内地区串行，避免按地区数放大并发请求。
      const catalog = await readTaskGpuCatalogApi(reader, task.config.regions, task.config.gpuModel, { parallelism: 1 });
      const empty = task.config.regions.every(region => catalogRegionHasNoStock(catalog.regions.find(row => row.region === region), task.config.gpuModel));
      const positive = catalog.regions.some(row => row.models?.some(model => gpuKey(model.model) === gpuKey(task.config.gpuModel) && model.available > 0));
      const output = result(empty ? 'empty' : positive ? 'candidate' : 'unknown', { catalogChecked: true });
      if (empty) {
        const duration = Date.now() - startedAt;
        // 克隆源已核验，但 API 不含完整环境字段；不以这份简化记录覆盖原 DOM 源配置。
        output.observation = { source: null, hosts: [], complete: true, scope: 'full', catalogOnly: true,
          catalogTotal: catalog.regions.reduce((sum, row) => sum + row.models.find(model => gpuKey(model.model) === gpuKey(task.config.gpuModel)).total, 0),
          summary: '只读预检确认目标地区无空闲 GPU，本轮无需打开创建页',
          timing: { catalogMs: duration, openMs: 0, filterMs: 0, scanMs: 0, totalMs: duration } };
      }
      this.accepted.set(output, { context, config: JSON.stringify(task.config), ownerId: expectedOwnerId, taskId: task.id });
      return output;
    } catch (error) {
      if (job.cancelled) throw cancelled();
      if (adapter.context !== context) throw changed();
      if (job.page && !job.page.isClosed() && !await job.page.evaluate(sessionStamp).catch(() => false)) throw changed();
      if (error instanceof AppError) throw error;
      throw new AppError('PRECHECK_UNAVAILABLE', '独立只读预检暂未完成，请稍后重试', { status: 503, retryable: true });
    }
  }

  canReuseCatalog(task, result) {
    const saved = result && this.accepted.get(result);
    return !!saved && result.catalogChecked === true && saved.context === this.adapter.context
      && this.adapter.session?.state === 'ready' && saved.ownerId === task.ownerId && saved.taskId === task.id
      && saved.config === JSON.stringify(task.config) && Date.now() - result.checkedAt <= 5000;
  }

  async close() {
    this.closing = true;
    try { const jobs = [...this.active]; jobs.forEach(job => job.abort()); await Promise.allSettled(jobs.map(job => job.done)); }
    finally { this.accepted = new WeakMap(); this.closing = false; }
  }
}
