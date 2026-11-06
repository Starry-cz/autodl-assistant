import { fail } from './errors.mjs';
import { archCudaProblem } from './matching.mjs';
export const REGIONS = ['北京B区', '西北B区', '重庆A区', '内蒙B区', '北京A区', '佛山区'];
// GPU 型号不再内置预设：表单从 AutoDL 创建页按地区同步官方型号（gpu-catalog.mjs），其他型号由用户精确填写。
export const GPU_MODEL_MAX_LENGTH = 80;
export const POLL_SECONDS = Object.freeze({ min: 1, max: 600, default: 10 });
// 首页优先：每轮只读各地区第一页，命中即核验；后续页面按间隔完整翻页兜底。默认值按用户要求设为20秒，不是测得的最优值。
export const SCAN_SCOPES = ['full', 'first-page'];
export const FULL_SCAN_SECONDS = Object.freeze({ min: 10, max: 3600, default: 20 });
export function normalizeGpuModel(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim() === '__custom__') fail('CONFIG', '请选择 GPU 精确型号，或填写其他型号');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) fail('CONFIG', 'GPU 型号必须是单行名称，不能包含控制字符');
  const model = value.trim().replace(/\s+/gu, ' ');
  if (model.length > GPU_MODEL_MAX_LENGTH || !/[\p{L}\p{N}]/u.test(model)) fail('CONFIG', 'GPU 型号应为 1～80 字符的精确名称，不能仅有符号');
  return model;
}
const text = (value, max = 120) => String(value ?? '').trim().slice(0, max);
// 只接受数字或十进制数字字符串；true、[5]、"0x10" 之类经 Number() 会变成数字的值一律拒绝。
function num(value, fallback, min, max, label, integer = false) {
  const n = value === '' || value == null ? fallback
    : typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail('CONFIG', `${label}应在 ${min}～${max} 之间${integer ? '，且为整数' : ''}`);
  return n;
}
export function normalizeConfig(input = {}) {
  for (const key of ['copyDataDisk','balanceGuard','includeVouchers']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('CONFIG', `${key} 必须为布尔值`);
  }
  const provider = input.provider ?? 'autodl';
  if (provider !== 'autodl') fail('CONFIG', '仅支持真实 AutoDL；旧版演练任务已停用');
  const mode = input.mode ?? 'create';
  if (!['create', 'clone', 'boot'].includes(mode)) fail('CONFIG', '任务模式无效');
  const action = input.action ?? 'observe';
  if (!['observe', 'execute'].includes(action)) fail('CONFIG', '执行方式无效');
  if (action === 'execute' && input.paidConsent !== true) fail('CONSENT', '自动创建或开机会产生 AutoDL 费用，请在表单中明确启用');
  const gpuModel = normalizeGpuModel(input.gpuModel);
  const regions = [...new Set((Array.isArray(input.regions) ? input.regions : ['北京B区']).map(x => text(x, 20)))];
  if (!regions.length || regions.some(x => !REGIONS.includes(x))) fail('CONFIG', '至少选择一个有效地区');
  // 原实例开机沿用现有规格、磁盘和环境，不接受新租用的镜像与价格字段。
  if (mode === 'boot') {
    const sourceId = text(input.sourceId, 80);
    if (!/^[a-zA-Z0-9]+-[a-zA-Z0-9]+$/.test(sourceId) || sourceId.startsWith('pro-')) fail('CONFIG', '请选择普通容器实例的完整 ID，本模式不支持 Pro 实例');
    if (regions.length !== 1) fail('CONFIG', '原实例开机只能使用该实例所在地区');
    return { name: text(input.name || `原实例开机 · ${gpuModel}`, 80), provider, mode, action,
      paidConsent: action === 'execute', sourceId, gpuModel, gpuCount: num(input.gpuCount, 1, 1, 12, 'GPU 数量', true), regions,
      cuda: '', imagePath: [], copyDataDisk: false, balanceGuard: false, includeVouchers: false,
      expectedHours: 1, balanceReserve: 0, extraDiskGB: 0, pricePolicy: 'official',
      maxGpuHourly: null, maxTotalHourly: null, maxStorageDaily: null, scanScope: 'full', fullScanSeconds: null,
      pollSeconds: num(input.pollSeconds, POLL_SECONDS.default, POLL_SECONDS.min, POLL_SECONDS.max, '检查间隔秒', true),
      timeoutMinutes: num(input.timeoutMinutes, 1440, 1, 10080, '监测时长分钟', true) };
  }
  if (mode === 'clone' && regions.length !== 1) fail('CONFIG', '克隆任务必须指定源实例所在的单个地区');
  // 克隆继承源实例的系统盘环境，CUDA 在首次检查时从 AutoDL 克隆页读取，不再由用户填写；新建按所选镜像。
  const cuda = mode === 'clone' ? '' : text(input.cuda || '12.1', 10);
  if (mode === 'create' && !/^1\d\.\d{1,2}$/.test(cuda)) fail('CONFIG', 'CUDA 版本请写成 12.1、12.8、13.0 等格式');
  const gpuCount = num(input.gpuCount, 1, 1, 12, 'GPU 数量', true);
  if (![1,2,3,4,5,6,7,8,10,12].includes(gpuCount)) fail('CONFIG', 'AutoDL 数量选项不支持此 GPU 数量');
  const sourceId = text(input.sourceId, 80);
  if (mode === 'clone' && !/^[a-zA-Z0-9]+-[a-zA-Z0-9]+$/.test(sourceId)) fail('CONFIG', '请填写完整源实例 ID（含中间横线）');
  const imagePath = (Array.isArray(input.imagePath) ? input.imagePath : text(input.imagePath, 500).split('/')).map(x => text(x, 150)).filter(Boolean);
  if (mode === 'create') {
    if (imagePath.length !== 4) fail('CONFIG', '请填写基础镜像四级完整路径：框架 / 框架版本 / Python(系统) / CUDA');
    const imageCuda = imagePath.at(-1).match(/^(?:CUDA\s*)?(1\d\.\d{1,2})$/i)?.[1];
    if (imageCuda !== cuda) fail('CONFIG', '镜像路径最后一级 CUDA 必须与任务 CUDA 完全一致');
    // AutoDL 下单前会对这种组合弹出架构提示，本程序不代为确认，因此建任务时就拒绝。
    const arch = archCudaProblem(gpuModel, cuda);
    if (arch) fail('CONFIG', arch + '。AutoDL 会在下单前提示该架构的 GPU 需要更高的 CUDA，请改选 CUDA 12.8 及以上的官方镜像或其他 GPU 型号');
  }
  // 旧任务继续尊重既有价格边界；新表单明确选择按官方实时报价。
  const pricePolicy=input.pricePolicy ?? 'limits';
  if(!['official','limits'].includes(pricePolicy))fail('CONFIG','价格策略无效');
  const maxGpuHourly = pricePolicy === 'official' ? null : num(input.maxGpuHourly, undefined, 0.01, 1000, '单卡每小时价格上限');
  const maxTotalHourly = pricePolicy === 'official' ? null : num(input.maxTotalHourly, undefined, 0.01, 10000, '配置每小时总价上限');
  const maxStorageDaily = pricePolicy === 'official' ? null : num(input.maxStorageDaily, undefined, 0, 10000, '磁盘每日费用上限');
  // 未指定时保持旧行为（每轮完整翻页）；控制台新表单默认提交首页优先。
  const scanScope = input.scanScope ?? 'full';
  if (!SCAN_SCOPES.includes(scanScope)) fail('CONFIG', '扫描方式无效');
  return {
    name: text(input.name || `${mode === 'clone' ? '迁移克隆' : '新建实例'} · ${gpuModel}`, 80),
    provider, mode, action, paidConsent: action === 'execute', gpuModel, gpuCount, regions, cuda,
    sourceId: mode === 'clone' ? sourceId : '',
    imagePath: mode === 'create' ? imagePath : [],
    copyDataDisk: mode === 'clone' && input.copyDataDisk !== false,
    balanceGuard: input.balanceGuard === true, includeVouchers: input.includeVouchers === true,
    expectedHours: num(input.expectedHours, 1, 0.1, 8760, '预计运行小时'),
    balanceReserve: num(input.balanceReserve, 0, 0, 1000000, '保留余额'),
    extraDiskGB: num(input.extraDiskGB, 0, 0, 100000, '数据盘额外扩容 GB', true),
    pricePolicy, maxGpuHourly, maxTotalHourly, maxStorageDaily,
    pollSeconds: num(input.pollSeconds, POLL_SECONDS.default, POLL_SECONDS.min, POLL_SECONDS.max, '检查间隔秒', true),
    scanScope, fullScanSeconds: scanScope === 'first-page' ? num(input.fullScanSeconds, FULL_SCAN_SECONDS.default, FULL_SCAN_SECONDS.min, FULL_SCAN_SECONDS.max, '完整翻页间隔秒', true) : null,
    timeoutMinutes: num(input.timeoutMinutes, 1440, 1, 10080, '监测时长分钟', true),
  };
}
export function normalizeNotifications(input, previous = {}) {
  if(input.rememberCredentials !== undefined && typeof input.rememberCredentials !== 'boolean') fail('CONFIG','是否记住通知凭据必须为布尔值');
  const value = {
    rememberCredentials: input.rememberCredentials === undefined ? previous.rememberCredentials !== false : input.rememberCredentials === true,
    webhookEnabled: input.webhookEnabled === true,
    webhookUrl: input.webhookUrl === '***' ? (previous.webhookUrl || '') : text(input.webhookUrl, 2048),
    webhookToken: input.webhookToken === '***' ? (previous.webhookToken || '') : text(input.webhookToken, 500),
    wechatEnabled: input.wechatEnabled === true,
    wechatToken: input.wechatToken === '***' ? (previous.wechatToken || '') : text(input.wechatToken, 500),
  };
  // Webhook 地址换到另一个网站时，原 Token 不能沿用：否则会发给新的接收方。与 AI 设置更换 Base URL 后需重新填写 Key 一致。
  if (input.webhookToken === '***' && value.webhookToken && previous.webhookUrl && value.webhookUrl !== previous.webhookUrl) {
    const origin = u => { try { return new URL(u).origin; } catch { return ''; } };
    if (origin(value.webhookUrl) !== origin(previous.webhookUrl)) fail('CONFIG', 'Webhook 地址换到了另一个网站，请重新填写 Webhook Token（原 Token 不会发给新地址）；不需要 Token 时请清空');
  }
  if (value.webhookEnabled) {
    let url; try { url = new URL(value.webhookUrl); } catch { fail('CONFIG', 'Webhook URL 格式无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('CONFIG', 'Webhook 需使用 HTTPS，且不能在 URL 中包含用户名密码');
  }
  // Token 只能是单行可见字符：含换行等控制字符时发送请求会失败，报错原文还会带出 Token。
  for (const [key, label] of [['webhookToken', 'Webhook Token'], ['wechatToken', '微信消息 Token']])
    if (/[\s\u0000-\u001f\u007f]/u.test(value[key])) fail('CONFIG', label + '不能包含空格、换行或其他控制字符');
  if (value.wechatEnabled && !value.wechatToken) fail('CONFIG', '请填写 AutoDL 微信消息 Token');
  return value;
}

