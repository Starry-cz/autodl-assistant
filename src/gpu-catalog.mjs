import { REGIONS, GPU_MODEL_MAX_LENGTH } from './config.mjs';
import { gpuKey } from './matching.mjs';
import { redact } from './errors.mjs';
// AutoDL 按量计费型号接口的地区库存（同步当时的快照，下一轮查询重新读取）。
// 保存与返回前逐项校验；读到的文字只作为名称显示，不当作指令或网页内容。
const count = value => Number.isInteger(value) && value >= 0 && value <= 100000 ? value : null;
function modelName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return '';
  const name = value.trim().replace(/\s+/gu, ' ');
  return name.length <= GPU_MODEL_MAX_LENGTH && /[\p{L}\p{N}]/u.test(name) ? name : '';
}
export function normalizeGpuCatalog(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.regions) || !Number.isFinite(input.checkedAt)) return null;
  const regions = [];
  for (const region of REGIONS) {
    const row = input.regions.find(item => item?.region === region);
    if (!row) continue;
    const models = [], keys = new Set();
    for (const item of Array.isArray(row.models) ? row.models.slice(0, 200) : []) {
      const model = modelName(item?.model), key = gpuKey(model);
      if (!model || keys.has(key)) continue;
      keys.add(key);
      models.push({ model, available: count(item.available), total: count(item.total), disabled: item.disabled === true });
    }
    regions.push({ region, models, ...(row.missing === true ? { missing: true } : {}), ...(row.disabled === true ? { disabled: true } : {}),
      ...(typeof row.error === 'string' && row.error ? { error: redact(row.error).slice(0, 200) } : {}) });
  }
  return { checkedAt: input.checkedAt, source: 'AutoDL 按量计费 · 型号库存接口', regions };
}
// 本次同步读到的型号总数（各地区合计）；为 0 时不覆盖上次保存的目录。
export const catalogModelCount = catalog => (catalog?.regions || []).reduce((sum, row) => sum + row.models.length, 0);

