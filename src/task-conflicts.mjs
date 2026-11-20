import { AppError } from './errors.mjs';
import { gpuKey } from './matching.mjs';
const FINISHED = new Set(['cancelled', 'expired', 'completed', 'found']);
export function sameTaskResource(task, config) {
  const existing = task.config;
  if (existing.provider !== 'autodl' || config.provider !== 'autodl') return false;
  if (['clone', 'boot'].includes(config.mode)) {
    // 组合任务持有原机和克隆两个入口；停下但仍有未决提交时也不能另开一路。
    return ['clone', 'boot'].includes(existing.mode) && existing.sourceId === config.sourceId
      && (existing.mode === config.mode || existing.raceBoot === true || config.raceBoot === true);
  }
  // 历史任务按实验 1 处理。独立实验可租同型号实例，同一实验仍防止重复点击、恢复或重建。
  return existing.mode === config.mode && gpuKey(existing.gpuModel) === gpuKey(config.gpuModel)
    && (existing.experimentSlot ?? 1) === (config.experimentSlot ?? 1);
}
export function blocksTask(task, config) {
  // 未核验完成的提交记录即使被停止也保留去重保护。
  return sameTaskResource(task, config)
    && (!FINISHED.has(task.state) || (!!task.operation && task.state !== 'completed'));
}
export function canReplaceTask(task) {
  // 原机任务会把库存检查时看到的已关机实例写入 result；这条观察记录不是开机回执。
  const source = task.result;
  const stoppedBootSource = task.config.mode === 'boot' && source?.id === task.config.sourceId
    && source?.stopped === true && !source.starting && !source.running;
  return ['attention', 'paused'].includes(task.state) && !task.operation && !task.replacedBy && (!source || stoppedBootSource);
}
export function conflictError(task) {
  const conflict = {
    id: task.id, name: task.config.name, state: task.state, mode: task.config.mode,
    gpuModel: task.config.gpuModel, cuda: task.config.cuda, regions: task.config.regions,
    ...(task.config.mode === 'create' ? {experimentSlot: task.config.experimentSlot ?? 1} : {}),
    lastError: task.lastError || null, hasOperation: !!task.operation,
    replaceable: canReplaceTask(task),
  };
  const message = conflict.hasOperation ? '旧任务已有提交记录，请先核对目标实例，避免重复租用'
    : conflict.replaceable ? '已有未提交的旧任务，可查看原因或停止旧任务并按当前配置重建'
    : '已有相同资源的任务正在运行或等待处理，请先查看原任务';
  return new AppError('DUPLICATE', message, { status: 409, conflict });
}

