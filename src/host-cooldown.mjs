// 被平台拒绝下单的主机暂时不选（按任务记录）。主机列表里看得到空闲 GPU，看不到存储是否已满、是否在维护，
// 只按“价格最低”挑选时会反复点同一台。存储、维护等不会很快好转的原因暂停 30 分钟；
// 其余（已租满、没有识别出结果等）从 2 分钟起，同一台再被拒绝时加倍，最长 30 分钟。
export const HOST_PROBLEM = /存储|磁盘|硬盘|维护|下架|检修|不支持|最高\s*CUDA|驱动|起租/;
export const COOLDOWN_BASE_MS = 2 * 60000, COOLDOWN_MAX_MS = 30 * 60000;
const KEEP_MS = 60 * 60000, LIMIT = 20;
// 拒绝说明中引号内的平台原文，没有引号时取开头一段。
const reasonOf = message => (String(message).match(/[“"]([^”"]{2,120})[”"]/)?.[1] || String(message)).slice(0, 120);
const sameHost = (record, host) => (!!host.id && record.hostId === host.id) || (!!host.number && record.hostNumber === host.number && record.region === host.region);
export function activeCooldowns(list = [], now) { return (list || []).filter(record => record.until > now); }
export function coolHost(list = [], host, message, now) {
  if (!host || (!host.id && !host.number)) return { list: list || [], record: null };
  const kept = (list || []).filter(record => now - record.at < KEEP_MS || record.until > now);
  const previous = kept.find(record => sameHost(record, host)), count = (previous?.count || 0) + 1;
  const reason = reasonOf(message), long = HOST_PROBLEM.test(reason);
  const ms = long ? COOLDOWN_MAX_MS : Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (count - 1));
  const record = { hostId: host.id || '', hostNumber: host.number || '', region: host.region || '', at: now, until: now + ms, count, reason };
  return { list: [record, ...kept.filter(item => item !== previous)].slice(0, LIMIT), record };
}
export function isCooled(list = [], host, now) { return activeCooldowns(list, now).some(record => sameHost(record, host)); }
// 延迟创建保护的拒绝证据（30 分钟内）：恢复或重建任务时保留，不清空；
// 延迟创建保护停下任务时记下的那几台新实例（lateInstanceIds），用户已核对，记为已知，不再因它们停止。
export const REJECTION_KEEP_MS = 30 * 60000;
export function carryRejections(task, now) {
  const known = Array.isArray(task?.lateInstanceIds) ? task.lateInstanceIds : [];
  return (task?.submitRejections || []).filter(r => now - r.at < REJECTION_KEEP_MS)
    .map(r => ({ ...r, baselineIds: [...new Set([...(r.baselineIds || []), ...known])] }));
}
export function cooldownNote(list = [], now) {
  const active = activeCooldowns(list, now);
  if (!active.length) return '';
  return '暂不选择最近被平台拒绝的主机：' + active.slice(0, 4).map(record => (record.hostNumber || record.hostId) + '（约 '
    + Math.max(1, Math.ceil((record.until - now) / 60000)) + ' 分钟后再试，原因：' + record.reason.slice(0, 40) + '）').join('、');
}

