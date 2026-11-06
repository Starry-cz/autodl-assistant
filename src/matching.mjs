export function gpuKey(value) { return String(value || '').toUpperCase().replace(/[\s_-]/g, ''); }
export function cudaParts(value) {
  if (!/^1\d\.\d{1,2}$/.test(String(value))) return null;
  return String(value).split('.').map(Number);
}
// 只判断宿主驱动能力，不代表 Python、PyTorch 或整套应用已经通过兼容验证。
export function assessCudaCompatibility(driverMax, requested) {
  const a=cudaParts(driverMax), b=cudaParts(requested);
  if(!a || !b)return {state:'unknown',reason:'宿主驱动 CUDA 上限或环境 CUDA 未知'};
  if(a[0]>b[0] || (a[0]===b[0] && a[1]>=b[1]))return {state:'driver_supported',reason:'宿主驱动上限覆盖环境 CUDA；仍需核验 GPU 架构和应用依赖'};
  if(a[0]===b[0] && a[0]>=11)return {state:'conditional',reason:'同一 CUDA 大版本可能有受限的小版本兼容，PTX、新特性或扩展可能仍需更新驱动；自动匹配不放行'};
  return {state:'unsupported',reason:'宿主驱动能力低于所需 CUDA 大版本，不能直接运行；不自动安装兼容包或升级环境'};
}
export function cudaCompatible(driverMax, requested) { return assessCudaCompatibility(driverMax,requested).state==='driver_supported'; }
// GPU 架构对环境 CUDA 的最低要求，与 AutoDL 下单前的提示一致（2026-10-29 读取其公开前端代码：Blackwell 架构“如50系列”需 CUDA 12.8 及以上）。
// 只按型号名识别 Blackwell（含 RTX PRO 工作站卡）；Ampere（≥11.0）、Ada（≥11.3）等其他架构交给点击后识别平台提示。
const BLACKWELL = /\bRTX\s*50\d0(?!\d)|\bBlackwell\b|\bG?B[123]00(?!\d)|\bRTX\s*PRO\s*[456]000\b|\bPRO\s*6000\s*Max-?Q\b/i;
export function archCudaProblem(gpuModel, cuda) {
  const parts = cudaParts(cuda);
  if (!parts || !BLACKWELL.test(String(gpuModel || ''))) return '';
  return parts[0] > 12 || (parts[0] === 12 && parts[1] >= 8) ? '' : gpuModel + ' 属于 Blackwell 架构，环境 CUDA 需 12.8 及以上（当前 ' + cuda + '）';
}
// 克隆的环境来自源实例系统盘，按源镜像 CUDA 筛选宿主驱动；新建按所选镜像的 CUDA。
export const environmentCuda = (config, source) => config.mode === 'clone' ? source?.sourceCuda || config.cuda : config.cuda;
export const officialPricing = config => config.pricePolicy === 'official';
// 按分比较金额，避免 1.1 × 3 = 3.3000000000000003 这类浮点误差把刚好等于上限的主机判为超价。
const cents = value => Math.round(value * 100);
export const wantsDataDisk = config => config.mode === 'clone' && config.copyDataDisk !== false;
export const requiredDiskGB = (config, source) => Math.max(config.extraDiskGB, wantsDataDisk(config) ? source?.extraDiskGB || 0 : 0);
export function candidateReasons(host, config, source = null) {
  const reasons = [];
  if (gpuKey(host.gpuModel) !== gpuKey(config.gpuModel)) reasons.push('型号不符');
  if (!config.regions.includes(host.region)) reasons.push('地区不符');
  if (!Number.isFinite(host.available) || host.available < config.gpuCount || host.disabled) reasons.push('库存不足');
  if (!cudaCompatible(host.maxCuda, environmentCuda(config, source)) || !host.driver || host.driver === '-') reasons.push('驱动/CUDA 不兼容或未知');
  if (archCudaProblem(host.gpuModel, environmentCuda(config, source))) reasons.push('GPU 架构需要更高 CUDA');
  if (!Number.isFinite(host.price) || host.price <= 0 || (!officialPricing(config) && (host.price > config.maxGpuHourly || cents(host.price * config.gpuCount) > cents(config.maxTotalHourly)))) reasons.push('价格不符');
  const disk = requiredDiskGB(config, source);
  // 不需要扩容时不看可扩容容量：页面写法读不出也不排除这台主机。
  if (disk > 0 && (!Number.isFinite(host.expandableGB) || host.expandableGB < disk)) reasons.push('数据盘容量不足');
  // 克隆只能在源实例所在地区；目标 GPU 型号和数量按任务设置，可以与源实例不同（AutoDL 克隆页允许更换主机）。
  if (source) {
    if (host.region !== source.region) reasons.push('不在源地区');
    if ((source.hostId && host.id === source.hostId) || (source.hostNumber && host.number === source.hostNumber)) reasons.push('源主机');
    // 已知源主机号而这台主机读不出主机号：无法确认不是源主机，不选。
    else if (source.hostNumber && !host.number) reasons.push('主机号未知，无法确认不是源主机');
  }
  return reasons;
}
export function selectCandidate(hosts, config, source) {
  return hosts.filter(h => !candidateReasons(h, config, source).length)
    .sort((a,b) => a.price - b.price || b.available - a.available || a.id.localeCompare(b.id))[0] || null;
}
export function verifyQuote(quote, config, source) {
  const reasons = candidateReasons(quote.host, config, source);
  if (quote.gpuCount !== config.gpuCount) reasons.push('结算 GPU 数量不符');
  if (!(Number.isFinite(quote.hourly) && quote.hourly > 0 && (officialPricing(config) || quote.hourly <= config.maxTotalHourly))) reasons.push('结算配置总价未知、无效或超限');
  if (!(Number.isFinite(quote.storageDaily) && quote.storageDaily >= 0 && (officialPricing(config) || quote.storageDaily <= config.maxStorageDaily))) reasons.push('磁盘日费未知、无效或超限');
  if (!Number.isFinite(quote.extraDiskGB) || quote.extraDiskGB < requiredDiskGB(config, source)) reasons.push('目标扩容小于源数据盘或未知');
  if (quote.imageVerified !== true) reasons.push('镜像/源环境未确认');
  if (config.mode === 'clone' && quote.copyDataDisk !== wantsDataDisk(config)) reasons.push(wantsDataDisk(config) ? '未确认复制数据盘' : '数据盘复制选项与任务不一致');
  return reasons;
}
export function assessInstance(instance, mode, copyDataDisk = true) {
  const copying = mode === 'clone' && copyDataDisk;
  if ((copying && instance.copyFailed) || instance.failed) return { state: 'attention', reason: copying && instance.copyFailed ? '数据盘复制失败，请保留源实例并检查目标实例' : '实例创建或开机失败，请检查控制台' };
  if (copying && instance.copyComplete !== true) return { state: 'verifying', reason: '已分配实例，等待数据盘复制完成的明确证据' };
  // 页面仍显示复制中时不算完成，即使同一行有“复制完成”字样。
  if (copying && instance.progress === '数据盘复制中') return { state: 'verifying', reason: '数据盘仍在复制中，等待复制完成' };
  if (instance.running === true && instance.gpuVerified === true) return { state: 'completed', reason: mode === 'clone' ? (copying ? '数据盘复制完成，目标 GPU 实例已运行' : '系统盘克隆完成，目标 GPU 实例已运行（未复制数据盘）') : '目标 GPU 实例已运行' };
  return { state: 'verifying', reason: '等待目标 GPU 实例启动' };
}

