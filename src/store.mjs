import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { SecretStorage } from './credentials.mjs';
import { canReplaceTask, sameTaskResource } from './task-conflicts.mjs';
import { carryRejections, activeCooldowns } from './host-cooldown.mjs';
import { emptyMonitor, MONITOR_SAMPLE_LIMIT } from './task-monitor.mjs';
export class Store {
  constructor(dir, { clock = () => Date.now(), secretProtector } = {}) {
    this.secretStorage = new SecretStorage(secretProtector);
    this.clock = clock;
    this.dir = path.resolve(dir); this.file = path.join(this.dir, 'state.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
        if (this.data.version !== 1 || !Array.isArray(this.data.tasks) || !Array.isArray(this.data.notifications)) throw new Error('schema');
        this.data.settings ||= {};
        if (typeof this.data.settings !== 'object' || Array.isArray(this.data.settings)) throw new Error('settings');
        const states = new Set(['queued','watching','preparing','submitting','verifying','paused','cancelled','expired','found','attention','reconciling','completed']);
        for (const t of this.data.tasks) {
          if (!t || typeof t.id !== 'string' || !t.config || !['demo','autodl'].includes(t.config.provider)
            || !states.has(t.state) || !Array.isArray(t.logs) || !Number.isFinite(t.deadlineAt) || !Number.isFinite(t.nextCheckAt)) throw new Error('task');
          if (t.operation && !['intent','click_started','accepted'].includes(t.operation.stage)) throw new Error('operation');
        }
        if (this.data.notifications.some(n => !n || typeof n.key !== 'string' || !n.deliveries || typeof n.deliveries !== 'object')) throw new Error('notification');
      } catch { fail('STATE_CORRUPT', '任务状态文件损坏，已停止启动以防重复创建；请保留 .runtime/state.json 并核对 AutoDL 实例'); }
    } else this.data = { version: 1, tasks: [], notifications: [], settings: {}, createdAt: this.clock() };
    // 将旧版本已记住的明文凭据迁移为系统加密；无权限时停止，绝不明文降级。
    let changed=this.secretStorage.restore(this.data);
    // 旧任务没有采样历史时保持空白；重启不能沿用上一次进程未完成的“检查中”。
    for (const task of this.data.tasks) {
      if (!task.monitor) { task.monitor = emptyMonitor(); changed = true; }
      if (task.monitor.checking) { task.monitor.checking = false; changed = true; }
      if (task.monitor.samples.length > MONITOR_SAMPLE_LIMIT) {
        task.monitor.samples = task.monitor.samples.slice(-MONITOR_SAMPLE_LIMIT); changed = true;
      }
    }
    // 保留旧记录和提交回执，只停用旧演练任务；绝不转换成真实任务。
    for (const task of this.data.tasks) if (task.config.provider==='demo' && !task.legacyDisabled) {
      task.legacyDisabled=true; task.legacyState=task.state;
      if (!['completed','cancelled','expired'].includes(task.state)) task.state='cancelled';
      task.updatedAt=this.clock();
      task.logs.push({at:this.clock(),level:'warn',message:'旧版演练任务已停用，记录保留在本机，不再执行或发送通知'});
      task.logs=task.logs.slice(-200); changed=true;
    }
    if (changed) this.save();
  }
  save() {
    const serialized = JSON.stringify(this.secretStorage.serialize(this.data), null, 2);
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  tasks() { return this.data.tasks; }
  get(id) { const task = this.data.tasks.find(t => t.id === id); if (!task) fail('NOT_FOUND', '任务不存在', { status: 404 }); return task; }
  create(config, { balanceCheck = null, replaces = null, ownerId = null } = {}) {
    if (replaces && (!this.data.tasks.includes(replaces) || !canReplaceTask(replaces) || !sameTaskResource(replaces, config)))
      fail('TASK_CHANGED', '旧任务状态已变化，请重新检查后再重建', { status: 409 });
    const now = this.clock(), previous = replaces ? { ...replaces } : null;
    const task = {
      id: randomUUID(), config, state: 'queued', createdAt: now, updatedAt: now,
      // 账号归属与任务一次落盘，切换账号后不会误用另一账号的任务。
      ...(ownerId ? { ownerId } : {}),
      deadlineAt: now + config.timeoutMinutes * 60000, nextCheckAt: now,
      attempts: 0, errors: 0, logs: [{ at: now, level: 'info', message: '任务已建立，等待首次检查' }], operation: null, result: null,
      monitor: emptyMonitor(),
      ...(balanceCheck ? { balanceCheck } : {}), ...(replaces ? { replacesTaskId: replaces.id } : {}),
      // 重建任务沿用旧任务未过期的拒绝证据与暂不选择的主机，延迟创建保护不会因重建而失效。
      ...(replaces ? { submitRejections: carryRejections(replaces, now), hostCooldowns: activeCooldowns(replaces.hostCooldowns, now) } : {}),
    };
    if (replaces) Object.assign(replaces, {
      state: 'cancelled', updatedAt: now, replacedBy: task.id,
      logs: [...replaces.logs, { at: now, level: 'info', message: '已按用户选择停止此未提交任务，并用当前配置重建；原配置和日志保留' }].slice(-200),
    });
    this.data.tasks.unshift(task);
    // 新旧记录一次落盘；保存失败时恢复内存，不留下已停止旧任务或半个新任务。
    try { this.save(); }
    catch (error) {
      this.data.tasks.shift();
      if (replaces) { for (const key of Object.keys(replaces)) if (!(key in previous)) delete replaces[key]; Object.assign(replaces, previous); }
      throw error;
    }
    return task;
  }
  patch(task, patch) { Object.assign(task, patch, { updatedAt: this.clock() }); this.save(); }
  log(task, level, message, details) {
    task.logs.push({ at: this.clock(), level, message, ...(details ? { details } : {}) });
    task.logs = task.logs.slice(-200); task.updatedAt = this.clock(); this.save();
  }
  enqueueNotification(task, event, message) {
    const key = `${task.id}:${task.notifyEpoch || 0}:${event}`;
    if (this.data.notifications.some(n => n.key === key)) return;
    this.data.notifications.push({ id: randomUUID(), key, taskId: task.id, event, name: task.config.name,
      message, at: this.clock(), deliveries: {}, attempts: 0, nextAttemptAt: this.clock(), read: false });
    this.save();
  }
  publicState() {
    return {
      notificationSettingsRevision: this.data.notificationSettingsRevision ?? 0,
      tasks: this.data.tasks.filter(t=>t.config.provider==='autodl').map(t => ({ ...t, logs: t.logs.slice(-80) })),
      notifications: this.data.notifications.filter(n=>!this.data.tasks.some(t=>t.id===n.taskId && t.config.provider!=='autodl')).slice(-100).reverse().map(({ deliveries, ...n }) => ({ ...n, deliveries })),
      settings: { ...this.data.settings,
        webhookUrl: this.data.settings.webhookUrl ? '***' : '',
        webhookToken: this.data.settings.webhookToken ? '***' : '',
        wechatToken: this.data.settings.wechatToken ? '***' : '' },
    };
  }
}

