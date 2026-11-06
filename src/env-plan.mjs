// 环境与选卡规划（确定性部分）：从项目资料读出硬约束，与已同步的 AutoDL 型号目录求交集。
// 不联网、不调用模型、不操作页面。模型只在 ai.mjs 中补充规则读不出的约束；合并时规则优先，模型的引用必须出现在原文中。
// GPU 规格按公开规格整理；名称识别不出或同名有多种显存版本时标为“需核对”，不猜。
import { fail } from './errors.mjs';
export const PLAN_TEXT_LIMIT = 24000;
export function normalizePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PLAN_INPUT', '规划输入必须是对象');
  const field = (value, limit, label) => { if (value !== undefined && (typeof value !== 'string' || value.length > limit)) fail('PLAN_INPUT', label + '格式无效或超过 ' + limit + ' 字符'); return (value || '').trim(); };
  const request = field(input.request, 1200, '需求说明'), projectText = field(input.projectText, PLAN_TEXT_LIMIT, '项目资料');
  if (!request && !projectText) fail('PLAN_INPUT', '请粘贴项目资料（README、requirements.txt、environment.yml 或报错）');
  const gpuCount = input.gpuCount === undefined ? 1 : Number(input.gpuCount);
  if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 12) fail('PLAN_INPUT', 'GPU 数量需为 1～12 的整数');
  const useModel = input.useModel === true;
  if (useModel && input.consent !== true) fail('AI_CONSENT', '请先确认将本次资料交给所选模型分析');
  return { request, projectText, gpuCount, useModel };
}

// ---- 版本条件，如 ">=1.12,<2.2"、"==2.1.0"、"~=3.10"；"==2.1" 视为 2.1.x ----
const nums = v => String(v).split('.').map(n => Number.parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}
const COMPARATOR = /^(==|>=|<=|~=|!=|>|<)(\d+(?:\.\d+){0,3})$/;
export function normalizeSpecText(raw) {
  return String(raw ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/\s+/g, '').replace(/\+[\w.]+/g, '').replace(/\.\*/g, '').replace(/,+$/, '').replace(/(^|,)=(?!=)/g, '$1==');
}
export function parseSpec(text) {
  const spec = [];
  for (const part of String(text || '').split(',').filter(Boolean)) { const m = part.match(COMPARATOR); if (!m) return null; spec.push([m[1], m[2]]); }
  return spec.length ? spec : null;
}
export const formatSpec = spec => (spec || []).map(([op, v]) => op + v).join(', ');
const prefixMatch = (version, pin) => { const v = nums(version); return nums(pin).every((n, i) => (v[i] || 0) === n); };
// ==2.1.0 的上界是 2.1.1（不含）；==2.1 的上界是 2.2（不含）
const nextPin = v => { const t = nums(v); t[t.length - 1]++; return t.join('.'); };
// ~=X.Y 允许 >=X.Y 且 <X+1；~=X.Y.Z 允许 >=X.Y.Z 且 <X.(Y+1)
const compatibleUpper = v => { const t = nums(v); if (t.length < 2) return String(t[0] + 1); const head = t.slice(0, -1); head[head.length - 1]++; return head.join('.'); };
function holds(version, [op, target]) {
  const c = compareVersions(version, target);
  if (op === '==') return prefixMatch(version, target);
  if (op === '!=') return !prefixMatch(version, target);
  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<') return c < 0;
  return c >= 0 && compareVersions(version, compatibleUpper(target)) < 0;
}
export const satisfies = (version, spec) => !spec || spec.every(item => holds(version, item));
// 条件允许的版本上界 [版本, 是否包含]；没有上界时为 null。
function upperBound(spec) {
  let best = null;
  const take = (v, inclusive) => { const c = best ? compareVersions(v, best[0]) : -1; if (c < 0 || (c === 0 && !inclusive)) best = [v, inclusive]; };
  for (const [op, v] of spec || []) {
    if (op === '<') take(v, false); else if (op === '<=') take(v, true);
    else if (op === '==') take(nextPin(v), false); else if (op === '~=') take(compatibleUpper(v), false);
  }
  return best;
}
const lowerBound = spec => (spec || []).filter(([op]) => ['>=', '>', '==', '~='].includes(op)).map(([, v]) => v).sort(compareVersions).pop() || null;
// 条件是否排除了所有不低于 version 的版本（例如 torch==2.1.0 排除了 2.7 及以上）。
export function excludesFrom(spec, version) {
  const up = upperBound(spec);
  return !!up && (compareVersions(up[0], version) < 0 || (compareVersions(up[0], version) === 0 && !up[1]));
}
export const requiresAtLeast = (spec, version) => { const low = lowerBound(spec); return !!low && compareVersions(low, version) >= 0; };
export function unsatisfiable(spec) {
  const low = lowerBound(spec), up = upperBound(spec), pins = (spec || []).filter(([op]) => op === '==').map(([, v]) => v);
  if (low && up && (compareVersions(low, up[0]) > 0 || (compareVersions(low, up[0]) === 0 && !up[1]))) return true;
  return pins.some(a => pins.some(b => !prefixMatch(a, b) && !prefixMatch(b, a)));
}
// ---- GPU 规格：按 AutoDL 型号名识别架构（计算能力 sm）与单卡显存（GB）----
// 顺序从具体到一般。名称里带“NNGB”时以名称为准；“x2”等改装/拼卡写法、同名多显存版本的显存记为未知。
const ARCH = { 60: 'Pascal', 61: 'Pascal', 70: 'Volta', 75: 'Turing', 80: 'Ampere', 86: 'Ampere', 89: 'Ada', 90: 'Hopper', 100: 'Blackwell', 120: 'Blackwell' };
const N = '(?!\\d)';
const GPU_TABLE = [
  [/RTX\s*PRO\s*6000|PRO\s*6000/i, 120, 96], [/RTX\s*PRO\s*5000/i, 120, 48], [/RTX\s*PRO\s*4500/i, 120, 32], [/RTX\s*PRO\s*4000/i, 120, 24],
  [/5090\s*D(?![a-z\d])/i, 120, null], [new RegExp('RTX\\s*5090' + N, 'i'), 120, 32],
  [new RegExp('RTX\\s*5080' + N, 'i'), 120, 16], [new RegExp('RTX\\s*5070\\s*Ti', 'i'), 120, 16], [new RegExp('RTX\\s*5070' + N, 'i'), 120, 12],
  [/\bG?B200\b|\bB100\b/i, 100, null],
  [/\bH200\b/i, 90, 141], [/\bH100\b/i, 90, 80], [/\bH800\b/i, 90, 80], [/\bH20\b/i, 90, 96], [/\bGH200\b/i, 90, null],
  [/RTX\s*6000\s*Ada/i, 89, 48], [/RTX\s*5000\s*Ada/i, 89, 32], [/RTX\s*4500\s*Ada/i, 89, 24], [/RTX\s*4000\s*Ada/i, 89, 20],
  [/\bL40S?\b/i, 89, 48], [/\bL20\b/i, 89, 48], [/\bL4\b/i, 89, 24],
  [new RegExp('4090\\s*D?' + N, 'i'), 89, 24], [new RegExp('4080\\s*(?:S(?:uper)?)?' + N, 'i'), 89, 16],
  [new RegExp('4070\\s*Ti\\s*S', 'i'), 89, 16], [new RegExp('4070\\s*Ti', 'i'), 89, 12], [new RegExp('4060\\s*Ti', 'i'), 89, null],
  [/\bA100\b/i, 80, null], [/\bA800\b/i, 80, null], [/\bA30\b/i, 80, 24],
  [/\bA40\b/i, 86, 48], [/\bA10\b/i, 86, 24], [/RTX\s*A6000|\bA6000\b/i, 86, 48], [/RTX\s*A5000|\bA5000\b/i, 86, 24], [/RTX\s*A4000|\bA4000\b/i, 86, 16],
  [new RegExp('3090\\s*(?:Ti)?' + N, 'i'), 86, 24], [new RegExp('3080\\s*Ti', 'i'), 86, 12], [new RegExp('3080' + N, 'i'), 86, null],
  [new RegExp('3070\\s*(?:Ti)?' + N, 'i'), 86, 8], [new RegExp('3060' + N, 'i'), 86, null],
  [/\bV100\b/i, 70, null], [/TITAN\s*V\b/i, 70, 12],
  [new RegExp('2080\\s*Ti', 'i'), 75, 11], [new RegExp('2080' + N, 'i'), 75, 8], [/\bT4\b/i, 75, 16], [/TITAN\s*RTX/i, 75, 24],
  [new RegExp('1080\\s*Ti', 'i'), 61, 11], [/TITAN\s*Xp/i, 61, 12], [/\bP100\b/i, 60, 16], [/\bP40\b/i, 61, 24],
];
export function gpuSpec(model) {
  const name = String(model || '').trim();
  if (/^CPU\b/i.test(name)) return { cpu: true, sm: null, arch: null, vramGB: null };
  const row = GPU_TABLE.find(([pattern]) => pattern.test(name));
  const named = name.match(/(\d{1,3})\s*GB/i), doubled = /x\s*\d\s*$/i.test(name);
  const vramGB = named ? Number(named[1]) : doubled ? null : row?.[2] ?? null;
  return { cpu: false, sm: row?.[1] ?? null, arch: row ? ARCH[row[1]] : null, vramGB };
}
// 各架构对环境的最低要求：CUDA 版本按 AutoDL 下单前提示（Ampere 11.0、Ada 11.3、Blackwell 12.8），
// PyTorch 版本按首个带该架构内核的正式版（Ampere 1.7、Hopper 2.0、Blackwell 2.7）。Hopper 低于 CUDA 11.8 只能靠 PTX 即时编译，仅提示。
const ARCH_NEEDS = { 80: { cuda: '11.0', torch: '1.7' }, 86: { cuda: '11.0', torch: '1.7' }, 89: { cuda: '11.3', torch: '1.7' },
  90: { cuda: '11.8', torch: '2.0', soft: true }, 100: { cuda: '12.8', torch: '2.7' }, 120: { cuda: '12.8', torch: '2.7' } };
const FEATURE_NEEDS = { 'flash-attn': { sm: 80, label: 'FlashAttention 2 需要 Ampere 及以上（sm_80+）' },
  bf16: { sm: 80, label: 'BF16 需要 Ampere 及以上（sm_80+）', soft: true }, fp8: { sm: 89, label: 'FP8 需要 Ada / Hopper 及以上（sm_89+）' } };
// ---- 规则提取：只认明确写法；读不准的留给模型或人工 ----
const lineAt = (text, index) => {
  const start = text.lastIndexOf('\n', index - 1) + 1, end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 240);
};
function hits(text, rules) {
  const out = [];
  for (const [pattern, map] of rules) for (const m of text.matchAll(pattern)) {
    const value = map(m);
    if (value !== null && value !== undefined) out.push({ value, evidence: lineAt(text, m.index) });
  }
  return out;
}
const cudaTag = d => d.length === 3 ? d.slice(0, 2) + '.' + d[2] : d[0] + '.' + d[1];
const OP = '[<>=!~≥≤]=?\\s*\\d+(?:\\.\\d+){0,3}(?:\\.\\*)?';
const SPEC = '(' + OP + '(?:\\s*,\\s*' + OP + ')*)';
const QUAL = '\\s{0,8}(?:及以上|以上|或更高|或以上|\\+(?!cu)|\\s{1,8}(?:or|and)\\s{1,8}(?:higher|later|above|newer))';
const LEAD = '(?:^|[\\s"\'\\[(,`])';
const TORCH_RULES = [
  [new RegExp(LEAD + '(?:torch|pytorch)\\s*' + SPEC, 'gim'), m => m[1]],
  [/\btorch\s+(\d+\.\d+(?:\.\d+)?)\+cu\d{2,3}/gi, m => '==' + m[1]],
  [/^[ \t]*torch[ \t]+(\d+\.\d+(?:\.\d+)?)[ \t]*$/gim, m => '==' + m[1]],
  [new RegExp('\\b(?:PyTorch|torch)\\s{0,8}(?:版本)?\\s{0,8}(\\d+\\.\\d+(?:\\.\\d+)?)' + QUAL, 'gi'), m => '>=' + m[1]],
];
const PY_RULES = [
  [new RegExp(LEAD + 'python\\s*' + SPEC, 'gim'), m => m[1]],
  [new RegExp('(?:python_requires|requires-python)\\s*=\\s*["\']\\s*' + SPEC, 'gi'), m => m[1]],
  [new RegExp('\\bPython\\s{0,8}(?:版本)?\\s{0,8}(3\\.\\d{1,2})' + QUAL, 'gi'), m => '>=' + m[1]],
  [/\bPython\s*(3\.\d{1,2})\s*[-–~至到]\s*(3\.\d{1,2})\b/gi, m => '>=' + m[1] + ',<' + nextPin(m[2])],
];
const CUDA_RULES = [
  [/\+cu(\d{2,3})\b/gi, m => '==' + cudaTag(m[1])],
  [/download\.pytorch\.org\/whl\/cu(\d{2,3})\b/gi, m => '==' + cudaTag(m[1])],
  [new RegExp('(?:pytorch-cuda|cudatoolkit|cuda-toolkit|cuda-version)\\s*' + SPEC, 'gi'), m => m[1]],
  [/nvidia\/cuda:(\d{1,2}\.\d)(?:\.\d+)?/gi, m => '==' + m[1]],
  [new RegExp('\\bCUDA\\s{0,8}(?:版本)?\\s{0,8}(1\\d\\.\\d)' + QUAL, 'gi'), m => '>=' + m[1]],
  [new RegExp('\\bCUDA\\s*' + SPEC, 'gi'), m => m[1]],
];
const GB = '(\\d{1,3}(?:\\.\\d{1,2})?)\\s*(?:GB|GiB|G\\b)';
const VRAM_RULES = [
  [new RegExp('(?:显存|GPU\\s*内存|显卡内存)[^\\n]{0,12}?(?:至少|不低于|不少于|大于|需要|需|约|大约|大概|>=|≥)\\s*' + GB, 'gi'), m => m[1]],
  [new RegExp('(?:至少|不低于|不少于|需要|需|约|大约|大概)[^\\n]{0,6}?' + GB + '[^\\n]{0,4}?(?:以上的)?\\s*(?:显存|GPU\\s*内存)', 'gi'), m => m[1]],
  [new RegExp('(?:at\\s+least|minimum(?:\\s+of)?|requires?(?:\\s+(?:about|around|approximately|roughly))?|needs?(?:\\s+(?:about|around))?)\\s{0,8}~?\\s{0,8}' + GB + '\\s{0,8}(?:of\\s+)?(?:GPU\\s+memory|VRAM|video\\s+memory)', 'gi'), m => m[1]],
  [new RegExp('(?:VRAM|显存)\\s{0,8}[:：]\\s{0,8}(?:>=|≥)?\\s{0,8}' + GB, 'gi'), m => m[1]],
];
const COUNT_RULES = [
  [/--nproc[_-]per[_-]node[=\s]+(\d{1,2})\b/gi, m => m[1]],
  [/--num[_-]gpus[=\s]+(\d{1,2})\b/gi, m => m[1]],
  [/CUDA_VISIBLE_DEVICES=(\d+(?:,\d+)*)/g, m => String(m[1].split(',').length)],
];
const FEATURE_RULES = [
  ['flash-attn', /pip\s+install[^\n]*\bflash[-_]attn\b|^[ \t]*flash[-_]attn\b|\bimport\s+flash_attn\b|\bfrom\s+flash_attn\b|attn_implementation\s*=\s*["']flash_attention_2/im],
  ['bf16', /--bf16(?![\w-])|\bbf16\s*[:=]\s*(?:true|1)\b|torch_dtype\s*=\s*(?:torch\.)?bfloat16/i],
  ['fp8', /\btransformer[-_]engine\b|--fp8(?![\w-])|\bfp8\s*[:=]\s*(?:true|1)\b/i],
];
function versionField(text, rules) {
  const seen = new Map(), evidence = [];
  for (const hit of hits(text, rules)) {
    const spec = parseSpec(normalizeSpecText(hit.value));
    if (!spec) continue;
    for (const item of spec) seen.set(item.join(''), item);
    if (!evidence.includes(hit.evidence)) evidence.push(hit.evidence);
  }
  if (!seen.size) return null;
  const spec = [...seen.values()];
  return { spec, evidence: evidence.slice(0, 4), source: 'rule', ...(unsatisfiable(spec) ? { ambiguous: true, note: '资料中的版本要求互相冲突' } : {}) };
}
function numberField(text, rules, { max, integer = false }) {
  const values = [], evidence = [];
  for (const hit of hits(text, rules)) {
    const n = Number(hit.value);
    if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) continue;
    if (!values.includes(n)) values.push(n);
    if (!evidence.includes(hit.evidence)) evidence.push(hit.evidence);
  }
  if (!values.length) return null;
  return values.length === 1 ? { value: values[0], evidence: evidence.slice(0, 3), source: 'rule' }
    : { candidates: values, evidence: evidence.slice(0, 4), source: 'rule', ambiguous: true, note: '资料中有多个不同数值（可能对应不同模型或用途）' };
}
function framework(text) {
  for (const [name, pattern] of [['PyTorch', /\b(?:py)?torch\b/i], ['TensorFlow', /\btensorflow\b/i], ['PaddlePaddle', /\bpaddle(?:paddle)?\b/i], ['JAX', /\bjax\b/i]]) {
    const m = text.match(pattern);
    if (m) return { value: name, evidence: [lineAt(text, m.index)], source: 'rule' };
  }
  return null;
}
// ---- 资料没写显存时，按参数量估算（确定性公式，不用模型）----
// 推理：权重显存 = 参数量 × 每参数字节（FP16/BF16 为 2，INT8 为 1，INT4 为 0.5），总显存 ≈ 1.2 × 权重显存（EleutherAI《Transformer Math 101》）。
// 微调：按 LLaMA-Factory README“硬件依赖”估算表，参数量不在表中时按最近一列等比换算。
const FT_TABLE = { full: { 7: 120, 14: 240, 30: 600, 70: 1200, label: '全参数（bf16/fp16 混合精度）' },
  lora: { 7: 16, 14: 32, 30: 64, 70: 160, label: 'LoRA / Freeze（16 比特）' },
  qlora8: { 7: 10, 14: 20, 30: 40, 70: 80, label: 'QLoRA 8 比特' }, qlora4: { 7: 6, 14: 12, 30: 24, 70: 48, label: 'QLoRA 4 比特' },
  qlora2: { 7: 4, 14: 8, 30: 16, 70: 24, label: 'QLoRA 2 比特' } };
const TASK_RULES = [['qlora', /q[-\s]?lora/i], ['full', /全参|全量|full[\s-]?(?:fine-?tun|ft|parameter)|预训练|pre-?train/i],
  ['lora', /lora|微调|fine-?tun|训练|\btrain|sft|p-?tuning|freeze/i], ['infer', /推理|部署|运行|对话|生成|服务|inference|serve|serving|deploy|\brun\b|chat/i]];
const PRECISION = [[0.5, 'INT4', /int4|4[\s-]?bit|4\s*比特|\bq4|awq|gptq|nf4|gguf/i], [1, 'INT8', /int8|8[\s-]?bit|8\s*比特|\bq8|fp8/i], [4, 'FP32', /fp32|float32|全精度/i]];
const PARAM_RE = /(?<![\w.])(\d{1,4}(?:\.\d{1,2})?)\s*[Bb](?![a-zA-Z0-9]|\s*(?:tokens?|tok)\b)|(\d{1,5}(?:\.\d)?)\s*亿(?:参数|个参数)?/g;
const MOE_RE = /(?<![\w.])(\d{1,2})\s*[x×]\s*(\d{1,3}(?:\.\d)?)\s*[Bb](?![a-zA-Z0-9])/g;
function paramSizes(text) {
  const out = [], seen = new Set();
  const add = (v, index) => { const n = Math.round(v * 100) / 100; if (n >= 0.3 && n <= 2000 && !seen.has(n)) { seen.add(n); out.push({ value: n, evidence: lineAt(text, index) }); } };
  for (const m of text.matchAll(MOE_RE)) add(Number(m[1]) * Number(m[2]), m.index);
  const rest = text.replace(MOE_RE, s => ' '.repeat(s.length));
  for (const m of rest.matchAll(PARAM_RE)) add(m[1] ? Number(m[1]) : Number(m[2]) / 10, m.index);
  return out;
}
export function sizeEstimate(text, request = '') {
  const req = String(request || '').trim(), brief = text.trim().length <= 300 ? text : '';
  const own = paramSizes(req), all = paramSizes(text);
  let size;
  if (own.length) size = own.reduce((a, b) => (b.value > a.value ? b : a));
  else if (all.length === 1) size = all[0];
  else if (all.length > 1) return { ambiguous: true, candidates: all.map(s => s.value + 'B'), evidence: all.slice(0, 3).map(s => s.evidence), source: 'estimate',
    note: '资料中有多个参数量，没有估算显存；请在“你要做什么”里写明要用的模型大小' };
  if (!size) return null;
  const hint = req + '\n' + brief;
  let task = (TASK_RULES.find(([, re]) => re.test(req)) || TASK_RULES.find(([, re]) => re.test(brief)) || ['infer'])[0];
  // 量化底座上的参数高效微调（如“INT4 量化下做 P-Tuning”）按 QLoRA 估算
  const quantBits = /int4|4[\s-]?bit|4\s*比特|nf4/i.test(hint) ? '4' : /int8|8[\s-]?bit|8\s*比特/i.test(hint) ? '8' : '';
  if (task === 'lora' && quantBits) task = 'qlora';
  const p = size.value, base = { paramsB: p, evidence: [size.evidence], source: 'estimate', task, ...(own.length ? { fromRequest: true } : {}) };
  if (task === 'infer') {
    const [bytes, prec] = (PRECISION.find(([, , re]) => re.test(hint)) || [2, 'FP16/BF16']).slice(0, 2);
    const gb = v => Math.ceil(p * v * 1.2);
    return { ...base, totalGB: gb(bytes), label: '推理 · ' + prec, formula: p + 'B × ' + bytes + ' 字节 × 1.2 ≈ ' + gb(bytes) + 'GB（EleutherAI 推理估算）',
      note: bytes === 2 ? '若用量化部署：INT8 约 ' + gb(1) + 'GB，INT4 约 ' + gb(0.5) + 'GB（在“你要做什么”里写明 int8 / int4 可按此判断）' : '' };
  }
  const bits = task === 'qlora' ? (hint.match(/([248])\s*(?:-?bit|比特)/i)?.[1] || quantBits || '4') : '';
  const table = FT_TABLE[task === 'qlora' ? 'qlora' + bits : task], col = [7, 14, 30, 70].reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a));
  const total = Math.ceil(table[col] * p / col);
  return { ...base, totalGB: total, label: '微调 · ' + table.label, note: task === 'lora' && !/lora|freeze/i.test(hint) ? '未写明微调方式，按 LoRA 估算；全参数微调需要的显存多得多' : '',
    formula: 'LLaMA-Factory 估算表：' + col + 'B ' + table.label + ' ' + table[col] + 'GB' + (col === p ? '' : '，按 ' + p + 'B 等比换算 ≈ ' + total + 'GB') };
}
// 资料写明的显存数字是否说的是用户要跑的那个模型：applies（同一大小）、other（只写了别的大小）、mixed（同一句里有几种大小）、
// nosize（没写模型大小）、uncovered（资料里有多个模型大小，写明的数字没提到最大的那个）。
const sameSize = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.05;
function vramFit(c) {
  const s = c.size, lines = c.vramGB?.evidence || [];
  const near = [...new Set(lines.flatMap(l => paramSizes(String(l)).map(x => x.value)))];
  if (s && !s.ambiguous && s.fromRequest) {
    const hit = near.some(x => sameSize(x, s.paramsB));
    return !near.length ? 'nosize' : !hit ? 'other' : near.every(x => sameSize(x, s.paramsB)) ? 'applies' : 'mixed';
  }
  if (s?.ambiguous) {
    const top = Math.max(...s.candidates.map(parseFloat));
    if (!near.some(x => sameSize(x, top))) return 'uncovered';
  }
  return 'applies';
}
// 本次判断用的单卡显存要求：资料写明的值优先；资料中有多个值时取最大的（保守）；都没有时用参数量估算（多卡平分）。
// 写明的数字说的是别的模型大小时改用估算；说不清是哪个模型且估算更大时，介于两者之间的卡标为有风险（warnUntil）。
export function vramNeed(c, gpuCount = 1) {
  const est = c.size && !c.size.ambiguous && c.size.totalGB ? Math.ceil(c.size.totalGB / Math.max(1, gpuCount)) : null;
  const stated = !c.vramGB ? null : !c.vramGB.ambiguous ? { gb: c.vramGB.value, basis: 'stated' }
    : c.vramGB.candidates?.length ? { gb: Math.max(...c.vramGB.candidates), basis: 'max' } : null;
  if (!stated) return est ? { gb: est, basis: 'estimate' } : null;
  const fit = vramFit(c);
  if (fit === 'other' && est) return { gb: est, basis: 'estimate', ignoredGB: stated.gb };
  if ((fit === 'nosize' || fit === 'mixed') && est > stated.gb) return { ...stated, warnUntil: est };
  if (fit === 'uncovered') return { ...stated, uncovered: Math.max(...c.size.candidates.map(parseFloat)) };
  return stated;
}
export function extractConstraints(input, { request = '' } = {}) {
  const text = String(input ?? '').slice(0, PLAN_TEXT_LIMIT);
  const features = [];
  for (const [key, pattern] of FEATURE_RULES) {
    const m = text.match(pattern);
    if (m) features.push({ value: key, evidence: [lineAt(text, m.index)], source: 'rule' });
  }
  const arch = [...new Set([...text.matchAll(/'((?:sm|compute)_\d{2,3}a?)'/g)].map(m => m[1].replace(/a$/, '')))];
  const archHit = arch.length ? text.search(/'(?:sm|compute)_\d{2,3}a?'/) : -1;
  return {
    framework: framework(text), torch: versionField(text, TORCH_RULES), python: versionField(text, PY_RULES), cuda: versionField(text, CUDA_RULES),
    vramGB: numberField(text, VRAM_RULES, { max: 2000 }), gpuCount: numberField(text, COUNT_RULES, { max: 64, integer: true }),
    features, archList: arch.length ? { value: arch, evidence: [lineAt(text, archHit)], source: 'rule' } : null,
    size: sizeEstimate(text, request),
  };
}
// ---- 模型补充：只收白名单字段；引用须是原文连续片段且含有该值，否则丢弃并写明原因 ----
const MODEL_FIELDS = ['framework', 'torch', 'python', 'cuda', 'vramGB', 'gpuCount', 'feature'];
const FRAMEWORKS = { pytorch: 'PyTorch', torch: 'PyTorch', tensorflow: 'TensorFlow', paddlepaddle: 'PaddlePaddle', paddle: 'PaddlePaddle', jax: 'JAX' };
const FRAMEWORK_WORDS = { PyTorch: /torch/i, TensorFlow: /tensorflow/i, PaddlePaddle: /paddle/i, JAX: /\bjax\b/i };
const FEATURE_WORDS = { 'flash-attn': /flash[\s_-]?att/i, bf16: /bf16|bfloat16/i, fp8: /fp8|transformer[-_\s]?engine/i };
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
// 版本号按完整数字比较：2.1 不匹配 2.10、12.1，可匹配 2.1.0；CUDA 也认 cu121 这种写法。
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasVersion = (text, v, cuda) => new RegExp('(?<![\\d.])' + reEscape(v) + '(?!\\d)').test(text)
  || (cuda && new RegExp('cu' + v.replace('.', '') + '(?!\\d)', 'i').test(text));
// 显存数字必须紧跟 GB/GiB/G；卡数不能是版本号、参数量（7B）或显存（8GB）的一部分。
const VRAM_NUM = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:GB|GiB|G)(?![A-Za-z])/gi;
const COUNT_NUM = /(?<![\d.])(\d{1,2})(?![\d.]|\s*(?:GB|GiB|G\b|[bB]\b))/g;
export function checkModelItems(items, sourceText) {
  const source = squash(sourceText), accepted = [], rejected = [], list = Array.isArray(items) ? items : [];
  for (const item of list.slice(0, 12)) {
    const field = String(item?.field ?? ''), raw = squash(item?.value).slice(0, 80), evidence = squash(item?.evidence).slice(0, 300);
    const reject = reason => rejected.push({ field, value: raw, evidence, reason });
    if (!MODEL_FIELDS.includes(field)) { reject('不在允许的字段内'); continue; }
    if (evidence.length < 4 || !source.includes(evidence)) { reject('引用不是输入资料中的原文'); continue; }
    if (['torch', 'python', 'cuda'].includes(field)) {
      const spec = parseSpec(normalizeSpecText(/^[\d.]+$/.test(raw) ? '==' + raw : raw));
      if (!spec) { reject('版本条件格式无效'); continue; }
      const digits = spec.map(([, v]) => v), compact = evidence.replace(/\s+/g, '');
      if (!digits.every(v => hasVersion(compact, v, field === 'cuda'))) { reject('引用中没有该版本号'); continue; }
      accepted.push({ field, spec, evidence });
    } else if (field === 'vramGB' || field === 'gpuCount') {
      const n = Number(raw.replace(/\s*(?:GB|GiB|G|张|卡|块)$/i, ''));
      if (!Number.isFinite(n) || n < 1 || n > (field === 'vramGB' ? 2000 : 64) || (field === 'gpuCount' && !Number.isInteger(n))) { reject('数值无效'); continue; }
      const seen = [...evidence.matchAll(field === 'vramGB' ? VRAM_NUM : COUNT_NUM)].map(m => Number(m[1]));
      if (!seen.some(x => field === 'vramGB' ? Math.abs(x - n) <= 0.5 || Math.ceil(x) === n : x === n)) { reject('引用中没有该数值'); continue; }
      accepted.push({ field, value: n, evidence });
    } else if (field === 'framework') {
      const name = FRAMEWORKS[raw.toLowerCase().replace(/[\s_-]/g, '')];
      if (!name || !FRAMEWORK_WORDS[name].test(evidence)) { reject('框架名称无效或引用中没有'); continue; }
      accepted.push({ field, value: name, evidence });
    } else {
      const key = Object.keys(FEATURE_WORDS).find(k => k === raw.toLowerCase() || FEATURE_WORDS[k].test(raw));
      if (!key || !FEATURE_WORDS[key].test(evidence)) { reject('特性名称无效或引用中没有'); continue; }
      accepted.push({ field: 'feature', value: key, evidence });
    }
  }
  if (list.length > 12) rejected.push({ field: '其余条目', value: String(list.length - 12) + ' 条', evidence: '', reason: '超过 12 条的部分未核对，已丢弃' });
  return { accepted, rejected };
}
// 合并：依赖文件里的版本、框架以规则为准，模型只填空；显存与卡数取决于用户要跑什么，引用核对通过时以模型为准，并记下规则读到的值。
export function mergeConstraints(rules, accepted = []) {
  const merged = structuredClone(rules), sameSpec = (a, b) => formatSpec(a) === formatSpec(b);
  for (const item of accepted) {
    const model = { source: 'model', evidence: [item.evidence] };
    if (['torch', 'python', 'cuda'].includes(item.field)) {
      const rule = merged[item.field];
      if (!rule) merged[item.field] = { ...model, spec: item.spec };
      else if (!sameSpec(rule.spec, item.spec)) rule.note = [rule.note, '模型读到 ' + formatSpec(item.spec) + '，以依赖文件为准'].filter(Boolean).join('；');
    } else if (item.field === 'vramGB' || item.field === 'gpuCount') {
      const rule = merged[item.field];
      // 规则读到一个明确的显存数字时，模型只能调高，不能调低：防止模型读错或资料中夹带的文字把显存不够的卡放进来。
      // 例外：规则读到的那句说的是别的模型大小（或同一句里有几种大小）。
      if (item.field === 'vramGB' && rule?.source === 'rule' && !rule.ambiguous && item.value < rule.value && !['other', 'mixed'].includes(vramFit(merged))) {
        rule.note = [rule.note, '模型读到较低的 ' + item.value + 'GB，以资料写明的 ' + rule.value + 'GB 为准'].filter(Boolean).join('；');
        continue;
      }
      const note = !rule ? '' : rule.ambiguous ? '资料中另有 ' + rule.candidates.join('、') + '，按需求选用此值' : rule.value !== item.value ? '规则读到 ' + rule.value + '，按需求选用此值' : '';
      if (!rule || rule.value !== item.value) merged[item.field] = { ...model, value: item.value, ...(note ? { note } : {}) };
    } else if (item.field === 'framework') { if (!merged.framework) merged.framework = { ...model, value: item.value }; }
    else if (!merged.features.some(f => f.value === item.value)) merged.features.push({ ...model, value: item.value });
  }
  return merged;
}
// ---- 求解：每个型号给出 可用(ok) / 有风险(warn) / 需核对(check) / 不满足(excluded) 及原因 ----
const RANK = { ok: 0, warn: 1, check: 2, excluded: 3 };
// 源环境 torch.cuda.get_arch_list() 能否在目标卡上运行：同主版本的低版本 sm 内核二进制兼容；compute_XX 只能即时编译。
export function archFit(sm, list) {
  const parsed = (list || []).map(s => String(s).match(/^(sm|compute)_(\d+)$/)).filter(Boolean).map(m => ({ ptx: m[1] === 'compute', cc: Number(m[2]) }));
  const major = cc => Math.floor(cc / 10);
  if (parsed.some(a => !a.ptx && a.cc === sm)) return 'native';
  if (parsed.some(a => !a.ptx && major(a.cc) === major(sm) && a.cc < sm)) return 'compatible';
  return parsed.some(a => a.ptx && a.cc <= sm) ? 'ptx' : 'none';
}
export function assessGpu(spec, c, gpuCount = 1) {
  if (spec.cpu) return { status: 'excluded', reasons: ['无 GPU 的 CPU 实例'] };
  const reasons = [];
  let status = 'ok';
  const flag = (level, text) => { if (RANK[level] > RANK[status]) status = level; reasons.push(text); };
  // 显存要求未知时不能判“可用”：只能说明架构与版本上没有冲突，放不放得下要用户确认。
  const mem = vramNeed(c, gpuCount), basis = { stated: '所需', max: '资料中最大的', estimate: '估算所需' }[mem?.basis];
  if (!mem) flag('check', '显存要求未知（资料没写，也没有模型大小可估算），无法判断模型放不放得下');
  else if (spec.vramGB === null) flag('check', '单卡显存未知（同名有多种版本），需在 AutoDL 页面核对是否 ≥ ' + (mem.warnUntil || mem.gb) + 'GB');
  else if (spec.vramGB < mem.gb) flag('excluded', '单卡显存 ' + spec.vramGB + 'GB，低于' + basis + ' ' + mem.gb + 'GB');
  else {
    reasons.push('单卡 ' + spec.vramGB + 'GB ≥ ' + basis + ' ' + mem.gb + 'GB');
    // 写明的数字说不清是哪个模型、而按要跑的模型大小估算需要更多时，介于两者之间的卡标为有风险。
    if (mem.warnUntil && spec.vramGB < mem.warnUntil) flag('warn', '按要跑的模型大小估算约需 ' + mem.warnUntil + 'GB；资料写的 ' + mem.gb + 'GB 可能对应别的模型或量化方式，需核对');
    if (mem.uncovered) flag('warn', '资料中最大的模型是 ' + mem.uncovered + 'B，写明的显存要求没有提到它；若要跑它，需核对');
    // 显存要求来自模型补充时，结论依赖模型对原文的理解（可能读错行列或把可选模式当成要求），标为有风险并给出原文。
    if (mem.basis !== 'estimate' && c.vramGB?.source === 'model') flag('warn', '显存要求来自模型补充，请核对原文：' + String(c.vramGB.evidence?.[0] || '').slice(0, 80));
  }
  if (spec.sm === null) { flag('check', '未能从型号名识别 GPU 架构，需自行核对与 CUDA / PyTorch 的兼容性'); return { status, reasons }; }
  const name = spec.arch + '（sm_' + spec.sm + '）', need = ARCH_NEEDS[spec.sm];
  const torch = c.torch && !c.torch.ambiguous ? c.torch.spec : null, cuda = c.cuda && !c.cuda.ambiguous ? c.cuda.spec : null;
  // 版本要求来自模型补充时在原因里注明，便于用户对照原文判断是否真的是要求
  const byModel = f => f?.source === 'model' ? '（来自模型补充，请核对原文）' : '';
  if (need && cuda && excludesFrom(cuda, need.cuda)) flag(need.soft ? 'warn' : 'excluded', need.soft
    ? name + '在 CUDA ' + need.cuda + ' 以下没有原生内核，只能靠 PTX 即时编译，需实测；资料要求 CUDA ' + formatSpec(cuda) + byModel(c.cuda)
    : name + '需要 CUDA ≥ ' + need.cuda + '，资料要求 CUDA ' + formatSpec(cuda) + byModel(c.cuda));
  if (need && torch && excludesFrom(torch, need.torch)) flag(need.soft ? 'warn' : 'excluded', need.soft
    ? name + '在 PyTorch ' + need.torch + ' 以下没有原生内核，需实测；资料要求 torch ' + formatSpec(torch) + byModel(c.torch)
    : name + '需要 PyTorch ≥ ' + need.torch + '，资料要求 torch ' + formatSpec(torch) + byModel(c.torch));
  if (spec.sm < 75 && cuda && requiresAtLeast(cuda, '13.0')) flag('excluded', 'CUDA 13 已不支持 ' + name);
  else if (spec.sm < 75 && cuda && requiresAtLeast(cuda, '12.8') && (c.framework?.value || 'PyTorch') === 'PyTorch')
    flag('warn', 'PyTorch 的 CUDA 12.8 及以上构建已不含 ' + name + ' 的内核，需使用 cu126 及以下构建，需核对');
  for (const f of c.features || []) {
    const n = FEATURE_NEEDS[f.value];
    if (!n) continue;
    if (spec.sm < n.sm) flag(f.source === 'model' && !n.soft ? 'excluded' : 'warn', n.label + '，本卡为 ' + name + (f.source === 'rule' ? '；资料中提到，若你的用法需要则不可用' : ''));
    else if (f.value === 'flash-attn' && spec.sm >= 100) flag('warn', 'FlashAttention 对 Blackwell 的支持取决于其版本，需核对');
  }
  const list = c.archList?.value;
  if (list?.length) {
    const fit = archFit(spec.sm, list);
    if (fit === 'none') flag('excluded', '源环境 PyTorch 不含可在 sm_' + spec.sm + ' 上运行的内核（' + list.join(' ') + '），会报 no kernel image');
    else if (fit === 'ptx') flag('warn', '源环境只能靠 PTX 即时编译在 sm_' + spec.sm + ' 上运行，首次运行较慢，需实测');
  }
  return { status, reasons };
}
export function planGpus(catalog, constraints, { gpuCount = 1 } = {}) {
  const byModel = new Map();
  for (const row of catalog?.regions || []) for (const item of row.models || []) {
    const entry = byModel.get(item.model) || { model: item.model, regions: [] };
    entry.regions.push({ region: row.region, available: item.available, total: item.total, disabled: item.disabled === true });
    byModel.set(item.model, entry);
  }
  return [...byModel.values()].map(entry => {
    const spec = gpuSpec(entry.model), verdict = assessGpu(spec, constraints, gpuCount);
    const idle = entry.regions.reduce((sum, r) => sum + (r.disabled ? 0 : r.available || 0), 0);
    return { ...entry, ...verdict, vramGB: spec.vramGB, arch: spec.arch, sm: spec.sm, idle, enough: entry.regions.some(r => !r.disabled && (r.available || 0) >= gpuCount) };
  }).sort((a, b) => RANK[a.status] - RANK[b.status] || Number(b.enough) - Number(a.enough) || b.idle - a.idle || (a.vramGB ?? 999) - (b.vramGB ?? 999) || a.model.localeCompare(b.model));
}
// ---- 官方镜像建议：按选中型号的架构下限与资料中的版本，在 AutoDL 四级菜单里逐级挑选 ----
const MENU = { PyTorch: 'PyTorch', TensorFlow: 'TensorFlow', PaddlePaddle: 'PaddlePaddle', JAX: 'JAX' };
export function imageHint(c, model) {
  const spec = gpuSpec(model), need = spec.sm ? ARCH_NEEDS[spec.sm] : null, firm = f => f && !f.ambiguous ? formatSpec(f.spec) : '';
  return { framework: MENU[c.framework?.value] || 'PyTorch', frameworkGuessed: !c.framework, torch: firm(c.torch), python: firm(c.python), cuda: firm(c.cuda),
    minTorch: need?.torch || '', minCuda: need?.cuda || '', maxCuda: spec.sm && spec.sm < 75 ? '12.8' : '' };
}
export function normalizeImageHint(input) {
  const hint = input && typeof input === 'object' ? input : {};
  const spec = value => { if (!value) return ''; const s = parseSpec(normalizeSpecText(value)); if (!s) fail('PLAN_INPUT', '镜像建议条件格式无效'); return formatSpec(s); };
  const version = value => /^\d+(?:\.\d+){0,3}$/.test(String(value || '')) ? String(value) : '';
  return { framework: Object.values(MENU).includes(hint.framework) ? hint.framework : 'PyTorch', frameworkGuessed: hint.frameworkGuessed === true,
    torch: spec(hint.torch), python: spec(hint.python), cuda: spec(hint.cuda), minTorch: version(hint.minTorch), minCuda: version(hint.minCuda), maxCuda: version(hint.maxCuda) };
}
const labelVersion = label => String(label).match(/^\s*(?:CUDA\s*)?(\d+\.\d+(?:\.\d+)?)/i)?.[1] || null;
const because = parts => parts.filter(Boolean).join('；');
// 返回 {label, reason}；label 为 null 表示这一级没有满足条件的官方选项，需要用户自行选择。
export function pickImageOption(level, options, hint) {
  const usable = (options || []).filter(o => o && !o.disabled && typeof o.label === 'string');
  const versioned = (cond, min, max) => usable.map(o => ({ o, v: labelVersion(o.label) })).filter(x => x.v && satisfies(x.v, parseSpec(normalizeSpecText(cond)))
    && (!min || compareVersions(x.v, min) >= 0) && (!max || compareVersions(x.v, max) < 0));
  if (level === 0) {
    const want = hint.framework.toLowerCase(), hit = usable.find(o => o.label.toLowerCase().replace(/\s/g, '') === want);
    return hit ? { label: hit.label, reason: hint.frameworkGuessed ? '资料未写明框架，按 PyTorch 选择' : '资料使用 ' + hint.framework }
      : { label: null, reason: '官方菜单中没有 ' + hint.framework };
  }
  if (hint.framework !== 'PyTorch') return { label: null, reason: '非 PyTorch 框架的版本请自行选择' };
  if (level === 1) {
    const list = versioned(hint.torch, hint.minTorch).sort((a, b) => compareVersions(b.v, a.v));
    const why = because([hint.torch && 'torch ' + hint.torch, hint.minTorch && '所选型号需要 ≥ ' + hint.minTorch]);
    return list.length ? { label: list[0].o.label, reason: why ? '在满足条件（' + why + '）的版本中选最高' : '资料未限定版本，选最新' }
      : { label: null, reason: '官方镜像没有满足条件（' + (why || '无') + '）的 PyTorch 版本，可改用 Miniconda 自行安装' };
  }
  if (level === 2) {
    const list = versioned(hint.python).sort((a, b) => compareVersions(b.v, a.v));
    return list.length ? { label: list[0].o.label, reason: hint.python ? '满足 Python ' + hint.python : '该版本可选的 Python' }
      : { label: null, reason: '没有满足 Python ' + hint.python + ' 的选项' };
  }
  const list = versioned(hint.cuda, hint.minCuda, hint.maxCuda).sort((a, b) => compareVersions(a.v, b.v));
  const why = because([hint.cuda && 'CUDA ' + hint.cuda, hint.minCuda && '所选型号需要 ≥ ' + hint.minCuda, hint.maxCuda && '所选型号需要 < ' + hint.maxCuda]);
  return list.length ? { label: list[0].o.label, reason: (why ? '在满足条件（' + why + '）的选项中' : '') + '选最低 CUDA，宿主驱动更容易满足' }
    : { label: null, reason: '没有满足条件（' + why + '）的 CUDA 选项，请改选其他 PyTorch 版本' };
}
// 拿到实例后在实例终端里手动运行的只读检查；本工具不执行。
export function setupCommands(c) {
  const lines = ['nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv'];
  const fw = c.framework?.value || 'PyTorch';
  if (fw === 'PyTorch') lines.push('python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"');
  if (fw === 'TensorFlow') lines.push('python -c "import tensorflow as tf; print(tf.__version__, tf.config.list_physical_devices(\'GPU\'))"');
  if (fw === 'PaddlePaddle') lines.push('python -c "import paddle; paddle.utils.run_check()"');
  if ((c.features || []).some(f => f.value === 'flash-attn')) lines.push('python -c "import flash_attn; print(flash_attn.__version__)"');
  return lines;
}
const LABELS = { framework: '框架', torch: 'PyTorch', python: 'Python', cuda: 'CUDA（镜像 / PyTorch 构建）', vramGB: '单卡显存', gpuCount: '资料中的卡数（仅供参考）', archList: '源环境支持的 GPU 架构' };
export function constraintRows(c, gpuCount = 1) {
  const rows = [], mem = vramNeed(c, gpuCount);
  for (const key of Object.keys(LABELS)) {
    const f = c[key];
    if (!f) continue;
    const value = f.spec ? formatSpec(f.spec) : Array.isArray(f.value) ? f.value.join(' ') : f.value !== undefined ? (key === 'vramGB' ? '≥ ' + f.value + 'GB' : String(f.value))
      : '多个候选：' + (f.candidates || []).join('、');
    const note = key === 'vramGB' && f.ambiguous ? [f.note, '选卡按其中最大的 ' + Math.max(...(f.candidates || [0])) + 'GB 判断；写明要跑哪个模型可更准'].filter(Boolean).join('；')
      : key === 'vramGB' && mem?.ignoredGB ? [f.note, '这句说的是别的模型大小，选卡没有采用，改按要跑的模型估算'].filter(Boolean).join('；') : f.note || '';
    rows.push({ key, label: LABELS[key], value, source: f.source, evidence: f.evidence || [], ambiguous: !!f.ambiguous, note });
  }
  const s = c.size;
  if (s?.ambiguous) rows.push({ key: 'size', label: '模型大小', value: '多个候选：' + s.candidates.join('、'), source: 'estimate', evidence: s.evidence, ambiguous: true, note: s.note });
  else if (s) {
    const used = mem?.basis === 'estimate', per = Math.ceil(s.totalGB / Math.max(1, gpuCount));
    rows.push({ key: 'size', label: '显存估算（按模型大小）', value: s.paramsB + 'B · ' + s.label + ' · 约 ' + s.totalGB + 'GB' + (gpuCount > 1 ? '，' + gpuCount + ' 卡平分每卡约 ' + per + 'GB' : ''),
      source: 'estimate', evidence: s.evidence, ambiguous: false,
      note: [s.formula, s.note, used ? (gpuCount > 1 ? '多卡需框架支持张量或流水线并行' : '')
        : mem?.warnUntil ? '资料写的 ' + mem.gb + 'GB 与估算不一致，介于两者之间的卡标为有风险' : '资料写明了显存要求，以资料为准'].filter(Boolean).join('；') });
  }
  for (const f of c.features || []) rows.push({ key: 'feature', label: '特性', value: f.value, source: f.source, evidence: f.evidence || [], ambiguous: false, note: '' });
  return rows;
}
export function buildPlan(constraints, catalog, { gpuCount = 1 } = {}) {
  const gpus = planGpus(catalog, constraints, { gpuCount }).map(g => g.status === 'excluded' ? g : { ...g, imageHint: imageHint(constraints, g.model) });
  const top = gpus.find(g => g.status === 'ok' && g.enough) || gpus.find(g => g.status === 'ok') || gpus.find(g => g.status === 'warn') || null;
  const mem = vramNeed(constraints, gpuCount), notices = [];
  if (!mem) notices.push('没有读出显存要求，也没有模型大小可以估算，所以没有型号能判为“可用”。请在“你要做什么”里写明模型和大小（例如“推理 Qwen2.5-27B”“LoRA 微调 7B”，量化部署可写 int4），或粘贴写有显存要求的 README 段落。');
  else if (mem.ignoredGB) notices.push('资料写的 ' + mem.ignoredGB + 'GB 说的是别的模型大小，与你要跑的 ' + constraints.size.paramsB + 'B 不符；改按模型大小估算为每卡约 ' + mem.gb + 'GB（' + constraints.size.label + '）。');
  else if (mem.basis === 'estimate') notices.push('资料没有写显存要求，按模型大小估算为每卡约 ' + mem.gb + 'GB（' + constraints.size.label + '）。估算不含长上下文与大批量，实际以实测为准。');
  else if (mem.basis === 'max') notices.push('资料中有多个显存数字，选卡按其中最大的 ' + mem.gb + 'GB 判断；写明要跑哪个模型，或勾选让 AI 按需求选择，可以更准。');
  if (mem?.warnUntil) notices.push('资料写的 ' + mem.gb + 'GB 没说清对应哪个模型；按你要跑的模型大小估算约需 ' + mem.warnUntil + 'GB，显存介于两者之间的卡标为“有风险”。');
  if (mem?.uncovered) notices.push('资料中最大的模型是 ' + mem.uncovered + 'B，写明的显存要求没有提到它；要跑它请在“你要做什么”里写明，可按模型大小估算。');
  return { constraints: constraintRows(constraints, gpuCount), gpus, notices, vramNeed: mem, catalogCheckedAt: catalog?.checkedAt || null, setupCommands: setupCommands(constraints),
    draft: top ? { gpuModel: top.model, gpuCount, status: top.status, regions: top.regions.filter(r => !r.disabled).map(r => r.region), imageHint: imageHint(constraints, top.model) } : null };
}

