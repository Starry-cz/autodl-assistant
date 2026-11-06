import { normalizeConfig } from '../../src/config.mjs';
// 合成测试所需的完整真实任务形状；不访问平台、不授予真实浏览器任何权限。
// 检查间隔固定为20秒，与引擎测试中的时间推进一致（产品默认值是1秒）。
export function configInput(input={}) {
  return {provider:'autodl',action:'observe',gpuModel:'RTX 4090',sourceId:'synthetic-source',
    imagePath:['PyTorch','2.1.0','3.10(ubuntu22.04)','12.1'],pollSeconds:20,
    maxGpuHourly:3,maxTotalHourly:4,maxStorageDaily:5,...input};
}
export const testConfig = input => normalizeConfig(configInput(input));

