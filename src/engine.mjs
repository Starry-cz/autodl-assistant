import { randomUUID } from 'node:crypto';
import { AppError, messageOf, redact, fail } from './errors.mjs';
import { selectCandidate, verifyQuote, assessInstance, gpuKey } from './matching.mjs';
import { minimumBudget, availableMilli } from './wallet.mjs';
import { coolHost, isCooled, cooldownNote, carryRejections } from './host-cooldown.mjs';
import { validateBootSource } from './instances.mjs';
import { beginCheck, finishCheck, marketSample, bootSample, failedSample } from './task-monitor.mjs';
const ACTIVE = new Set(['queued', 'watching', 'preparing', 'submitting', 'verifying']);
const stopped = t => ['paused', 'cancelled'].includes(t.state);
// 点击前余额结果最多可沿用的时长；发现候选时已并行刷新，正常情况下不再额外请求。
const BALANCE_CLICK_MAX_AGE = 15000;
// 人工要求重新核对点击结果前，距点击至少经过的时间。
const RECHECK_MIN_AGE = 2 * 60000;
// 点击结果核对从实际点击时算起（意图落盘到点击之间可能有余额刷新、源实例复核等十几秒）；旧记录没有点击时间时用意图时间。
const clickTime = op => op?.clickedAt || op?.at;
// 已提交任务等待运行/复制完成的 30 分钟从点击算起；用户恢复任务时重新计时。
const verifySince = t => t.verifySince || clickTime(t.operation);
const VERIFY_TIMEOUT = 30 * 60000;
// AutoDL 下单页：租用多卡实例时钱包余额需大于 10 元（单位：千分之一元）。
const MULTI_CARD_MIN_MILLI = 10001;
export class Engine {
  constructor(store, adapters, notifier, { clock = () => Date.now(), random = Math.random, wallet = null, verifyOwner = null } = {}) {
    this.wallet = wallet; this.store = store; this.adapters = adapters; this.notifier = notifier; this.clock = clock; this.random = random;
    this.busy = false; this.timer = null; this.stopping = false; this.started = false; this.browserWaiters = 0; this.failedTickUntil = 0;
    this.verifyOwner = verifyOwner;
    // 适配器对账时排除别的任务已绑定的实例，避免把别的任务新建的实例当成本任务的。
    for (const adapter of Object.values(adapters || {})) if (adapter && typeof adapter === 'object') adapter.claimedIds = t => this.claimedIds(t);
    this.recover();
  }
  claimedIds(t) {
    return new Set(this.store.tasks().filter(o => o.id !== t.id && o.ownerId === t.ownerId).map(o => o.operation?.receipt?.instanceId).filter(Boolean));
  }
  // 另一个任务（同型号、同卡数、地区有重叠）有尚未绑定实例的提交时，本任务不提交：两边同时等结果时分不清新实例属于谁。
  pendingOverlap(t) {
    return this.store.tasks().find(o => o.id !== t.id && o.ownerId === t.ownerId && o.config.provider === 'autodl' && o.operation && !o.operation.receipt?.instanceId
      && gpuKey(o.config.gpuModel) === gpuKey(t.config.gpuModel) && o.config.gpuCount === t.config.gpuCount
      && o.config.regions.some(r => t.config.regions.includes(r))) || null;
  }
  // 此前有被拒绝或确认未创建的点击之后，另一台主机出现了与任务相符的新实例：可能多租了一台，提醒一次。
  notePossibleDuplicates(t, ids) {
    const fresh = (Array.isArray(ids) ? ids : []).filter(id => !(t.duplicateSuspectIds || []).includes(id));
    if (!fresh.length) return;
    this.store.patch(t, { duplicateSuspectIds: [...(t.duplicateSuspectIds || []), ...fresh].slice(-10) });
    const message = '此前有一次点击被平台拒绝或确认未创建，之后实例列表又出现了与本任务相符的新实例 ' + fresh.slice(0, 3).join('、')
      + '，可能是平台延迟创建，等于多租了一台。请到 AutoDL 核对，不需要的实例请自行释放（本程序不会释放实例）';
    this.store.log(t, 'warn', message); this.alert(t, 'possible-duplicate', message);
  }
  recover() {
    for (const t of this.store.tasks()) {
      if (t.config.provider!=='autodl') continue;
      // 只落盘了操作意图、还没进入点击：不论任务此时是暂停、已停止还是进行中，都清除这条记录（适配器必须在 mark 之后才点击）。
      // 否则暂停后进程被强行结束，这条意图会永久挡住恢复、重新核对和同型号/同源的新任务。
      if (t.operation?.stage === 'intent') {
        this.store.patch(t, { state: ACTIVE.has(t.state) ? 'paused' : t.state, operation: null });
        this.store.log(t, 'warn', ACTIVE.has(t.state) ? '服务重启：此前尚未进入提交点击，任务已暂停，可恢复重新检查' : '服务重启：清除了尚未进入点击的操作意图（没有点击付费按钮）');
        continue;
      }
      if (!ACTIVE.has(t.state)) continue;
      if (t.operation) {
        const known = !!t.operation.receipt?.instanceId, unclear = !known && t.operation.stage === 'click_started';
        // 点击结果不明的提交：保留记录，到点击约2分钟后自动读取实例列表核对，不需要先手动处理。
        this.store.patch(t, { state: known || unclear ? 'verifying' : 'reconciling', nextCheckAt: unclear ? clickTime(t.operation) + RECHECK_MIN_AGE : this.clock() });
        this.store.log(t, 'warn', known
          ? '服务重启：仅继续验证已绑定目标实例，不会重新创建'
          : unclear ? '服务重启：保留点击结果不明的提交记录，将在点击约2分钟后自动核对实例列表，绝不重复创建'
          : '服务重启：保留提交记录，需先核对目标实例，绝不重复创建');
        if (!known && !unclear) this.alert(t, 'restart-reconcile', '服务重启，检测到先前的提交记录，请核对或绑定目标实例');
      } else this.store.patch(t, { state: 'watching', nextCheckAt: this.clock() });
    }
  }
  start() { if (!this.started) { this.started = true; this.wake(); } }
  // 到期任务不再等下一个 500ms 刻度；每轮仍只执行一个任务，再让出事件循环给页面请求。
  // 空闲心跳继续负责通知重试与状态变化；用户已在等待页面锁时先交给该请求。
  wake() {
    if (!this.started || this.stopping) return;
    clearTimeout(this.timer);
    let delay = 500;
    if (!this.busy && !this.browserWaiters) {
      const next = this.store.tasks().filter(t => t.config.provider === 'autodl' && ACTIVE.has(t.state));
      for (const task of next) delay = Math.min(delay, Math.max(0, task.nextCheckAt - this.clock()));
    }
    // 持久化等未被任务处理的异常可能让任务仍然到期；保留失败轮次的节流，外部唤醒也不能绕过。
    delay = Math.max(delay, this.failedTickUntil - this.clock());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(error => console.error(redact(messageOf(error))));
    }, delay);
  }
  async stop() { this.stopping = true; this.started = false; clearTimeout(this.timer); this.timer = null;
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 50)); }
  alert(t, event, message) { this.store.enqueueNotification(t, event, message); }
  // 首页优先任务：到期才完整翻页；没有扫描策略的旧任务保持每轮完整翻页。
  scanScope(t) {
    if (t.config.scanScope !== 'first-page') return 'full';
    return Number.isFinite(t.lastFullScanAt) && this.clock() - t.lastFullScanAt < t.config.fullScanSeconds * 1000 ? 'first-page' : 'full';
  }
  // 正常轮次从上一轮开始时计时：一轮本身超过间隔时下一轮立即开始。出错时从现在起按次数退避。
  schedule(t, { error = false, from = null } = {}) {
    if (stopped(t) || this.stopping) return;
    const base = t.config.pollSeconds * 1000;
    const delay = Math.round((error ? Math.min(300000, base * 2 ** Math.min(t.errors, 4)) : base) * (1 + this.random() * 0.12));
    // 只在整轮成功后清零；库存读取成功但后续准备连续失败时，仍须累积退避。
    this.store.patch(t, { nextCheckAt: !error && Number.isFinite(from) ? Math.max(this.clock(), from + delay) : this.clock() + delay,
      ...(!error ? { errors: 0 } : {}) });
  }
  // 余额预检（不付费）：按页面单卡价估算预计时长的费用下限，余额确定不够时提醒一次并跳过本次准备，继续监测；充值后自动恢复。
  // 没有发现候选时最多每5分钟查一次余额；发现候选时不额外等待，只在此前提示过不足时重新查询，以便充值后立即提交。
  async lowBalance(t, hosts, host) {
    if (t.config.action !== 'execute' || !t.config.balanceGuard || typeof this.wallet?.recentBalance !== 'function') return false;
    // 没有连接余额 Token：监测时就提醒一次，不要等找到空闲 GPU 才在付费前停下；连接后自动恢复。
    if (this.wallet.publicState?.().configured === false) {
      if (!t.balanceLow) {
        const message = '余额保护已开启，但没有连接 AutoDL 开发者 Token：找到空闲 GPU 也不会提交。请在“账户余额”中连接 Token，或关闭此任务的余额保护；程序继续监测，连接后自动恢复';
        this.store.log(t, 'warn', message); this.alert(t, 'balance-low', message);
        this.store.patch(t, { balanceLow: { at: this.clock(), message, kind: 'token' } });
      }
      return !!host;
    }
    if (t.balanceLow?.kind === 'token') { this.store.patch(t, { balanceLow: null }); this.store.log(t, 'info', '余额 Token 已连接，恢复自动提交'); }
    const prices = (host ? [host] : hosts.filter(h => gpuKey(h.gpuModel) === gpuKey(t.config.gpuModel) && t.config.regions.includes(h.region)))
      .map(h => h.price).filter(price => Number.isFinite(price) && price > 0);
    const price = prices.length ? Math.min(...prices) : null, need = price && minimumBudget(t.config, price);
    if (!need) return false;
    let snapshot;
    // 余额不足提醒后：找到空闲 GPU 时重新查询（充值后马上能提交）；没有候选时最多每5分钟查一次。
    try { snapshot = host && !t.balanceLow ? this.wallet.snapshot : await this.wallet.recentBalance(host ? 0 : 300000); } catch { return false; }
    if (!snapshot) return false;
    const available = availableMilli(snapshot, t.config);
    // AutoDL 下单页的规则：租多卡时钱包余额（不含代金券）需大于 10 元，否则弹出“余额不足”（2026-10-30 读取其公开前端代码）。
    const multiCardShort = t.config.gpuCount > 1 && Math.round((snapshot.balance || 0) * 1000) < MULTI_CARD_MIN_MILLI;
    if (available >= need.requiredMilli && !multiCardShort) {
      if (t.balanceLow) { this.store.patch(t, { balanceLow: null }); this.store.log(t, 'info', '余额已足够，恢复自动提交'); }
      return false;
    }
    const message = multiCardShort && available >= need.requiredMilli
      ? `钱包余额 ¥${(snapshot.balance || 0).toFixed(2)}：AutoDL 规定租用多卡实例时钱包余额需大于 10 元（代金券不计），找到空闲 GPU 也无法提交，请先充值。程序继续监测，充值后自动恢复`
      : `可用余额 ¥${(available / 1000).toFixed(2)}，不足页面单卡价 ¥${price}/时 × ${t.config.gpuCount} 卡 × ${need.hours} 小时${t.config.balanceReserve ? ' + 保留余额' : ''} ≈ ¥${need.required.toFixed(2)}；找到空闲 GPU 也无法提交，请先充值。程序继续监测，充值后自动恢复`;
    if (!t.balanceLow) { this.store.log(t, 'warn', message); this.alert(t, 'balance-low', message); }
    this.store.patch(t, { balanceLow: { at: this.clock(), message } });
    return true;
  }
  async tick() {
    if (this.busy || this.stopping || this.browserWaiters || this.clock() < this.failedTickUntil) { this.wake(); return; }
    this.busy = true;
    try {
      const now = this.clock();
      const task = this.store.tasks().filter(t => t.config.provider==='autodl' && ACTIVE.has(t.state) && t.nextCheckAt <= now).sort((a,b) => a.nextCheckAt - b.nextCheckAt)[0];
      if (task) await this.step(task);
    } catch (error) {
      // 不补写状态或重新提交；只限制调度频率，让原异常继续上抛并记录。
      this.failedTickUntil = this.clock() + 500;
      throw error;
    } finally { this.busy = false; this.wake(); }
    // 通知不占用 GPU 资源检查的互斥锁。
    if (!this.stopping) void this.notifier.flush().catch(e => console.error(redact(messageOf(e))));
  }
  async step(t) {
    if(t.config.provider!=='autodl' || stopped(t) || this.stopping) return;
    // 每轮先确认账号；不允许在另一个已登录账号里继续原任务。
    if(this.verifyOwner) {
      try { await this.verifyOwner(t); }
      catch(error) {
        // 核验响应可能晚于用户取消或正常停机，不能再覆盖已确定的任务状态。
        if (stopped(t) || this.stopping) return;
        this.store.patch(t,{state:'paused',lastError:redact(messageOf(error))});this.store.log(t,'warn',redact(messageOf(error)));return;
      }
    }
    if (stopped(t) || this.stopping) return;
    if(t.config.mode === 'boot') return this.stepBoot(t);
    const adapter = this.adapters[t.config.provider];
    let roundStart = this.clock(), clickedAt = null, phase = 'probe', candidateHost = null;
    try {
      if (t.operation) { phase = 'check'; await this.checkResult(t, adapter); return; }
      if (this.clock() >= t.deadlineAt) {
        this.store.patch(t, { state: 'expired' }); this.alert(t, 'expired', '监测时限已到，尚未提交租用'); return;
      }
      roundStart = this.clock();
      this.store.patch(t, { state: 'watching', attempts: t.attempts + 1 });
      const scope = this.scanScope(t);
      // 最近被平台拒绝下单的主机本轮不选（例如“当前主机存储库存已满”，列表上仍显示有空闲 GPU）。
      const cooled = host => isCooled(t.hostCooldowns, host, this.clock());
      const observation = await this.monitorRead(t, 'market', scope, () => adapter.probe(t, { scope, skip: cooled }),
        value => marketSample(t.config, value, { at: this.clock(), scope }));
      if (t.state === 'paused' || t.state === 'cancelled' || this.stopping) return;
      if (observation.source) {
        // 克隆的环境来自源实例：首次读到或有变化时写一条日志，说明按什么筛选目标主机。
        const before = t.source, now = observation.source;
        if (!before || before.sourceCuda !== now.sourceCuda || before.extraDiskGB !== now.extraDiskGB)
          this.store.log(t, 'info', `已只读读取源实例：${now.gpuModel || '型号未知'} × ${now.gpuCount ?? '?'}，镜像 CUDA ${now.sourceCuda || '未知'}`
            + (t.config.copyDataDisk !== false ? `，数据盘扩容 ${now.extraDiskGB ?? 0} GB` : '') + `；目标 ${t.config.gpuModel} × ${t.config.gpuCount}，按源环境 CUDA 筛选宿主驱动`);
        this.store.patch(t, { source: observation.source });
      }
      const usable = observation.hosts.filter(h => !cooled(h)), skipped = observation.hosts.length - usable.length;
      const host = selectCandidate(usable, t.config, observation.source); candidateHost = host;
      const note = skipped ? cooldownNote(t.hostCooldowns, this.clock()) : '';
      const summary = [observation.summary, note].filter(Boolean).join('；');
      this.store.patch(t, { lastScan: { at: this.clock(), count: observation.hosts.length, scope: observation.scope || 'full',
        complete: observation.complete === true, summary, candidate: host || null }, lastError: null,
        ...(observation.complete === true ? { lastFullScanAt: roundStart } : {}) });
      const short = await this.lowBalance(t, usable, host);
      if (t.state === 'paused' || t.state === 'cancelled' || this.stopping) return;
      if (!host) { this.store.patch(t, { retryStreak: 0 }); this.store.log(t, 'info', summary || '暂无同时满足型号、CUDA、容量及预算的 GPU'); this.schedule(t, { from: roundStart }); return; }
      // 记录命中的候选，之后核验失败时日志能看出失败发生在配置报价阶段。
      this.store.log(t, 'info', `${summary || '找到合格候选'}。候选：${host.region} ${host.number ? host.number + ' ' : ''}${host.gpuModel}，空闲 ${host.available}${host.total ? '/' + host.total : ''}，单卡 ¥${host.price}/时；${short ? (t.balanceLow?.kind === 'token' ? '没有连接余额 Token，未核验和提交' : '余额不足，未核验和提交，请先充值') : '开始核验配置与完整报价'}`);
      if (short) { this.schedule(t, { from: roundStart }); return; }
      const overlap = t.config.action === 'execute' ? this.pendingOverlap(t) : null;
      if (overlap) {
        this.store.log(t, 'warn', '任务“' + (overlap.config.name || overlap.id) + '”（同型号、同卡数）的提交还在等待核对结果；本任务暂不提交，避免分不清新实例属于哪个任务。请先处理那个任务');
        this.schedule(t, { from: roundStart }); return;
      }
      const guarded = t.config.action === 'execute' && t.config.balanceGuard && typeof this.wallet?.refresh === 'function';
      // 余额与表单准备并行刷新，点击前只需确认结果足够新。
      if (guarded) void this.wallet.refresh({ force: true }).catch(() => {});
      this.store.patch(t, { state: 'preparing' });
      const quote = await adapter.prepare(t, host, observation.source);
      if (t.state === 'paused' || t.state === 'cancelled' || this.stopping) return;
      const reasons = verifyQuote(quote, t.config, observation.source);
      if (reasons.length) throw new AppError('QUOTE', `提交前校验未通过：${reasons.join('、')}`);
      this.store.patch(t, { quote, retryStreak: 0 });
      const prepared = quote.timing ? `配置核验用时 ${(quote.timing.totalMs / 1000).toFixed(1)} 秒（${quote.timing.reused ? '沿用扫描页面' : '重新打开页面'}，实例基线并行读取）` : '配置核验完成';
      if (t.config.action === 'observe') {
        this.store.patch(t, { state: 'found', errors: 0 }); this.store.log(t, 'info', `${prepared}；发现符合条件的 GPU，已停止在付费提交之前`);
        this.alert(t, 'found', `找到 ${host.region} ${t.config.gpuModel} × ${t.config.gpuCount}，配置报价 ¥${quote.hourly}/时，磁盘 ¥${quote.storageDaily}/日；当前为仅监测任务，未租用`); return;
      }
      const checkBalance = async (freshQuote, maxAge) => {
        if (t.config.provider !== 'autodl' || !t.config.balanceGuard) return;
        if (!this.wallet) fail('BALANCE_SERVICE', '余额保护服务不可用，未提交');
        const result = await this.wallet.check(t.config, freshQuote, maxAge ? { maxAge } : {});
        this.store.patch(t, { balanceCheck: result });
      };
      await checkBalance(quote);
      if (stopped(t) || this.stopping) return;
      const op = { id: randomUUID(), stage: 'intent', at: this.clock(), quote,
        baselineIds: quote.baselineIds, sourceId: t.config.sourceId };
      this.store.patch(t, { operation: op, state: 'submitting' });
      this.store.log(t, 'info', `${prepared}；操作意图已落盘，准备一次性提交`);
      phase = 'submit';
      const receipt = await adapter.submit(t, quote, () => {
        if (this.stopping) throw new AppError('ENGINE_STOPPING', '后台正在停止，未点击付费按钮');
        if (t.state === 'paused' || t.state === 'cancelled') throw new AppError('STOPPED', '任务已暂停，未点击付费按钮');
        // 页面准备和余额核对可能跨过截止时间，真正点击前再检查一次。
        if (this.clock() >= t.deadlineAt) throw new AppError('TASK_DEADLINE', '监测时限已到，未点击租用提交按钮');
        if (t.config.provider === 'autodl' && t.config.balanceGuard) this.wallet.confirm(t.balanceCheck);
        clickedAt = this.clock();
        this.store.patch(t, { operation: { ...t.operation, stage: 'click_started', clickedAt } });
      }, freshQuote => checkBalance(freshQuote, BALANCE_CLICK_MAX_AGE));
      if (t.operation?.stage !== 'click_started') throw new AppError('ADAPTER_MARK', '适配器未确认持久化提交边界，已停止');
      this.store.patch(t, { operation: { ...t.operation, stage: 'accepted', receipt }, state: stopped(t) ? t.state : 'verifying', unclearStreak: 0 });
      this.notePossibleDuplicates(t, receipt?.lateIds);
      this.alert(t, 'submitted', `创建请求已提交${receipt.instanceId ? `，目标实例 ${receipt.instanceId}` : ''}；正在验证 GPU 运行${t.config.mode === 'clone' && t.config.copyDataDisk !== false ? '及数据盘复制。请勿在复制完成前写入目标数据盘' : t.config.mode === 'clone' ? '；本次未复制数据盘' : ''}`);
      this.store.log(t, 'info', `提交已返回（本轮开始到点击 ${((clickedAt - roundStart) / 1000).toFixed(1)} 秒），正在核对目标实例与数据盘进度`);
      this.schedule(t);
    } catch (error) {
      if (t.operation?.stage === 'intent') this.store.patch(t, { operation: null });
      if (error.code === 'TASK_DEADLINE') {
        this.store.patch(t, { state: 'expired' }); this.store.log(t, 'info', error.message);
        this.alert(t, 'expired', '监测时限已到，尚未提交租用'); return;
      }
      // 后台正常停止发生在点击之前：不改任务状态、不发通知，重启后照常继续监测。
      if (error.code === 'ENGINE_STOPPING') { this.store.log(t, 'warn', '后台正在停止，本轮未点击付费按钮；重启后继续监测'); return; }
      // 停机期间尚未点击的准备/余额请求只收尾，留待重启后重新检查；已点击记录仍须走下方对账。
      if (this.stopping && !t.operation) return;
      // 延迟创建保护停下任务时记住这些新实例：用户核对后恢复或重建任务，只放过这些，不清除其余拒绝证据。
      if (error.code === 'SUBMIT_LATE' && Array.isArray(error.lateIds)) this.store.patch(t, { lateInstanceIds: error.lateIds });
      const clickNote = clickedAt ? `（本轮开始到点击 ${((clickedAt - roundStart) / 1000).toFixed(1)} 秒）` : '';
      // 点击后平台明确拒绝，且两次读取实例列表都没有新实例：清除提交记录，保留拒绝证据，供后续检查延迟创建。
      if (t.operation?.stage === 'click_started' && error.notCreated === true) {
        const rejection = { at: this.clock(), message: redact(messageOf(error)).slice(0, 300), operationId: t.operation.id,
          baselineIds: t.operation.baselineIds || [], hostNumber: t.operation.quote?.host?.number || '' };
        // 没有识别出原因的未创建连续出现时提醒一次（例如页面需要人工确认），但不停止，继续监测。
        const streak = error.unrecognized ? (t.unclearStreak || 0) + 1 : 0;
        // 与主机有关的拒绝（不含账户问题、GPU 架构不符）：这台主机暂时不选，下一轮试其他主机。
        const cool = error.race === true ? coolHost(t.hostCooldowns, t.operation.quote?.host, messageOf(error), this.clock()) : null;
        this.store.patch(t, { operation: null, unclearStreak: streak, submitRejections: [...(t.submitRejections || []), rejection].slice(-5),
          ...(cool?.record ? { hostCooldowns: cool.list } : {}) });
        this.store.log(t, 'warn', `${error.unrecognized ? '点击后没有识别出结果' : '点击后平台拒绝创建'}${clickNote}，两次核对实例列表均无新实例，已清除本次提交记录`
          + (cool?.record ? `；${cool.record.hostNumber || '该主机'}约 ${Math.round((cool.record.until - cool.record.at) / 60000)} 分钟内不再选择，先试其他主机` : ''));
        if (streak >= 2) this.alert(t, 'unclear-clicks', '连续 ' + streak + ' 次点击“创建并开机”后都没有识别出结果（均已确认未创建），程序仍在继续监测；请看一眼专用浏览器中点击后出现的提示');
      }
      if (t.operation?.stage === 'accepted' && t.operation.receipt?.acceptedAt && error.retryable === true && !stopped(t)) {
        // 已提交任务只重试读取结果，不再次执行付费提交。
        this.store.patch(t, { errors: t.errors + 1, lastError: redact(messageOf(error)) });
        this.store.log(t, 'warn', redact(messageOf(error)));
        if (this.clock() - verifySince(t) >= VERIFY_TIMEOUT) {
          this.store.patch(t, { state: 'attention' });
          this.alert(t, 'verify-timeout', '已提交实例的状态持续无法确认，请检查 AutoDL；任务不会再次创建');
        } else {
          this.store.patch(t, { state: 'verifying' }); this.schedule(t, { error: true });
        }
      } else if (t.operation) {
        const op = t.operation, unclear = op.stage === 'click_started' && !op.receipt?.instanceId;
        const session = ['LOGIN_REQUIRED','HUMAN_REQUIRED','LOGIN_CHECK_REQUIRED','BROWSER_NETWORK_DENIED'].includes(error.code);
        const failures = phase === 'check' ? (op.recheckFailures || 0) + 1 : 0;
        if (unclear && !stopped(t) && !session && failures < 3) {
          // 点击结果不明：保留提交记录，约2分钟后自动读取完整实例列表核对，不再次创建，也不需要手动点“重新核对”。
          const progress = phase === 'check' ? '自动核对实例列表未完成，30 秒后再试；不会再次创建' : '点击结果暂不明确，约 2 分钟后自动核对实例列表；不会再次创建';
          this.store.patch(t, { state: 'verifying', lastError: null, lastProgress: progress, operation: { ...op, recheckFailures: failures, ...(error.noAutoBind ? { noAutoBind: true } : {}) },
            nextCheckAt: phase === 'check' ? this.clock() + 30000 : clickTime(op) + RECHECK_MIN_AGE });
          this.store.log(t, 'warn', `${phase === 'check' ? '自动核对实例列表未完成' : '点击后结果暂不明确' + clickNote}：${redact(messageOf(error))}。${progress}`);
        } else {
          this.store.patch(t, { state: stopped(t) ? t.state : 'reconciling', lastError: redact(messageOf(error)) });
          this.store.log(t, 'error', `提交结果需要核对${clickNote}：${redact(messageOf(error))}`);
          this.alert(t, 'ambiguous', '提交后结果不明确，任务已停止重新创建。请到 AutoDL 核对并绑定目标实例');
        }
      } else if (error.code === 'BALANCE_TOKEN_REQUIRED' && t.state !== 'paused' && t.state !== 'cancelled') {
        // 没有连接余额 Token：不付费提交，但不停止任务；提醒一次，连接 Token 后自动恢复。
        const message = redact(messageOf(error)) + '；程序继续监测，连接后自动恢复';
        if (!t.balanceLow) { this.store.log(t, 'warn', message); this.alert(t, 'balance-low', message); }
        this.store.patch(t, { state: 'watching', lastError: null, balanceLow: { at: this.clock(), message, kind: 'token' } });
        this.schedule(t, { from: roundStart });
      } else if (t.state !== 'paused' && t.state !== 'cancelled' && error.code === 'BALANCE_INSUFFICIENT') {
        // 按完整报价核对余额不足：不点击，继续监测；提醒一次，充值后下次找到空闲 GPU 时自动提交。
        const message = redact(messageOf(error)) + '；程序继续监测，充值后自动恢复';
        if (!t.balanceLow) { this.store.log(t, 'warn', message); this.alert(t, 'balance-low', message); }
        this.store.patch(t, { state: 'watching', lastError: null, balanceLow: { at: this.clock(), message } });
        this.schedule(t, { from: roundStart });
      } else if (t.state !== 'paused' && t.state !== 'cancelled' && error.race === true) {
        // 候选被他人抢走、库存或价格变化：不是故障，不退避，按本轮开始时间立即进入下一轮。
        // 点击前就发现这台主机满足不了任务（如起租卡数）：这台主机暂时不选，下一轮试其他主机。
        const cool = error.hostProblem && candidateHost ? coolHost(t.hostCooldowns, candidateHost, messageOf(error), this.clock()) : null;
        this.store.patch(t, { state: 'watching', lastError: null, retryStreak: 0, raceLosses: (t.raceLosses || 0) + 1, ...(cool?.record ? { hostCooldowns: cool.list } : {}) });
        this.store.log(t, 'warn', `${redact(messageOf(error))}（本轮开始后 ${((this.clock() - roundStart) / 1000).toFixed(1)} 秒）`
          + (cool?.record ? `；${cool.record.hostNumber || '该主机'}约 ${Math.round((cool.record.until - cool.record.at) / 60000)} 分钟内不再选择` : ''));
        const recent = (t.submitRejections || []).filter(r => this.clock() - r.at < 10 * 60000);
        if (recent.length >= 5) this.alert(t, 'repeated-rejections', '10分钟内平台已 ' + recent.length + ' 次拒绝创建，程序仍在继续监测；如非资源紧张，请到 AutoDL 检查账户或配置');
        this.schedule(t, { from: roundStart });
      } else if (t.state !== 'paused' && t.state !== 'cancelled') {
        // maxRetries 限定的页面问题：连续失败超过次数后转人工处理，不无限重试。
        const limited = error.retryable === true && Number.isInteger(error.maxRetries);
        const streak = limited ? (t.retryStreak || 0) + 1 : 0;
        const retryable = error.retryable === true && (!limited || streak <= error.maxRetries);
        const message = redact(messageOf(error)) + (limited ? retryable ? `（第 ${streak}/${error.maxRetries} 次自动重试）` : `（已连续 ${streak} 次，停止自动重试，请检查页面后恢复）` : '');
        this.store.patch(t, { state: retryable ? 'watching' : 'attention', errors: t.errors + 1, lastError: message, retryStreak: streak });
        this.store.log(t, 'error', message);
        if (retryable) this.schedule(t, { error: true });
        else this.alert(t, 'attention', `任务需要处理：${message}`);
      }
    }
  }
  async monitorRead(t, kind, scope, read, sample) {
    this.store.patch(t, { monitor: beginCheck(t.monitor, this.clock()) });
    try {
      const result = await read();
      if (!stopped(t) && !this.stopping) this.store.patch(t, { monitor: finishCheck(t.monitor, sample(result)) });
      return result;
    } catch (error) {
      // 已暂停/停止时只收尾正在结束的请求，不让迟到的错误重新进入退避或人工处理状态。
      if (stopped(t) || this.stopping) return;
      this.store.patch(t, { monitor: finishCheck(t.monitor, failedSample(kind, scope, error, this.clock())) });
      throw error;
    } finally {
      if (t.monitor.checking) this.store.patch(t, { monitor: finishCheck(t.monitor) });
    }
  }
  // 开机始终绑定原实例。与新租用分开执行，不进入主机筛选、创建、克隆或关机路径。
  async stepBoot(t) {
    if (stopped(t) || this.stopping) return;
    // 等待时限只限制新点击；已落盘原实例回执后，与新租/克隆一样独立核对 30 分钟，绝不再次开机。
    const submitted = t.operation?.receipt?.instanceId === t.config.sourceId;
    if (submitted ? this.clock() - verifySince(t) >= VERIFY_TIMEOUT : this.clock() >= t.deadlineAt) {
      const message = t.operation ? '开机已提交，但核对时限内未确认运行；请在 AutoDL 核对原实例，本任务不会再次点击开机' : '等待时限已到，未继续开机';
      this.store.patch(t, { state: t.operation ? 'attention' : 'expired', lastError: t.operation ? message : null });
      this.store.log(t, 'warn', message); this.alert(t, 'boot-timeout', message); return;
    }
    const adapter = this.adapters[t.config.provider];
    const roundStart = this.clock();
    try {
      this.store.patch(t, { attempts: t.attempts + 1, state: t.operation ? 'verifying' : 'watching' });
      const instance = await this.monitorRead(t, 'boot', 'target', async () => validateBootSource(t.config, await adapter.inspectBoot(t)),
        value => bootSample(value, this.clock()));
      if (stopped(t) || this.stopping) return;
      const summary = instance.running ? '原实例已进入 GPU 运行状态' : instance.starting ? '原实例正在开机，等待 GPU 运行确认'
        : instance.gpuAvailable === true ? '原实例所在主机显示 GPU 充足' : instance.gpuAvailable === false ? '原实例所在主机暂无足够 GPU' : '原实例已关机，页面没有明确库存标记';
      this.store.patch(t, { result: instance, lastScan: { at: this.clock(), count: 1, summary, complete: true }, lastError: null });
      if (t.lastProgress !== summary) { this.store.log(t, 'info', summary); this.store.patch(t, { lastProgress: summary }); }
      if (instance.running) {
        this.store.patch(t, { state: 'completed', errors: 0, result: { ...instance, gpuVerified: true } });
        this.alert(t, 'completed', `原实例 ${t.config.sourceId} 已有卡运行，请及时使用并在不用时关机`); return;
      }
      // 提交后即使再次读到“已关机”也只核对，不能把超时或延迟响应解释成拒绝。
      // 提交前的常规检查按本轮起点计时，不叠加读取耗时；已有提交的结果核对仍保持原等待间隔。
      if (t.operation || instance.starting) { this.schedule(t, { from: t.operation ? null : roundStart }); return; }
      if (t.config.action === 'observe') {
        if (instance.gpuAvailable === true) {
          this.store.patch(t, { state: 'found', errors: 0 }); this.alert(t, 'found', `原实例 ${t.config.sourceId} 显示 GPU 充足；当前为只提醒模式，尚未开机`);
        } else this.schedule(t, { from: roundStart });
        return;
      }
      if (instance.gpuAvailable === false) { this.schedule(t, { from: roundStart }); return; }
      this.store.patch(t, { state: 'preparing', operation: { id: randomUUID(), at: this.clock(), stage: 'intent', sourceId: t.config.sourceId } });
      const outcome = await adapter.boot(t, () => {
        if (stopped(t) || this.stopping) throw new AppError('STOPPED', '任务已暂停，未确认开机');
        if (this.clock() >= t.deadlineAt) throw new AppError('BOOT_DEADLINE', '等待时限已到，未确认开机');
        // 在真正付费的确认按钮前落盘，重启后仍只核对这台原实例。
        const clickedAt = this.clock();
        this.store.patch(t, { state: 'submitting', operation: { ...t.operation, stage: 'click_started', clickedAt,
          receipt: { instanceId: t.config.sourceId, acceptedAt: clickedAt } } });
      });
      if (outcome?.noStock || outcome?.rejected || outcome?.notSubmitted) {
        const message = outcome.message || '实例状态已变化，下轮重新读取';
        this.store.patch(t, { operation: null, state: stopped(t) ? t.state : outcome.rejected ? 'attention' : 'watching', lastError: outcome.rejected ? message : null });
        this.store.log(t, outcome.rejected ? 'error' : 'info', message);
        if (!stopped(t) && !outcome.rejected) this.schedule(t);
        if (outcome.rejected) this.alert(t, 'boot-rejected', message);
        return;
      }
      if (t.operation?.stage !== 'click_started') throw new AppError('BOOT_MARK', '开机适配器未记录确认按钮的提交边界');
      this.store.patch(t, { operation: { ...t.operation, stage: outcome?.unclear ? 'click_started' : 'accepted' }, state: stopped(t) ? t.state : 'verifying' });
      this.store.log(t, 'info', outcome?.unclear ? '开机确认已点击，但平台结果尚不明确；只核对原实例，不重复点击' : '已确认原实例开机，接下来只读取运行状态，不重复点击');
      if (!stopped(t)) this.schedule(t);
    } catch (error) {
      if (t.operation?.stage === 'intent') this.store.patch(t, { operation: null });
      if (stopped(t) || this.stopping) return;
      // 进入确认弹窗后才到期仍属于正常结束，没有点击时不误报为需要人工处理。
      if (error.code === 'BOOT_DEADLINE' && !t.operation) {
        this.store.patch(t, { state: 'expired', lastError: null });
        this.store.log(t, 'info', error.message); this.alert(t, 'boot-timeout', '等待时限已到，未继续开机'); return;
      }
      const message = redact(messageOf(error));
      // 只有本次点击明确收到“缺卡”才允许再提交；传输错误或未知弹窗都保留提交记录。
      const verifying = !!t.operation && !['BOOT_SOURCE', 'BOOT_MISMATCH', 'LOGIN_REQUIRED', 'HUMAN_REQUIRED', 'LOGIN_CHECK_REQUIRED'].includes(error.code);
      // 未提交前仅复用适配器明确标为可重试的读取错误，不把页面/账号问题一概重试。
      const readRetry = !t.operation && error.retryable === true && (!Number.isInteger(error.maxRetries) || t.errors < error.maxRetries);
      this.store.patch(t, { state: verifying ? 'verifying' : readRetry ? 'watching' : 'attention', lastError: message, errors: t.errors + 1 });
      this.store.log(t, 'warn', message + (t.operation ? '；保留提交记录，后续只核对原实例' : ''));
      if (verifying || readRetry) this.schedule(t, { error: true }); else this.alert(t, 'boot-attention', message);
    }
  }
  async checkResult(t, adapter) {
    const status = await adapter.reconcile(t);
    if (stopped(t)) return;
    this.store.patch(t, { lastError: null, errors: 0 });
    this.notePossibleDuplicates(t, status.lateIds);
    // 点击结果不明的提交经自动核对确认未创建：清除记录，立即继续监测；连续出现时提醒一次，不停止任务。
    if (status.notCreated && t.operation.stage === 'click_started' && !t.operation.receipt?.instanceId) {
      const op = t.operation, streak = (t.unclearStreak || 0) + 1;
      const rejection = { at: this.clock(), message: '点击结果不明，自动核对确认未创建', operationId: op.id, baselineIds: op.baselineIds || [], hostNumber: op.quote?.host?.number || '' };
      // 这台主机点击后没有结果：暂时不选，先试其他主机。
      const cool = coolHost(t.hostCooldowns, op.quote?.host, '点击后没有识别出结果', this.clock());
      this.store.patch(t, { operation: null, unclearStreak: streak, lastProgress: null, nextCheckAt: this.clock(),
        submitRejections: [...(t.submitRejections || []), rejection].slice(-5), state: 'watching', ...(cool.record ? { hostCooldowns: cool.list } : {}) });
      this.store.log(t, 'warn', status.reason + '；已清除提交记录，继续监测'
        + (cool.record ? `；${cool.record.hostNumber || '该主机'}约 ${Math.round((cool.record.until - cool.record.at) / 60000)} 分钟内不再选择，先试其他主机` : ''));
      if (streak >= 2) this.alert(t, 'unclear-clicks', '连续 ' + streak + ' 次点击“创建并开机”后都没有识别出结果（均已确认未创建），程序仍在继续监测；请看一眼专用浏览器中点击后出现的提示');
      return;
    }
    if (status.pending) {
      if (t.lastProgress !== status.reason) {
        this.store.log(t, 'info', status.reason); this.store.patch(t, { lastProgress: status.reason });
      }
      if (this.clock() - verifySince(t) >= VERIFY_TIMEOUT) {
        this.store.patch(t, { state: 'attention' });
        this.alert(t, 'verify-timeout', '提交已受理，但目标实例状态长时间未更新，请检查 AutoDL；任务不会再次创建');
      } else { this.store.patch(t, { state: 'verifying' }); this.schedule(t); }
      return;
    }
    if (status.ambiguous) {
      this.store.patch(t, { state: 'reconciling' }); this.store.log(t, 'warn', status.reason);
      this.alert(t, 'ambiguous', status.reason); return;
    }
    if (status.receipt) this.store.patch(t, { operation: { ...t.operation, receipt: status.receipt, stage: 'accepted' }, unclearStreak: 0 });
    const instance = status.instance;
    if (!instance) throw new AppError('VERIFY', '没有得到可核对的目标实例');
    if (t.manualDataVerifiedAt) instance.copyComplete = true;
    const assessed = assessInstance(instance, t.config.mode, t.config.copyDataDisk !== false);
    this.store.patch(t, { state: assessed.state, result: instance });
    if (t.lastProgress !== (instance.progress || assessed.reason)) {
      this.store.log(t, 'info', instance.progress || assessed.reason);
      this.store.patch(t, { lastProgress: instance.progress || assessed.reason });
    }
    if (assessed.state === 'completed') {
      this.store.log(t, 'info', assessed.reason);
      this.alert(t, 'completed', `${assessed.reason}。实例 ID：${instance.id}。请及时使用，GPU 运行和扩容磁盘按平台规则计费`);
    } else if (assessed.state === 'attention') this.alert(t, 'copy-or-start-failure', assessed.reason);
    else if (this.clock() - verifySince(t) > VERIFY_TIMEOUT) {
      this.store.patch(t, { state: 'attention' });
      this.alert(t, 'verify-timeout', '实例已提交，但30分钟内未确认 GPU 运行及数据复制完成；请检查目标实例。任务不会重复创建');
    } else this.schedule(t);
  }
  control(t, action, value = {}) {
    if(t.config.provider!=='autodl') fail('PROVIDER_REMOVED','旧版演练任务已停用，无法继续执行',{status:410});
    if (action === 'pause') {
      if (!ACTIVE.has(t.state)) fail('STATE', '当前状态不能暂停');
      this.store.patch(t, { state: 'paused' }); this.store.log(t, 'warn', '已暂停后续检查；已经提交的实例不会被自动关机或删除');
    } else if (action === 'resume') {
      // 已停止的开机任务仍有固定实例回执时，只恢复核对，避免留下无法处理的占用记录。
      const cancelledBootCheck = t.state === 'cancelled' && t.config.mode === 'boot' && t.operation?.receipt?.instanceId === t.config.sourceId;
      if (!['paused','attention','found','expired','reconciling'].includes(t.state) && !cancelledBootCheck) fail('STATE', '当前状态不能恢复');
      if (t.operation && !t.operation.receipt) fail('RECONCILE', '请先核对并绑定目标实例，提交记录仍被保留');
      // 拒绝证据（30 分钟内的延迟创建保护）不随恢复清除；只把用户已核对过的那几台延迟实例记为已知。
      // 已提交的任务恢复后重新等待 30 分钟，不会刚恢复就再次超时。
      // 人工恢复开启新的重试周期，旧的连续错误次数不能立即耗尽本次重试额度。
      this.store.patch(t, { state: t.operation ? 'verifying' : 'watching', nextCheckAt: this.clock(),
        deadlineAt: this.clock() + t.config.timeoutMinutes * 60000, lastError: null, errors: 0, retryStreak: 0, unclearStreak: 0,
        submitRejections: carryRejections(t, this.clock()), lateInstanceIds: null, ...(t.operation ? { verifySince: this.clock() } : {}),
        notifyEpoch: (t.notifyEpoch || 0) + 1 });
      this.store.log(t, 'info', cancelledBootCheck ? '继续核对原实例；保留原开机回执，不再次点击开机' : '已恢复任务');
    } else if (action === 'cancel') {
      if (['completed','cancelled'].includes(t.state)) fail('STATE', '任务已经结束');
      this.store.patch(t, { state: 'cancelled' }); this.store.log(t, 'warn', '本地任务已停止；云端实例和磁盘会保留，已发生的费用需到 AutoDL 管理');
    } else if (action === 'verify-data') {
      if (!t.operation?.receipt || (t.config.mode !== 'clone' || t.config.copyDataDisk === false) || !['attention','verifying','paused'].includes(t.state) || value.confirmed !== true) fail('STATE', '仅可在绑定目标实例后，明确核验数据盘再确认');
      this.store.patch(t, { manualDataVerifiedAt: this.clock(), state: 'verifying', nextCheckAt: this.clock() });
      this.store.log(t, 'warn', '用户已人工确认目标实例的数据盘文件完整；继续核对 GPU 运行状态');
    } else fail('ACTION', '不支持的任务操作');
    this.wake();
  }
  async attach(t, id) {
    if(t.config.mode === 'boot') fail('STATE', '原实例开机已绑定目标 ID，请使用恢复任务继续核对');
    if(t.config.provider!=='autodl') fail('PROVIDER_REMOVED','旧版演练任务已停用，无法绑定实例',{status:410});
    if (this.busy) fail('BUSY', '浏览器正在执行检查，请稍后再绑定', { status: 409 });
    // 已停止但保留提交记录的任务也可以绑定，否则其提交记录会一直阻挡同型号/同源的新任务。
    if (!t.operation || !['reconciling','attention','paused','cancelled'].includes(t.state)) fail('STATE', '当前任务没有需要核对的提交记录');
    const wasCancelled = t.state === 'cancelled';
    this.busy = true;
    try {
      // 身份查询也使用工作页面；先持有同一把锁，避免核验期间被其他任务导航打断。
      if (this.verifyOwner) await this.verifyOwner(t);
      const receipt = await this.adapters[t.config.provider].attach(t, String(id || '').trim());
      // 绑定过程中被停止的任务保持停止；绑定前已停止的任务由用户主动绑定，恢复核对此实例。
      // 人工绑定与恢复一样，重新给予状态核对时间，不按旧点击时间立即判定超时。
      this.store.patch(t, { operation: { ...t.operation, stage: 'accepted', receipt }, state: t.state === 'cancelled' && !wasCancelled ? 'cancelled' : 'verifying', nextCheckAt: this.clock(), verifySince: this.clock() });
      this.store.log(t, 'info', '已绑定经过型号与地区校验的目标实例，后续只检查此实例');
    } finally { this.busy = false; this.wake(); }
  }
  // 点击结果不明的提交：用户确认后重新读取完整实例列表。只有没有任何提交前基线之外的实例时才清除提交记录。
  async recheck(t) {
    if(t.config.provider!=='autodl') fail('PROVIDER_REMOVED','旧版演练任务已停用',{status:410});
    if (this.busy) fail('BUSY', '浏览器正在执行检查，请稍后再核对', { status: 409 });
    const op = t.operation;
    if (!op || op.receipt?.instanceId || !['click_started','accepted'].includes(op.stage) || !['reconciling','attention','paused','cancelled'].includes(t.state))
      fail('STATE', '当前任务没有待核对且未绑定实例的提交记录');
    // 给平台留出创建与列表刷新的时间，避免过早读到空结果。
    if (this.clock() - clickTime(op) < RECHECK_MIN_AGE) fail('TOO_EARLY', '点击后不足2分钟，平台可能仍在创建实例，请稍后再核对', { status: 409 });
    this.busy = true;
    try {
      // 与人工绑定一样，把账号核验和提交结果读取放在同一个互斥区间。
      if (this.verifyOwner) await this.verifyOwner(t);
      const result = await this.adapters[t.config.provider].recheckSubmission(t);
      if (t.operation !== op) fail('TASK_CHANGED', '核对期间提交记录已变化，请刷新后查看', { status: 409 });
      if (result.extra.length) {
        this.store.log(t, 'warn', '重新核对：实例列表有 ' + result.extra.length + ' 个提交前没有的实例（' + result.extra.slice(0, 3).map(i => i.id).join('、') + '），请确认后绑定；提交记录保留');
        return { cleared: false, extra: result.extra };
      }
      const resolved = { operationId: op.id, at: op.at, resolvedAt: this.clock(), outcome: 'not-created', hostNumber: op.quote?.host?.number || '', baselineCount: (op.baselineIds || []).length };
      // 人工核对也保留完整基线，与自动核对共用延迟创建保护；稍后出现旧提交的实例时不能再次租用。
      const rejection = { at: this.clock(), message: '人工重新核对确认未创建', operationId: op.id,
        baselineIds: op.baselineIds || [], hostNumber: op.quote?.host?.number || '' };
      this.store.patch(t, { operation: null, state: t.state === 'cancelled' ? 'cancelled' : 'paused', lastError: null, verifySince: null,
        submitRejections: [...(t.submitRejections || []), rejection].slice(-5),
        resolvedSubmissions: [...(t.resolvedSubmissions || []), resolved].slice(-10) });
      this.store.log(t, 'warn', '用户要求重新核对：完整实例列表中都是提交前已有的实例，确认该次点击未创建实例，已清除提交记录');
      return { cleared: true, extra: [] };
    } finally { this.busy = false; this.wake(); }
  }
}

