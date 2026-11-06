// 仅供隔离测试注入，生产入口从不导入此适配器。
import { wantsDataDisk, requiredDiskGB } from '../../src/matching.mjs';
import { AppError } from '../../src/errors.mjs';
import { syntheticGpuCatalog } from './gpu-catalog.mjs';
export class SyntheticAdapter {
  constructor({ clock = () => Date.now(), availableAfter = 1, copyFailure = false } = {}) { this.clock = clock; this.availableAfter=availableAfter; this.copyFailure=copyFailure; }
  async gpuCatalog(regions) { return syntheticGpuCatalog(regions); }
  async probe(task) {
    const c = task.config;
    const source = c.mode === 'clone' ? { id: c.sourceId, region: c.regions[0], gpuModel: c.gpuModel,
      hostId: 'synthetic-source-host', hostNumber: '合成源机', gpuCount: c.gpuCount, extraDiskGB: 100, stopped: true, sourceCuda: this.sourceCuda || '12.1' } : null;
    const available = task.attempts >= this.availableAfter;
    const host = { id: 'synthetic-target-host', number: '合成922机', region: c.regions[0], gpuModel: c.gpuModel,
      available: available ? 8 : 0, maxCuda: '13.2', driver: '595.71', price: 1.98, expandableGB: 4096, disabled: !available };
    // alternate：再提供一台价格更高的同型号主机，用于验证被拒绝的主机暂时不选时改选其他主机。
    const hosts = this.alternate ? [host, { ...host, id: 'synthetic-other-host', number: '合成923机', price: 2.18 }] : [host];
    return { source, hosts, summary: available ? '合成资源池出现空闲 GPU' : '合成资源池暂时无卡' };
  }
  async prepare(task, host, source) {
    const c = task.config;
    return { host, gpuCount: c.gpuCount, hourly: host.price * c.gpuCount,
      storageDaily: Math.round(requiredDiskGB(c, source) * 0.0066 * 100) / 100,
      extraDiskGB: requiredDiskGB(c, source), copyDataDisk: wantsDataDisk(c),
      baselineIds: [], imageVerified: true };
  }
  async submit(task, quote, mark) {
    mark(); // 与真实适配器相同：持久化点击边界之后才可提交。
    return { instanceId: `synthetic-${task.id.slice(0,8)}`, acceptedAt: this.clock() };
  }
  async reconcile(task) {
    if (!task.operation?.receipt) return { ambiguous: true, reason: '合成提交回执不存在，请核对后绑定实例' };
    const receipt = task.operation.receipt;
    const elapsed = this.clock() - receipt.acceptedAt;
    const cloning = wantsDataDisk(task.config);
    return { instance: { id: receipt.instanceId, running: elapsed >= 35000, gpuVerified: true,
      copyComplete: cloning ? elapsed >= 65000 && !this.copyFailure : true,
      copyFailed: cloning && elapsed >= 65000 && this.copyFailure,
      progress: cloning ? elapsed < 25000 ? '系统盘克隆中' : elapsed < 65000 ? '数据盘复制中' : this.copyFailure ? '数据盘复制失败' : '数据盘复制完成' : elapsed < 35000 ? 'GPU 实例启动中' : 'GPU 实例已运行' } };
  }
  async attach(task, id) {
    if (!id.startsWith('synthetic-')) throw new AppError('INSTANCE', '合成模式只接受 synthetic- 开头的实例 ID');
    return { instanceId: id, acceptedAt: this.clock() - 10000, manual: true };
  }
  // 合成实例列表：extraInstances 由测试设置，模拟提交前基线之外的实例。
  async recheckSubmission() { return { extra: this.extraInstances || [] }; }
  async close() {}
}

