import { fail } from '../errors.mjs';
import { REGIONS } from '../config.mjs';

// 查询至少限定型号或地区；实际读取由 autodl-inventory.mjs 的只读 API 完成。
export function marketHostQuery(input = {}) {
  const model = input.model ?? '', region = input.region ?? '';
  if (typeof model !== 'string' || model.length > 120) fail('CONFIG', 'GPU 型号无效');
  if (typeof region !== 'string' || region && !REGIONS.includes(region)) fail('CONFIG', '请选择支持的地区');
  if (!model.trim() && !region) fail('CONFIG', '请至少选择一个 GPU 型号或地区');
  return { model: model.trim(), region };
}
