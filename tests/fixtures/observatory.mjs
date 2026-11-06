import { SyntheticAdapter } from './synthetic-adapter.mjs';

export const OBSERVATORY_INSTANCE_ID = 'syntheticobserve-abcdef01';
export const OBSERVATORY_RUNNING_ID = 'syntheticobserve-abcdef02';
const GIB = 2 ** 30;

// 只用于隔离 HTTP/UI 验收，所有账号、金额、实例和监控读数均为合成数据。
export function createObservatoryFixtureAdapter({ clock = () => Date.now() } = {}) {
  const usage = { mem_limit: 32 * GIB, mem_usage: 6 * GIB, root_fs_total_size: 30 * GIB,
    root_fs_used_size: 8 * GIB, data_disk_total_size: 100 * GIB, data_disk_used_size: 24 * GIB };
  const rows = [
    { uuid: OBSERVATORY_INSTANCE_ID, name: '合成实例 · 等待开机', status: 'shutdown', start_mode: 'gpu', region_name: '北京B区', region_sign: 'beijing-B',
      gpu_type_name: 'RTX 4090', req_gpu_amount: 1, machine_id: 'synthetic-machine-1', gpu_idle_num: 0, gpu_all_num: 8,
      created_at: '2026-10-01 09:00:00', usage_info: usage },
    { uuid: OBSERVATORY_RUNNING_ID, name: '合成实例 · 运行中', status: 'running', start_mode: 'gpu', region_name: '西北B区', region_sign: 'northwest-B',
      gpu_type_name: 'RTX 3090', req_gpu_amount: 1, machine_id: 'synthetic-machine-2', gpu_idle_num: 2, gpu_all_num: 8,
      created_at: '2026-10-02 10:00:00', usage_info: { ...usage, mem_usage: 12 * GIB } },
    { uuid: 'syntheticobserve-abcdef03', name: '合成实例 · 资料缺失', status: 'unknown', region_name: '北京B区', usage_info: {} },
  ];
  const bills = () => {
    const date = (offset = 0) => new Date(clock() - offset).toISOString();
    return [
      { uuid: 'synthetic-bill-charge', product_uuid: OBSERVATORY_RUNNING_ID, bill_type: 'charge', asset: 3200, created_at: date(), details: { charge_from: date(3600000) } },
      { uuid: 'synthetic-bill-refund', product_uuid: OBSERVATORY_RUNNING_ID, bill_type: 'refund', asset: 500, created_at: date(), details: {} },
      { uuid: 'synthetic-bill-recharge', bill_type: 'recharge', asset: 100000, created_at: date(), details: {} },
      { uuid: 'synthetic-bill-refund-day', product_uuid: OBSERVATORY_INSTANCE_ID, bill_type: 'refund', asset: 800, created_at: date(86400000), details: {} },
    ];
  };
  return Object.assign(new SyntheticAdapter({ clock }), {
    sessionStatus: () => ({ state: 'ready', browserOpen: true, label: '合成只读会话', message: '仅本地验收，未连接实际账号', checkedAt: clock() }),
    instances: async () => rows.map(row => ({ id: row.uuid, region: row.region_name, gpuModel: row.gpu_type_name || '', gpuCount: row.req_gpu_amount ?? null,
      running: row.status === 'running', stopped: row.status === 'shutdown', cardless: false, starting: false, gpuAvailable: row.gpu_idle_num > 0 })),
    observatoryInstances: async ({ pageIndex = 1, pageSize = 100 } = {}) => ({ list: structuredClone(rows.slice((pageIndex - 1) * pageSize, pageIndex * pageSize)), result_total: rows.length }),
    observatoryWallet: async () => ({ assets: 120500, blocked_asset: 1500, voucher_balance: 10000 }),
    observatoryMonitor: async instanceId => ({ uuid: instanceId, instance_name: rows.find(row => row.uuid === instanceId)?.name,
      gpu_number: 1, cpu_number: 16, UsageInfo: { ...usage, cpu_usage_percent: 24.5, mem_usage_percent: 18.75 } }),
    observatoryBills: async ({ pageIndex = 1, pageSize = 500 } = {}) => {
      const list = bills(); return { list: list.slice((pageIndex - 1) * pageSize, pageIndex * pageSize), result_total: list.length };
    },
  });
}
