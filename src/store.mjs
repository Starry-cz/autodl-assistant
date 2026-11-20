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
  patch(task, patch) {
    const previous = { ...task };
    Object.assign(task, patch, { updatedAt: this.clock() });
    try { this.save(); }
    catch (error) {
      // 普通修改失败后仍以已保存状态为准，避免下次无关写盘意外提交此次修改。
      for (const key of Object.keys(patch)) if (!Object.hasOwn(previous, key)) delete task[key];
      Object.assign(task, previous);
      // 点击边界与平台回执是去重证据。一旦出现就留给引擎核对，不能因磁盘故障再点一次。
      if (patch.operation?.stage === 'click_started' || patch.operation?.stage === 'accepted') task.operation = patch.operation;
      if (patch.state === 'paused' || patch.state === 'cancelled') {
        // 停止指令优先；即使无法保存，当前进程也不能因为回滚继续下单。
        task.state = patch.state;
        const action = patch.state === 'paused' ? '暂停' : '取消';
        throw new Error(`本次运行已${action}任务，但状态尚未保存。重启可能恢复旧状态，请检查磁盘空间及写入权限。`, { cause: error });
      }
      throw error;
    }
  }
  log(task, level, message, details) {
    const entry = { at: this.clock(), level, message, ...(details ? { details } : {}) };
    this.patch(task, { logs: [...task.logs.slice(-199), entry] });
  }
  enqueueNotification(task, event, message) {
    const key = `${task.id}:${task.notifyEpoch || 0}:${event}`;
    if (this.data.notifications.some(n => n.key === key)) return;
    this.data.notifications.push({ id: randomUUID(), key, taskId: task.id, event, name: task.config.name,
      message, at: this.clock(), deliveries: {}, attempts: 0, nextAttemptAt: this.clock(), read: false });
    // 入队失败须释放去重键，下次重试才能真正保存这条通知。
    try { this.save(); }
    catch (error) { this.data.notifications.pop(); throw error; }
  }
  markNotificationsRead(notifications) {
    const unread = notifications.filter(item => !item.read);
    if (!unread.length) return;
    for (const item of unread) item.read = true;
    try { this.save(); }
    catch (error) {
      // 只回滚本次改变的消息；之前已读的和其他账号的记录保持原样。
      for (const item of unread) item.read = false;
      throw error;
    }
  }
  publicState({ tasks = this.data.tasks.filter(t => t.config.provider === 'autodl'), notifications } = {}) {
    if (!notifications) {
      const legacyIds = new Set(this.data.tasks.filter(t => t.config.provider !== 'autodl').map(t => t.id));
      notifications = this.data.notifications.filter(item => !legacyIds.has(item.taskId));
    }
    return {
      notificationSettingsRevision: this.data.notificationSettingsRevision ?? 0,
      tasks: tasks.map(t => ({ ...t, logs: t.logs.slice(-80) })),
      notifications: notifications.slice(-100).reverse().map(n => ({ ...n })),
      settings: { ...this.data.settings,
        webhookUrl: this.data.settings.webhookUrl ? '***' : '',
        webhookToken: this.data.settings.webhookToken ? '***' : '',
        wechatToken: this.data.settings.wechatToken ? '***' : '' },
    };
  }
}

