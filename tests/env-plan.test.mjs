import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, satisfies, excludesFrom, unsatisfiable, normalizeSpecText, gpuSpec, extractConstraints, checkModelItems,
  mergeConstraints, planGpus, buildPlan, imageHint, pickImageOption, normalizeImageHint, archFit, sizeEstimate, vramNeed } from '../src/env-plan.mjs';
import { syntheticImageOptions } from './fixtures/images.mjs';

// 合成型号目录：名称取自 AutoDL 创建页的真实写法，库存为虚构数字。
const NAMES = ['vGPU-32GB', 'RTX 5090', 'RTX PRO 6000', 'A800-80GB-NVLink', 'RTX 4090D', 'RTX 4090', 'RTX 3080 Ti', 'CPU', 'H800', 'RTX 3090', 'V100-SXM2-32GB', 'RTX 2080 Ti', 'Tesla T4', 'RTX 6000D'];
const CATALOG = { checkedAt: 1, regions: [{ region: '北京B区', models: NAMES.map((model, i) => ({ model, available: i % 3, total: 8, disabled: false })) },
  { region: '西北B区', models: [{ model: 'RTX 4090', available: 0, total: 8, disabled: false }] }] };
const verdicts = text => Object.fromEntries(planGpus(CATALOG, extractConstraints(text)).map(g => [g.model, g.status]));

test('版本条件：==2.1 视为 2.1.x，上界判断、冲突与写法规范化', () => {
  assert.equal(satisfies('2.1.3', parseSpec('==2.1')), true); assert.equal(satisfies('2.2.0', parseSpec('==2.1')), false);
  assert.equal(satisfies('3.10.4', parseSpec('>=3.8,<3.12')), true); assert.equal(satisfies('3.12', parseSpec('~=3.10')), true);
  assert.equal(excludesFrom(parseSpec('==2.1.0'), '2.7'), true); assert.equal(excludesFrom(parseSpec('<2.7'), '2.7'), true);
  assert.equal(excludesFrom(parseSpec('<=2.7'), '2.7'), false); assert.equal(excludesFrom(parseSpec('>=1.12'), '2.7'), false);
  assert.equal(unsatisfiable(parseSpec('==2.1.0,==2.2.0')), true); assert.equal(unsatisfiable(parseSpec('==2.1,==2.1.0')), false);
  assert.deepEqual(['=1.11.0', '>= 1.12 , < 2.2', '≥2.0', '==2.1.0+cu121'].map(normalizeSpecText), ['==1.11.0', '>=1.12,<2.2', '>=2.0', '==2.1.0']);
  assert.equal(parseSpec('latest'), null);
});
test('按 AutoDL 型号名识别架构与单卡显存；同名多版本、改装卡和未知型号不猜', () => {
  const s = name => { const g = gpuSpec(name); return [g.sm, g.vramGB]; };
  assert.deepEqual(s('RTX 5090'), [120, 32]); assert.deepEqual(s('RTX PRO 6000'), [120, 96]); assert.deepEqual(s('RTX 4090D'), [89, 24]);
  assert.deepEqual(s('A800-80GB-NVLink'), [80, 80]); assert.deepEqual(s('V100-SXM2-32GB'), [70, 32]); assert.deepEqual(s('H800'), [90, 80]);
  assert.deepEqual(s('RTX 3080 Ti'), [86, 12]); assert.deepEqual(s('A100-PCIE-40GB'), [80, 40]);
  for (const name of ['A100', 'RTX 3080', 'RTX 5090 D', 'RTX 2080 Ti x2', 'RTX 3080x2']) assert.equal(gpuSpec(name).vramGB, null, name);
  assert.deepEqual(s('vGPU-48GB-425W'), [null, 48]); assert.deepEqual(s('RTX 6000D'), [null, null]);
  assert.equal(gpuSpec('CPU-close-HT').cpu, true);
});
test('规则只认明确写法：依赖固定版本、CUDA 构建、Python、显存要求、特性，并附原文出处', () => {
  const c = extractConstraints('pip install torch==2.1.0+cu121 --index-url https://download.pytorch.org/whl/cu121\n- python=3.10\nflash-attn==2.5.6\n推理需要至少 24GB 显存。\ntorchrun --nproc_per_node=8 train.py --bf16');
  assert.equal(c.framework.value, 'PyTorch'); assert.deepEqual(c.torch.spec, [['==', '2.1.0']]); assert.deepEqual(c.cuda.spec, [['==', '12.1']]);
  assert.deepEqual(c.python.spec, [['==', '3.10']]); assert.equal(c.vramGB.value, 24); assert.equal(c.gpuCount.value, 8);
  assert.deepEqual(c.features.map(f => f.value), ['flash-attn', 'bf16']); assert.match(c.vramGB.evidence[0], /24GB 显存/);
  // 不把 torchvision、torch_dtype、设备号或训练机器描述当作约束
  const none = extractConstraints('torchvision==0.16.0\ntorch_dtype=torch.float16\nCUDA_VISIBLE_DEVICES\nWe trained on 8 A100 GPUs with 80GB memory.');
  assert.equal(none.torch, null); assert.equal(none.cuda, null); assert.equal(none.vramGB, null);
  const conflict = extractConstraints('torch==1.13.1\ntorch==2.0.1');
  assert.equal(conflict.torch.ambiguous, true);
  const many = extractConstraints('Vicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.');
  assert.equal(many.vramGB.ambiguous, true); assert.deepEqual(many.vramGB.candidates, [14, 28]);
  assert.deepEqual(extractConstraints("['sm_50', 'sm_80', 'sm_86', 'sm_90']").archList.value, ['sm_50', 'sm_80', 'sm_86', 'sm_90']);
});
test('模型补充：只收白名单字段，引用必须是原文且包含该值；依赖版本以规则为准，显存按需求取模型的值', () => {
  const source = 'Vicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.\ntorch==2.1.0';
  const { accepted, rejected } = checkModelItems([
    { field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB of GPU memory.' },
    { field: 'torch', value: '>=2.3', evidence: 'torch==2.1.0' },
    { field: 'vramGB', value: '40', evidence: '训练需要 40GB 显存' },
    { field: 'gpuCount', value: '2', evidence: 'Vicuna-13B requires around 28GB' },
    { field: 'command', value: 'rm -rf /', evidence: 'torch==2.1.0' },
    { field: 'feature', value: 'flash-attn', evidence: 'torch==2.1.0' },
  ], source);
  assert.deepEqual(accepted.map(a => a.field), ['vramGB']);
  assert.deepEqual(rejected.map(r => r.reason), ['引用中没有该版本号', '引用不是输入资料中的原文', '引用中没有该数值', '不在允许的字段内', '特性名称无效或引用中没有']);
  const merged = mergeConstraints(extractConstraints(source), [...accepted, { field: 'torch', spec: [['>=', '2.0']], evidence: 'torch==2.1.0' }]);
  assert.equal(merged.vramGB.value, 28); assert.equal(merged.vramGB.source, 'model'); assert.match(merged.vramGB.note, /14、28/);
  assert.deepEqual(merged.torch.spec, [['==', '2.1.0']]); assert.match(merged.torch.note, /以依赖文件为准/);
});
test('选卡：旧 CUDA 排除 Ampere/Ada/Blackwell，torch 2.1 排除 Blackwell，显存不足排除，CPU 排除，未知型号需核对', () => {
  // 架构与版本的判断（写明显存需求，只看架构）
  const old = verdicts('torch==1.8.1+cu102\n需要至少 8GB 显存');
  assert.equal(old['RTX 4090'], 'excluded'); assert.equal(old['RTX 3090'], 'excluded'); assert.equal(old['RTX 5090'], 'excluded');
  assert.equal(old['RTX 2080 Ti'], 'ok'); assert.equal(old['V100-SXM2-32GB'], 'ok'); assert.equal(old['H800'], 'warn');
  const mid = verdicts('pip install torch==2.1.0+cu121\n推理需要至少 24GB 显存。');
  assert.equal(mid['RTX 4090'], 'ok'); assert.equal(mid['RTX 5090'], 'excluded'); assert.equal(mid['RTX PRO 6000'], 'excluded');
  assert.equal(mid['RTX 3080 Ti'], 'excluded'); assert.equal(mid['CPU'], 'excluded'); assert.equal(mid['vGPU-32GB'], 'check'); assert.equal(mid['RTX 6000D'], 'check');
  const fresh = verdicts('torch>=2.7\npip install torch --index-url https://download.pytorch.org/whl/cu128\n需要至少 8GB 显存');
  assert.equal(fresh['RTX 5090'], 'ok'); assert.equal(fresh['V100-SXM2-32GB'], 'warn');
  // 资料里出现 flash-attn 只提醒；模型按用户目标确认需要时才排除
  assert.equal(verdicts('flash-attn\n需要至少 8GB 显存')['V100-SXM2-32GB'], 'warn');
  const needs = mergeConstraints(extractConstraints('训练需要 flash-attn\n需要至少 8GB 显存'), [{ field: 'feature', value: 'flash-attn', evidence: '训练需要 flash-attn' }]);
  assert.equal(planGpus(CATALOG, needs).find(g => g.model === 'V100-SXM2-32GB').status, 'excluded');
});
test('克隆前检查：源环境 get_arch_list 不含目标卡可用内核时排除，同主版本低版本内核视为兼容', () => {
  assert.equal(archFit(89, ['sm_80', 'sm_86']), 'compatible'); assert.equal(archFit(120, ['sm_80', 'sm_90']), 'none');
  assert.equal(archFit(120, ['sm_90', 'compute_90']), 'ptx'); assert.equal(archFit(90, ['sm_90']), 'native');
  const v = verdicts("['sm_50', 'sm_60', 'sm_70', 'sm_75', 'sm_80', 'sm_86', 'sm_90']\n需要至少 8GB 显存");
  assert.equal(v['RTX 5090'], 'excluded'); assert.equal(v['RTX 4090'], 'ok'); assert.equal(v['H800'], 'ok');
});
test('任务草稿与官方镜像：按型号下限逐级选择，固定版本不可用时停下并说明', async () => {
  const plan = buildPlan(extractConstraints('pip install torch==2.1.0+cu121\n推理需要至少 24GB 显存。'), CATALOG);
  assert.equal(plan.draft.gpuModel, 'RTX 4090'); assert.deepEqual(plan.draft.regions, ['北京B区', '西北B区']);
  assert.ok(plan.constraints.some(r => r.key === 'vramGB' && r.value === '≥ 24GB' && r.source === 'rule'));
  assert.match(plan.setupCommands[1], /get_arch_list/);
  const walk = async hint => { const path = []; for (let level = 0; level < 4; level++) { const pick = pickImageOption(level, (await syntheticImageOptions(path)).options, hint); if (!pick.label) return [...path, null]; path.push(pick.label); } return path; };
  assert.deepEqual(await walk(normalizeImageHint(plan.draft.imageHint)), ['PyTorch', '2.1.0', '3.10(ubuntu22.04)', '12.1']);
  assert.deepEqual(await walk(imageHint(extractConstraints('import torch'), 'RTX 5090')), ['PyTorch', '2.8.0', '3.12(ubuntu22.04)', '12.8']);
  assert.deepEqual(await walk(imageHint(extractConstraints('torch==2.1.0'), 'RTX 5090')), ['PyTorch', null]);
  assert.throws(() => normalizeImageHint({ torch: 'rm -rf' }), /格式无效/);
  assert.equal(buildPlan(extractConstraints('torch==1.8.1+cu102\n需要至少 200GB 显存'), CATALOG).draft, null);
});
test('显存要求未知时不判“可用”；资料没写显存时按模型大小估算：推理 1.2 × 权重，微调按 LLaMA-Factory 估算表，多卡平分', () => {
  const unknown = buildPlan(extractConstraints('pip install torch==2.1.0+cu121'), CATALOG);
  assert.equal(unknown.gpus.filter(g => g.status === 'ok').length, 0); assert.equal(unknown.draft, null); assert.match(unknown.notices[0], /没有读出显存要求/);
  assert.match(unknown.gpus.find(g => g.model === 'RTX 4090').reasons[0], /显存要求未知/);
  // 用户案例：只写“部署27b模型”
  const deploy = Object.fromEntries(planGpus(CATALOG, extractConstraints('部署27b模型')).map(g => [g.model, g.status]));
  for (const m of ['RTX 3090', 'RTX 4090', 'RTX 5090', 'V100-SXM2-32GB', 'RTX 2080 Ti', 'Tesla T4', 'RTX 3080 Ti']) assert.equal(deploy[m], 'excluded', m);
  assert.equal(deploy['A800-80GB-NVLink'], 'ok'); assert.equal(deploy['H800'], 'ok'); assert.equal(vramNeed(extractConstraints('部署27b模型')).gb, 65);
  const plan = buildPlan(extractConstraints('部署27b模型'), CATALOG);
  assert.match(plan.notices[0], /估算为每卡约 65GB/); assert.ok(plan.constraints.some(r => r.key === 'size' && r.source === 'estimate' && /27B · 推理 · FP16\/BF16 · 约 65GB/.test(r.value)));
  const two = Object.fromEntries(planGpus(CATALOG, extractConstraints('部署27b模型'), { gpuCount: 2 }).map(g => [g.model, g.status]));
  assert.equal(vramNeed(extractConstraints('部署27b模型'), 2).gb, 33); assert.equal(two['V100-SXM2-32GB'], 'excluded'); assert.equal(two['A800-80GB-NVLink'], 'ok');
  const q = extractConstraints('推理 Qwen2.5-27B int4', { request: '推理 Qwen2.5-27B int4' });
  assert.equal(vramNeed(q).gb, 17); assert.equal(planGpus(CATALOG, q).find(g => g.model === 'RTX 4090').status, 'ok');
  assert.equal(sizeEstimate('LoRA 微调 14B 模型').totalGB, 32); assert.equal(sizeEstimate('QLoRA 微调 7B').totalGB, 6); assert.equal(sizeEstimate('全参数微调 7B').totalGB, 120);
  assert.equal(sizeEstimate('部署 Mixtral 8x7B').paramsB, 56);
  // 资料写明的显存优先于估算；资料有多个显存数字时取最大
  assert.deepEqual(vramNeed(extractConstraints('推理 70B\n推理需要至少 24GB 显存')), { gb: 24, basis: 'stated' });
  assert.deepEqual(vramNeed(extractConstraints('Vicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.')), { gb: 28, basis: 'max' });
  // 不把 GPU 型号、token 数、显存、比特数或哈希当成参数量；多个参数量时不估算
  for (const t of ['B200', 'RTX 4090', '1.4B tokens', '4bit', '8GB', 'sha 7b3f']) assert.equal(sizeEstimate(t), null, t);
  assert.equal(sizeEstimate('Qwen3-30B-A3B').paramsB, 30); assert.equal(sizeEstimate('LLaVA-v1.5-7B').paramsB, 7); assert.equal(sizeEstimate('62亿参数').paramsB, 6.2);
  assert.equal(sizeEstimate('支持 7B、14B 与 72B 三种规模').ambiguous, true);
  assert.equal(sizeEstimate('支持 7B、14B 与 72B 三种规模', '推理 14B').paramsB, 14);
});
test('资料写明的显存是别的模型大小时改按估算；说不清是哪个模型且估算更大时介于两者之间的卡标为有风险', () => {
  const st = (text, request, gpuCount = 1) => Object.fromEntries(planGpus(CATALOG, extractConstraints(text, { request }), { gpuCount }).map(g => [g.model, g.status]));
  // 审查发现：资料只写了 2B / 7B 的显存，需求是 27B / 72B，旧逻辑把显存远远不够的卡判为可用
  const gemma = st('the 2B model needs at least 8GB VRAM', '部署 gemma 27B fp16');
  for (const m of ['RTX 2080 Ti', 'RTX 3090', 'RTX 4090', 'RTX 5090', 'V100-SXM2-32GB']) assert.equal(gemma[m], 'excluded', m);
  assert.equal(gemma['A800-80GB-NVLink'], 'ok');
  assert.deepEqual(vramNeed(extractConstraints('the 2B model needs at least 8GB VRAM', { request: '部署 gemma 27B fp16' })), { gb: 65, basis: 'estimate', ignoredGB: 8 });
  assert.match(buildPlan(extractConstraints('the 2B model needs at least 8GB VRAM', { request: '部署 gemma 27B fp16' }), CATALOG).notices[0], /说的是别的模型大小/);
  assert.ok(Object.values(st('Qwen-7B requires at least 16GB of GPU memory', '部署 Qwen-72B')).every(s => s === 'excluded' || s === 'check'));
  // 资料写了 24GB 但没说是哪个模型，需求 27B：24～65GB 的卡有风险
  const vague = st('推理需要至少 24GB 显存', '部署 27B 模型');
  assert.equal(vague['RTX 4090'], 'warn'); assert.equal(vague['RTX 3080 Ti'], 'excluded'); assert.equal(vague['A800-80GB-NVLink'], 'ok');
  // FastChat：同一句写了 7B 与 13B，规则只认出 14GB；需求 13B 时 24GB 的卡不再判为可用
  const chat = st('The command below requires around 14GB of GPU memory for Vicuna-7B and 28GB of GPU memory for Vicuna-13B.', '单卡运行 Vicuna-13B');
  assert.equal(chat['RTX 4090'], 'warn'); assert.equal(chat['V100-SXM2-32GB'], 'ok'); assert.equal(chat['RTX 3080 Ti'], 'excluded');
  // 没写需求、资料有多个模型大小而写明的显存没提到最大的那个：满足的卡也只是有风险
  assert.equal(st('the 2B model needs at least 8GB VRAM\nWe also release a 27B model.')['A800-80GB-NVLink'], 'warn');
  // 写明的显存与需求是同一大小时照常以资料为准
  assert.equal(st('Vicuna-13B requires around 28GB of GPU memory.', '推理 Vicuna-13B')['RTX 5090'], 'ok');
});
test('模型补充的数值与版本按完整数字核对；规则读到明确的显存时模型只能调高', () => {
  const src = 'Vicuna-13B requires around 28GB of GPU memory.\ntorch==2.1.0\nPython 3.10\nWe recommend Qwen-14B.\nPyTorch 2.10\nCUDA 12.8\n+cu121';
  const { accepted, rejected } = checkModelItems([
    { field: 'vramGB', value: '13', evidence: 'Vicuna-13B requires around 28GB' }, { field: 'vramGB', value: '2', evidence: 'torch==2.1.0' },
    { field: 'vramGB', value: '0.5', evidence: 'torch==2.1.0' }, { field: 'vramGB', value: '3', evidence: 'Python 3.10' }, { field: 'vramGB', value: '14', evidence: 'We recommend Qwen-14B.' },
    { field: 'torch', value: '==2.1', evidence: 'PyTorch 2.10' }, { field: 'torch', value: '==2.8', evidence: 'CUDA 12.8' }, { field: 'python', value: '==3.1', evidence: 'Python 3.10' },
    { field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB' }, { field: 'torch', value: '==2.1', evidence: 'torch==2.1.0' },
    { field: 'python', value: '==3.10', evidence: 'Python 3.10' }, { field: 'cuda', value: '12.1', evidence: '+cu121' },
  ], src);
  assert.deepEqual(accepted.map(a => a.field), ['vramGB', 'torch', 'python', 'cuda']); assert.equal(accepted[0].value, 28);
  assert.equal(rejected.length, 8); assert.equal(rejected[2].reason, '数值无效');
  const many = checkModelItems(Array.from({ length: 14 }, () => ({ field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB' })), src);
  assert.equal(many.accepted.length, 12); assert.match(many.rejected[0].reason, /超过 12 条/);
  const rules = extractConstraints('推理需要至少 24GB 显存\n小模型 14GB 也可以');
  const lower = mergeConstraints(rules, [{ field: 'vramGB', value: 14, evidence: '小模型 14GB 也可以' }]);
  assert.equal(lower.vramGB.value, 24); assert.equal(lower.vramGB.source, 'rule'); assert.match(lower.vramGB.note, /较低的 14GB/);
  assert.equal(mergeConstraints(rules, [{ field: 'vramGB', value: 40, evidence: '推理需要至少 24GB 显存' }]).vramGB.value, 40);
  const other = extractConstraints('the 70B model needs at least 140GB VRAM\nthe 7B model needs 16GB', { request: '推理 7B' });
  assert.equal(mergeConstraints(other, [{ field: 'vramGB', value: 16, evidence: 'the 7B model needs 16GB' }]).vramGB.value, 16);
  const byModel = mergeConstraints(extractConstraints('需要至少 24GB 显存\nTested with torch 2.1'), [{ field: 'torch', spec: [['==', '2.1']], evidence: 'Tested with torch 2.1' }]);
  assert.match(planGpus(CATALOG, byModel).find(g => g.model === 'RTX 5090').reasons.join(' '), /来自模型补充，请核对原文/);
});
test('超长空白输入不会让规划规则长时间占用后台；常见写法仍能读出', () => {
  const n = 23900;
  for (const text of ['CUDA' + ' '.repeat(n), 'torch 2.1' + ' '.repeat(n), 'requires about' + ' '.repeat(n), 'VRAM:' + ' '.repeat(n), '\n'.repeat(n), '\n'.repeat(n) + 'torch']) {
    const started = performance.now(); extractConstraints(text, { request: '部署 27B' });
    assert.ok(performance.now() - started < 100, JSON.stringify(text.slice(0, 12)));
  }
  assert.deepEqual(extractConstraints('torch 2.1.0').torch.spec, [['==', '2.1.0']]);
  assert.deepEqual(extractConstraints('CUDA 11.8 or higher').cuda.spec, [['>=', '11.8']]);
  assert.equal(extractConstraints('Inference requires at least  24 GB of GPU memory').vramGB.value, 24);
  assert.equal(extractConstraints('pip install flash-attn\n  flash_attn').features[0].value, 'flash-attn');
});

