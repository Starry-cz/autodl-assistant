import { gpuKey } from './matching.mjs';
import { redact, messageOf } from './errors.mjs';

export const MONITOR_SAMPLE_LIMIT = 60;
export const emptyMonitor = () => ({ lastCheckStartedAt: null, lastCheckedAt: null, checking: false, samples: [] });
const count = value => Number.isSafeInteger(value) && value >= 0;
const base = (kind, scope, at) => ({ at, kind, available: null, total: null, knownAvailable: null,
  hostCount: null, complete: false, gpuAvailable: null, scope, status: 'unknown', note: '' });

// 只汇总此任务目标型号/地区实际读到的主机；部分扫描的小计不能冒充完整库存。
export function marketSample(config, observation, { at, scope }) {
  const sample = base('market', scope, at);
  if (observation.catalogOnly === true) {
    // 预筛已确认全部目标地区空闲为零；空 hosts 只代表没读主机列表，不能把主机数或总卡数补成零。
    sample.available = 0; sample.knownAvailable = 0;
    sample.total = count(observation.catalogTotal) ? observation.catalogTotal : null;
    sample.complete = true; sample.status = 'ok';
    sample.note = '型号汇总确认全部目标地区无空闲；未读取主机列表，主机数未知'
      + (sample.total === null ? '，总卡数未知' : `；目标型号总卡数 ${sample.total} 张`);
    return sample;
  }
  const hosts = [...new Map(observation.hosts.filter(host => config.regions.includes(host.region)
    && gpuKey(host.gpuModel) === gpuKey(config.gpuModel)).map(host => [host.region + '\n' + host.id, host])).values()];
  const unknownModel = observation.hosts.some(host => config.regions.includes(host.region) && !host.gpuModel);
  const coverage = observation.complete === true && !unknownModel;
  const available = hosts.filter(host => count(host.available));
  const allAvailable = available.length === hosts.length, allTotal = hosts.every(host => count(host.total));
  sample.hostCount = hosts.length;
  sample.knownAvailable = available.length ? available.reduce((sum, host) => sum + host.available, 0) : coverage && !hosts.length ? 0 : null;
  sample.available = coverage && allAvailable ? sample.knownAvailable : null;
  sample.total = coverage && allTotal ? hosts.reduce((sum, host) => sum + host.total, 0) : null;
  sample.complete = coverage && allAvailable && allTotal;
  sample.status = sample.knownAvailable !== null ? 'ok' : 'unknown';
  sample.note = sample.complete ? `已完整读取任务所选型号和地区：${hosts.length} 台主机`
    : `已读范围：${hosts.length} 台目标主机${scope === 'first-page' ? '（首页检查）' : ''}；`
      + (!coverage ? '尚未完整确认所选范围' : '部分库存数字未知');
  return sample;
}

// 原实例页面只给出是否充足，不把布尔值换算为 0/1 卡，也不增加额外网络查询。
export function bootSample(instance, at) {
  const sample = base('boot', 'target', at);
  sample.gpuAvailable = typeof instance.gpuAvailable === 'boolean' ? instance.gpuAvailable : null;
  sample.complete = sample.gpuAvailable !== null;
  sample.status = sample.complete ? 'ok' : 'unknown';
  sample.note = sample.gpuAvailable === true ? '原实例所在主机 GPU 充足；数量未知'
    : sample.gpuAvailable === false ? '原实例所在主机 GPU 不足；数量未知'
      : '已核对原实例；页面未提供明确空闲库存';
  return sample;
}

export function failedSample(kind, scope, error, at) {
  return { ...base(kind, scope, at), status: 'error', note: redact(messageOf(error)).slice(0, 300) };
}

export function beginCheck(monitor, at) {
  return { ...(monitor || emptyMonitor()), lastCheckStartedAt: at, checking: true };
}
export function finishCheck(monitor, sample = null) {
  // 暂停或停止期间返回的请求只结束 checking，不为取消操作补造检查点或结束时间。
  return { ...monitor, checking: false, ...(sample ? { lastCheckedAt: sample.at,
    samples: [...monitor.samples, sample].slice(-MONITOR_SAMPLE_LIMIT) } : {}) };
}
