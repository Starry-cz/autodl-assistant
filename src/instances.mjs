import { REGIONS, normalizeGpuModel } from './config.mjs';
import { fail } from './errors.mjs';

export function sourceProblem(source) {
  if (!source) return '源实例已不存在或未出现在当前账号的实例列表中';
  if (!source.stopped || source.running) return '克隆要求源实例已关机；程序不会自动关闭实例';
  if (!REGIONS.includes(source.region)) return '源实例地区未知或尚未支持';
  try { normalizeGpuModel(source.gpuModel); } catch { return '源实例的精确 GPU 型号无法识别'; }
  if (![1,2,3,4,5,6,7,8,10,12].includes(source.gpuCount)) return '源实例 GPU 数量未知或尚未支持';
  if (source.failed) return '源实例处于失败状态，请先在 AutoDL 核对';
  return '';
}
// 克隆的源实例只需存在、已关机、在任务地区；目标 GPU 型号和数量按任务设置，可以与源实例不同。
export function validateCloneSource(config, source) {
  const problem = sourceProblem(source);
  if (problem) fail('SOURCE_UNAVAILABLE', problem, { status: 409 });
  if (source.id !== config.sourceId || source.region !== config.regions[0] || config.regions.length !== 1)
    fail('SOURCE_MISMATCH', '源实例在 ' + source.region + '，任务地区为 ' + config.regions.join('、')
      + '；克隆只能在源实例所在地区进行，请重新同步并选择源实例', { status: 409 });
  return source;
}
export function publicInstance(source) {
  const reason = sourceProblem(source);
  const bootReason = bootProblem(source);
  return { id: source.id, region: source.region || '', gpuModel: source.gpuModel || '', gpuCount: source.gpuCount ?? null,
    status: source.cardless ? '无卡模式运行' : source.starting ? '开机中' : source.stopped ? '已关机' : source.running ? '运行中' : source.failed ? '失败' : source.progress || '状态待确认',
    cloneable: !reason, reason, bootable: !bootReason, bootReason,
    cardless: source.cardless === true, starting: source.starting === true, gpuAvailable: source.gpuAvailable ?? null };
}

// 仅接管原实例有卡开机；不替用户结束无卡模式下仍在运行的进程。
export function bootProblem(source) {
  if (!source) return '实例未出现在当前账号的列表中';
  if (source.id?.startsWith('pro-')) return '此模式仅支持普通容器实例';
  if (source.cardless) return '该实例正在无卡模式运行，请先保存工作并在 AutoDL 手动关机';
  if (source.failed) return '实例处于失败状态，请先在 AutoDL 核对';
  if (!source.stopped && !source.running && !source.starting) return '实例尚未关机或状态无法确认';
  if (!REGIONS.includes(source.region) || !source.gpuModel || !Number.isInteger(source.gpuCount) || source.gpuCount < 1) return '实例地区、型号或卡数无法确认，请重新同步';
  return '';
}

export function validateBootSource(config, source) {
  const problem = bootProblem(source);
  if (problem) fail('BOOT_SOURCE', problem, { status: 409 });
  if (source.id !== config.sourceId || source.region !== config.regions[0] || config.regions.length !== 1
    || source.gpuModel.replace(/\s+/g, '').toUpperCase() !== config.gpuModel.replace(/\s+/g, '').toUpperCase() || source.gpuCount !== config.gpuCount)
    fail('BOOT_MISMATCH', '原实例的地区、GPU 型号或卡数已变化，请重新同步后建立任务', { status: 409 });
  return source;
}

