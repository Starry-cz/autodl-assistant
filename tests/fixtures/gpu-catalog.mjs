// 仅供隔离测试的合成型号目录，不是 AutoDL 当前可租型号或库存。
const m = (model, available, total) => ({ model, available, total, disabled: false });
export const SYNTHETIC_GPU_CATALOG = Object.freeze({ checkedAt: 1767000000000, regions: [
  { region: '北京B区', models: [m('RTX 4090', 2, 8), m('RTX 4090D', 0, 8), m('L20', 1, 8), m('A100', 2, 8), m('A100 80GB', 1, 8)] },
  { region: '西北B区', models: [m('RTX 4090', 0, 16), m('RTX 3090', 3, 8)] },
  { region: '重庆A区', models: [m('RTX 4090', 1, 8), m('L20', 0, 4)] },
  { region: '内蒙B区', models: [m('A100 80GB', 0, 8)] },
  { region: '北京A区', models: [m('RTX 3090', 1, 4)] },
  { region: '佛山区', models: [m('RTX 4090', 0, 8)] },
] });
// 合成适配器的同步结果：只返回请求的地区，时间取当前时刻。
export async function syntheticGpuCatalog(regions) {
  const catalog = structuredClone(SYNTHETIC_GPU_CATALOG);
  return { checkedAt: Date.now(), regions: catalog.regions.filter(row => regions.includes(row.region)) };
}
// 模拟上次同步后保存在本机的目录（重启后仍可选择型号）。
export function seedGpuCatalog(store, catalog = SYNTHETIC_GPU_CATALOG) {
  store.data.gpuCatalog = structuredClone(catalog); store.save();
}

