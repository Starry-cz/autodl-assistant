import { AppError } from './errors.mjs';

const ownerOf = account => typeof account === 'string' ? account : account?.ownerId;
const clean = value => typeof value === 'string' ? value.trim() : '';

// 用主账号 UUID 和子账号登录 ID 组成无歧义的键；不使用显示名、手机号或凭据，也不计算哈希。
export function accountOwnerId(accountId, subAccountId = null) {
  const main = clean(accountId), sub = subAccountId === null ? null : clean(subAccountId);
  if (!main || !/^[A-Za-z0-9_-]{1,128}$/.test(main) || sub !== null && (!sub || sub.length > 160 || /[\u0000-\u001f\u007f]/u.test(sub)))
    throw new AppError('ACCOUNT_IDENTITY', 'AutoDL 未返回可确认的账号标识，请重新检查登录', { status: 409 });
  return 'autodl:' + JSON.stringify([main, sub]);
}

export function normalizeAccountIdentity(value, { now = Date.now() } = {}) {
  if (!value || !['main', 'sub'].includes(value.kind) || value.kind === 'main' && value.subAccountId != null || value.kind === 'sub' && !clean(value.subAccountId))
    throw new AppError('ACCOUNT_IDENTITY', 'AutoDL 账号类型或标识缺失，请重新检查登录', { status: 409 });
  const accountId = clean(value.accountId), subAccountId = value.kind === 'sub' ? clean(value.subAccountId) : null;
  let displayName = clean(value.displayName).slice(0, 80);
  // 某些用户名本身是手机号；不把号码当昵称回显，也不返回资料中的 phone/email 字段。
  if (/^\+?[\d\s()-]{7,}$/.test(displayName)) displayName = '';
  return { ownerId: accountOwnerId(accountId, subAccountId), accountId, subAccountId,
    displayName: displayName || (value.kind === 'sub' ? 'AutoDL 子账号' : 'AutoDL 账号'), kind: value.kind, verifiedAt: now };
}

export function taskBelongsToAccount(task, account) {
  const ownerId = ownerOf(account);
  return typeof ownerId === 'string' && !!ownerId && task?.config?.provider === 'autodl' && task.ownerId === ownerId;
}
export function filterAccountTasks(tasks, account) { return tasks.filter(task => taskBelongsToAccount(task, account)); }
export function filterAccountNotifications(notifications, tasks, account) {
  const ids = new Set(filterAccountTasks(tasks, account).map(task => task.id));
  return notifications.filter(notification => ids.has(notification.taskId));
}
export function assertTaskOwner(task, account) {
  if (!ownerOf(account)) throw new AppError('ACCOUNT_REQUIRED', '请先连接并确认 AutoDL 账号', { status: 409 });
  if (!task?.ownerId) throw new AppError('ACCOUNT_UNCLAIMED', '此历史任务尚未确认账号归属，不能执行', { status: 409 });
  if (!taskBelongsToAccount(task, account)) throw new AppError('ACCOUNT_MISMATCH', '当前 AutoDL 账号与任务所属账号不同，已停止本次操作', { status: 409 });
}

// 只返回新的任务数组，磁盘保存及回滚由 Store 的调用方完成；既有 ownerId 永远不重新分配。
// 完成/已提交克隆必须匹配目标实例，不能仅凭仍可见的源实例认领另一个账号的目标任务。
export function claimLegacyTasks(tasks, account, instances, { complete = false, now = Date.now() } = {}) {
  const ownerId = ownerOf(account);
  if (!ownerId) throw new AppError('ACCOUNT_REQUIRED', '请先确认账号身份再核对历史任务', { status: 409 });
  const ids = new Set(instances.map(instance => instance.id).filter(id => typeof id === 'string' && id));
  const claimed = [];
  const next = tasks.map(task => {
    if (!complete || task.ownerId || task.config?.provider !== 'autodl') return task;
    const references = [
      { instanceId: task.result?.id, evidence: 'result' },
      { instanceId: task.operation?.receipt?.instanceId, evidence: 'receipt' },
    ];
    const sourceAllowed = task.config.mode === 'boot' || task.config.mode === 'clone' && !task.operation
      && !task.result?.id && !['completed', 'submitting', 'verifying', 'reconciling'].includes(task.state);
    if (sourceAllowed) references.push({ instanceId: task.config.sourceId, evidence: 'source' });
    const match = references.find(reference => typeof reference.instanceId === 'string' && ids.has(reference.instanceId));
    if (!match) return task;
    claimed.push({ taskId: task.id, ...match });
    return { ...task, ownerId, ownerAssignedAt: now, ownerClaim: { ...match, at: now } };
  });
  return { tasks: next, claimed, claimedTaskIds: claimed.map(item => item.taskId),
    unclaimedCount: next.filter(task => task.config?.provider === 'autodl' && !task.ownerId).length };
}
