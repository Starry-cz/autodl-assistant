import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AiAssistant, normalizeAiSettings, normalizeAnalysisInput, parseAnalysisResult, redactAiText } from '../src/ai.mjs';
import { Store } from '../src/store.mjs';
import { fixture, gate } from './helpers.mjs';

const SECRET = 'sk-synthetic-only-not-a-real-key-123456';
const INPUT = { consent: true, request: '只使用RTX 4090，预算不变，请分析环境要求', projectText: '项目要求 torch==2.1.0', errorText: '', mode: 'plan' };
const RESULT = { summary: '需要核对实际环境，尚未运行项目', findings: [{ message: '资料包含框架约束', evidence: 'torch==2.1.0' }],
  recommendations: [{ action: '核对项目安装说明', reason: '依赖文件不足以证明完整兼容', verification: '在目标实例上运行最小测试并记录结果' }], questions: ['项目的Python要求是什么？'], warnings: ['尚未执行GPU检查'] };
function response(result = RESULT, extra = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }, ...extra }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function setup(t, options = {}) {
  const f = fixture(t); const ai = new AiAssistant(f.store, options); t.after(() => ai.close()); return Object.assign(f, { ai });
}
function enable(ai, input = {}) { return ai.saveSettings({ enabled: true, apiKey: SECRET, ...input }); }

test('AI默认关闭且无Key，不请求模型，新建和克隆仍完成并产生完成通知', async t => {
  for (const mode of ['create', 'clone']) {
    const f = fixture(t, { mode }); let calls = 0;
    const ai = new AiAssistant(f.store, { fetchImpl: async () => { calls++; throw Error('不应调用'); } });
    assert.equal(ai.publicState().enabled, false); assert.equal(ai.publicState().hasKey, false);
    await assert.rejects(ai.analyze(INPUT), { code: 'AI_DISABLED' });
    await f.engine.tick(); await f.due(80000);
    assert.equal(f.task.state, 'completed'); assert.equal(f.submissions, 1);
    assert.equal(f.store.data.notifications.some(n => n.event === 'completed'), true); assert.equal(calls, 0); ai.close();
  }
});
test('保存AI配置不会调用模型，Key默认仅保存在内存，公共状态和文件无Key', t => {
  let calls = 0; const f = setup(t, { fetchImpl: async () => { calls++; } }); enable(f.ai);
  assert.equal(f.ai.publicState().ready, true); assert.equal(calls, 0);
  assert.equal(JSON.stringify(f.ai.publicState()).includes(SECRET), false);
  assert.equal(JSON.stringify(f.store.publicState()).includes(SECRET), false);
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(SECRET), false);
  const restarted = new AiAssistant(new Store(f.dir)); assert.equal(restarted.publicState().ready, false);
  assert.equal(restarted.publicState().enabled, true); restarted.close();
});
test('用户选择记住Key后可重启恢复，取消记住移除磁盘Key且当前运行仍可使用', t => {
  const f = setup(t); enable(f.ai, { rememberKey: true });
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(SECRET), false);
  const restored = new AiAssistant(new Store(f.dir)); assert.equal(restored.publicState().ready, true); restored.close();
  assert.equal(JSON.stringify(f.store.publicState()).includes(SECRET), false);
  f.ai.saveSettings({ rememberKey: false }); assert.equal(f.ai.publicState().ready, true);
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(SECRET), false);
});
test('清除Key同时停用，不能从本机配置重启恢复', t => {
  const f = setup(t); enable(f.ai, { rememberKey: true }); f.ai.clearKey();
  assert.equal(f.ai.publicState().ready, false); assert.equal(f.ai.publicState().hasKey, false);
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(SECRET), false);
  const restored = new AiAssistant(new Store(f.dir)); assert.equal(restored.publicState().hasKey, false); restored.close();
});
test('更换Base URL或厂商时不复用原Key，校验失败不覆盖已保存连接', t => {
  const f = setup(t); enable(f.ai);
  assert.throws(() => f.ai.saveSettings({ baseUrl: 'https://another.example.test/v1' }), { code: 'AI_KEY' });
  assert.equal(f.ai.publicState().baseUrl, 'https://api.deepseek.com');
  f.ai.saveSettings({ enabled: false, provider: 'custom', baseUrl: 'https://another.example.test/v1', model: 'model-x' });
  assert.equal(f.ai.publicState().hasKey, false);
});
test('模型连接拒绝不安全URL和无效范围，完整chat/completions地址会规范化', () => {
  for (const baseUrl of ['http://model.example.test', 'https://u:p@model.example.test', 'https://model.example.test?key=secret', 'https://model.example.test/#secret'])
    assert.throws(() => normalizeAiSettings({ baseUrl }), { code: 'AI_CONFIG' });
  for (const input of [{ timeoutSeconds: 1 }, { maxTokens: 9000 }, { provider: 'unknown' }, { model: 'invalid model' }])
    assert.throws(() => normalizeAiSettings(input));
  assert.equal(normalizeAiSettings({ baseUrl: 'https://model.example.test/v1/chat/completions/' }).baseUrl, 'https://model.example.test/v1');
});
test('未同意外发、资料过长或诊断缺少日志时均不请求模型', async t => {
  let calls = 0; const f = setup(t, { fetchImpl: async () => { calls++; return response(); } }); enable(f.ai);
  for (const input of [{ ...INPUT, consent: false }, { ...INPUT, mode: 'diagnose' }, { ...INPUT, projectText: 'x'.repeat(12001) },
    { ...INPUT, projectText: 'x'.repeat(12000), errorText: 'y'.repeat(5000) }]) await assert.rejects(f.ai.analyze(input));
  assert.equal(calls, 0);
});
test('模型请求只发送所填资料、使用服务端Key、非流式、拒绝重定向并解析引用', async t => {
  let call;
  const f = setup(t, { fetchImpl: async (url, options) => { call = { url, options }; return response(); } }); enable(f.ai);
  f.store.data.settings.wechatToken = 'synthetic-autodl-private-token';
  const before = JSON.stringify(f.task); const output = await f.ai.analyze(INPUT);
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.options.headers.Authorization, 'Bearer ' + SECRET); assert.equal(call.options.redirect, 'error');
  const sent = JSON.parse(call.options.body); assert.equal(sent.stream, false); assert.equal(sent.thinking.type, 'disabled');
  assert.equal(sent.response_format.type, 'json_object'); assert.equal(call.options.body.includes(SECRET), false);
  assert.equal(call.options.body.includes('synthetic-autodl-private-token'), false);
  assert.equal(call.options.body.includes(f.task.id), false); assert.equal(JSON.stringify(f.task), before);
  assert.equal(output.result.findings[0].evidenceMatched, true); assert.equal(output.meta.automaticExecution, false);
  assert.equal(output.meta.usage.total_tokens, 200); assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(INPUT.request), false);
});
test('百炼和自定义兼容接口使用用户模型，不强加DeepSeek特有参数', async t => {
  const calls = []; const f = setup(t, { fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(); } });
  for (const [provider, baseUrl] of [['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'], ['custom', 'https://models.example.test/v1']]) {
    enable(f.ai, { provider, baseUrl, model: 'synthetic-model' }); await f.ai.analyze(INPUT);
  }
  assert.match(calls[0].url, /compatible-mode\/v1\/chat\/completions$/);
  assert.equal(calls[1].url, 'https://models.example.test/v1/chat/completions');
  for (const call of calls) { assert.equal(call.body.model, 'synthetic-model'); assert.equal(call.body.thinking, undefined); assert.equal(call.body.response_format, undefined); }
});
test('输入与模型输出基础脱敏，不向用户回显模型意外返回的Key', async t => {
  let payload; const secretResult = { ...RESULT, summary: '不要传播 ' + SECRET };
  const f = setup(t, { fetchImpl: async (_url, options) => { payload = options.body; return response(secretResult); } }); enable(f.ai);
  const output = await f.ai.analyze({ ...INPUT, errorText: 'api_key=' + SECRET + '\nAuthorization: Bearer abc123456789\npassword=hidden-pass' });
  for (const secret of [SECRET, 'abc123456789', 'hidden-pass']) assert.equal(payload.includes(secret), false);
  assert.equal(JSON.stringify(output).includes(SECRET), false); assert.match(redactAiText('cookie=private-cookie'), /已隐藏/);
  const jsonAndHeaders = '{"api_key":"quoted-private-key","password":"quoted-private-pass","cookie":"first=one; second=two"}\nCookie: session=header-private-session; token=header-private-token';
  const redacted = redactAiText(jsonAndHeaders);
  for (const value of ['quoted-private-key', 'quoted-private-pass', 'first=one', 'second=two', 'header-private-session', 'header-private-token'])
    assert.equal(redacted.includes(value), false);
});
test('引用不在资料中时标记未匹配，JSON代码围栏可读取，多余执行字段丢弃', () => {
  const data = { ...RESULT, findings: [{ message: '待验证', evidence: '这是模型编造的原文' }], execute: true, paidConsent: true };
  const parsed = parseAnalysisResult('\x60\x60\x60json\n' + JSON.stringify(data) + '\n\x60\x60\x60', INPUT);
  assert.equal(parsed.findings[0].evidenceMatched, false); assert.equal(parsed.execute, undefined); assert.equal(parsed.paidConsent, undefined);
});
test('模型返回无效结构或非JSON时拒绝，不把建议误当任务结果', async t => {
  const f = setup(t, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '我已经创建实例' } }] }), { status: 200 }) });
  enable(f.ai); await assert.rejects(f.ai.analyze(INPUT), { code: 'AI_RESULT' });
  assert.equal(f.task.state, 'watching'); assert.equal(f.task.operation, null);
  assert.throws(() => parseAnalysisResult(JSON.stringify({ ...RESULT, recommendations: 'execute shell' }), INPUT), { code: 'AI_RESULT' });
});
test('过长响应、输出截断和工具调用均拒绝，不自动重试', async t => {
  let calls = 0; const f = setup(t, { fetchImpl: async () => { calls++; return new Response('x'.repeat(262145)); } }); enable(f.ai);
  await assert.rejects(f.ai.analyze(INPUT), { code: 'AI_RESULT' }); assert.equal(calls, 1);
  f.ai.fetch = async () => response(RESULT, { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(RESULT) } }] });
  await assert.rejects(f.ai.analyze(INPUT), { code: 'AI_TRUNCATED' });
  f.ai.fetch = async () => response(RESULT, { choices: [{ message: { content: JSON.stringify(RESULT), tool_calls: [{}] } }] });
  await assert.rejects(f.ai.analyze(INPUT), { code: 'AI_RESULT' });
});
test('鉴权失败、限流与网络异常只影响AI，不泄露上游错误或自动重试', async t => {
  const f = setup(t); enable(f.ai);
  for (const [status, code] of [[401, 'AI_AUTH'], [403, 'AI_AUTH'], [404, 'AI_ENDPOINT'], [429, 'AI_RATE_LIMIT'], [500, 'AI_UPSTREAM']]) {
    let calls = 0; f.ai.fetch = async () => { calls++; return new Response(SECRET, { status }); };
    await assert.rejects(f.ai.analyze(INPUT), error => error.code === code && !error.message.includes(SECRET)); assert.equal(calls, 1);
  }
  f.ai.fetch = async () => { throw new Error('socket error with ' + SECRET); };
  await assert.rejects(f.ai.analyze(INPUT), error => error.code === 'AI_NETWORK' && !error.message.includes(SECRET));
  await f.engine.tick(); await f.due(40000); assert.equal(f.task.state, 'completed');
});
test('模型长请求期间核心引擎仍完成，重复分析被拒绝，取消只影响AI', async t => {
  const entered = gate();
  const f = setup(t, { fetchImpl: async (_url, { signal }) => { entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  enable(f.ai); const pending = f.ai.analyze(INPUT); const rejected = assert.rejects(pending, { code: 'AI_CANCELLED' }); await entered.promise;
  await assert.rejects(f.ai.analyze(INPUT), { code: 'AI_BUSY' });
  await f.engine.tick(); await f.due(40000); assert.equal(f.task.state, 'completed'); assert.equal(f.submissions, 1);
  f.ai.cancel(); await rejected; assert.equal(f.ai.publicState().busy, false);
});
test('超时终止请求且释放忙状态，不使用真实等待或调用', async t => {
  let expire; let cleared = false;
  const f = setup(t, { setTimer: callback => { expire = callback; return 'fake-timer'; }, clearTimer: id => { cleared = id === 'fake-timer'; },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  enable(f.ai); const pending = f.ai.analyze(INPUT); const rejected = assert.rejects(pending, { code: 'AI_TIMEOUT' }); expire(); await rejected;
  assert.equal(cleared, true); assert.equal(f.ai.publicState().busy, false);
});
test('修改连接取消旧分析，旧模型结果不能作为当前连接的分析返回', async t => {
  const entered = gate();
  const f = setup(t, { fetchImpl: async (_url, { signal }) => { entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  enable(f.ai); const pending = f.ai.analyze(INPUT); const rejected = assert.rejects(pending, { code: 'AI_CANCELLED' }); await entered.promise;
  f.ai.clearKey(); await rejected; assert.equal(f.ai.publicState().enabled, false);
});
test('AI配置损坏仅停用AI，不使已有核心任务状态无法加载', t => {
  const f = fixture(t); f.store.data.aiSettings = { provider: 'removed-provider', apiKey: SECRET }; f.store.save();
  const loaded = new Store(f.dir); const ai = new AiAssistant(loaded);
  assert.equal(loaded.tasks().length, 1); assert.equal(ai.publicState().enabled, false); assert.match(ai.publicState().notice, /无效/); ai.close();
});
// ---- 环境规划抽取（fetch 均为替身，不连接真实模型） ----
const PLAN_SOURCE = 'Vicuna-7B requires around 14GB of GPU memory. Vicuna-13B requires around 28GB of GPU memory.\ntorch==2.1.0';
test('环境规划抽取使用用户自己的 Key 与 Chat Completions：服务端 Key、非流式、DeepSeek 关闭思考并要求 JSON', async t => {
  let call;
  const f = setup(t, { fetchImpl: async (url, options) => { call = { url, options }; return response({ items: [], summary: '无' }); } }); enable(f.ai);
  const out = await f.ai.extract({ request: '推理 Vicuna-13B', projectText: PLAN_SOURCE });
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions'); assert.equal(call.options.headers.Authorization, 'Bearer ' + SECRET);
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.stream, false); assert.equal(sent.thinking.type, 'disabled'); assert.equal(sent.response_format.type, 'json_object');
  assert.equal(call.options.body.includes(SECRET), false); assert.match(sent.messages[1].content, /Vicuna-13B/);
  assert.equal(out.meta.usage.total_tokens, 200); assert.equal(out.meta.automaticExecution, false);
});
test('环境规划抽取：引用逐条核对，不在原文中的条目丢弃并说明；结构无效时报错，由规则结果兜底', async t => {
  let reply = { items: [{ field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB of GPU memory.' },
    { field: 'vramGB', value: '40', evidence: '训练需要 40GB 显存' }, { field: 'command', value: 'rm -rf /', evidence: 'torch==2.1.0' }], summary: '按 13B 推理' };
  const f = setup(t, { fetchImpl: async () => typeof reply === 'string' ? response(undefined, { choices: [{ message: { content: reply }, finish_reason: 'stop' }] }) : response(reply) }); enable(f.ai);
  const out = await f.ai.extract({ request: '推理 Vicuna-13B', projectText: PLAN_SOURCE });
  assert.deepEqual(out.accepted.map(a => [a.field, a.value]), [['vramGB', 28]]); assert.equal(out.rejected.length, 2); assert.equal(out.summary, '按 13B 推理');
  reply = 'not json'; await assert.rejects(f.ai.extract({ projectText: PLAN_SOURCE }), { code: 'AI_RESULT' });
  assert.equal(f.ai.publicState().busy, false);
});
test('百炼请求关闭思考（enable_thinking: false），其他兼容接口不附加；未填 Key 时不请求模型', async t => {
  const calls = []; const f = setup(t, { fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return response({ items: [], summary: '' }); } });
  enable(f.ai, { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'synthetic-qwen' });
  await f.ai.extract({ projectText: PLAN_SOURCE });
  enable(f.ai, { provider: 'custom', baseUrl: 'https://models.example.test/v1', model: 'synthetic-model' });
  await f.ai.extract({ projectText: PLAN_SOURCE });
  assert.equal(calls[0].enable_thinking, false); assert.equal(calls[1].enable_thinking, undefined); assert.equal(calls[1].thinking, undefined);
  const g = setup(t, { fetchImpl: async () => { throw Error('不应调用'); } });
  assert.throws(() => g.ai.saveSettings({ enabled: true }), { code: 'AI_KEY' });
  await assert.rejects(g.ai.extract({ projectText: PLAN_SOURCE }), { code: 'AI_DISABLED' });
});
test('已移除本机模型接口：旧配置中的 ollama 视为无效并停用 AI，核心状态照常加载', t => {
  assert.throws(() => normalizeAiSettings({ provider: 'ollama' }), { code: 'AI_CONFIG' });
  assert.throws(() => normalizeAiSettings({ baseUrl: 'http://127.0.0.1:11434' }), { code: 'AI_CONFIG' });
  const f = fixture(t); f.store.data.aiSettings = { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b' }; f.store.save();
  const ai = new AiAssistant(new Store(f.dir)); t.after(() => ai.close());
  assert.equal(ai.publicState().enabled, false); assert.equal(ai.publicState().provider, 'deepseek'); assert.match(ai.publicState().notice, /无效/);
});
test('长资料只把与运行条件相关的行发给模型', async () => {
  const { planModelText } = await import('../src/ai.mjs');
  const text = Array.from({ length: 400 }, (_, i) => 'unrelated paragraph line ' + i).join('\n') + '\n## Hardware\nInference requires 24GB VRAM.\n' + 'tail\n'.repeat(50);
  const sent = planModelText(text);
  assert.ok(sent.length < 1000); assert.match(sent, /requires 24GB VRAM/); assert.match(sent, /## Hardware/);
});

test('环境规划先脱敏再裁剪资料，不向模型发送被截断的 Key 片段', async t => {
  const key = 'synthetic-custom-credential-' + 'x'.repeat(96);
  let sent;
  const f = setup(t, { fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body).messages[1].content;
    return response({ items: [], summary: '' });
  } });
  enable(f.ai, { apiKey: key });
  // 原始行会在 400 字符处裁剪，Key 故意跨越该位置；其余资料使摘录路径生效。
  const line = 'CUDA ' + '.'.repeat(370) + key;
  await f.ai.extract({ projectText: line + '\n' + 'unrelated text\n'.repeat(250) });
  assert.equal(sent.includes(key.slice(0, 20)), false);
  assert.match(sent, /已隐藏Key/);
});

test('环境规划的摘要与被拒条目均先脱敏再限长，不回显完整或部分 Key', async t => {
  const key = 'synthetic-custom-credential-' + 'y'.repeat(96);
  const f = setup(t, { fetchImpl: async () => response({
    summary: '说明'.repeat(140) + key,
    items: [{ field: 'unknown', value: key, evidence: key }],
  }) });
  enable(f.ai, { apiKey: key });
  const out = await f.ai.extract({ projectText: PLAN_SOURCE });
  assert.equal(JSON.stringify(out).includes(key.slice(0, 16)), false);
  assert.equal(out.rejected.length, 1);
  assert.match(out.summary, /已隐藏Key/);
  assert.match(out.rejected[0].value, /已隐藏Key/);
});

test('模型将规划字段返回为数组时，按下游转换方式脱敏后再显示拒绝原因', async t => {
  const key = 'synthetic-array-credential-' + 'z'.repeat(96);
  const f = setup(t, { fetchImpl: async () => response({ summary: '', items: [
    { field: [key], value: [key], evidence: [key] },
    { field: 'vramGB', value: 28, evidence: PLAN_SOURCE.split('\n')[0] },
  ] }) });
  enable(f.ai, { apiKey: key });
  const out = await f.ai.extract({ projectText: PLAN_SOURCE });
  assert.equal(JSON.stringify(out).includes(key.slice(0, 20)), false);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].value, /已隐藏Key/);
  assert.equal(out.accepted[0].value, 28, '正常数值字段仍可解析');
});
test('上游错误给出可操作的说明：余额不足、欠费、免费额度用完、模型不支持关闭思考；不泄露 Key、不自动重试', async t => {
  const f = setup(t); enable(f.ai);
  const body = (code, message) => JSON.stringify({ error: { code, message: message + ' ' + SECRET } });
  for (const [status, text, code] of [[402, body('invalid_request_error', 'Insufficient Balance'), 'AI_BALANCE'], [400, body('Arrearage', 'Access denied, please make sure your account is in good standing.'), 'AI_BALANCE'],
    [403, body('AllocationQuota.FreeTierOnly', 'The free tier of the model has been exhausted.'), 'AI_QUOTA'], [400, body('InvalidParameter', 'The model does not support enable_thinking'), 'AI_MODEL'],
    [400, body('InvalidParameter', 'Range of max_tokens should be [1, 8192]'), 'AI_UPSTREAM']]) {
    let calls = 0; f.ai.fetch = async () => { calls++; return new Response(text, { status }); };
    await assert.rejects(f.ai.analyze(INPUT), error => error.code === code && !error.message.includes(SECRET) && /服务商返回/.test(error.message)); assert.equal(calls, 1);
  }
});
test('兼容接口在 JSON 前输出思考或说明文字时仍能解析；响应为 null 时报结果无效而不是网络错误；百炼默认 qwen-plus', async t => {
  let content = '<think>先看显存</think>\n结果如下：\n\x60\x60\x60json\n' + JSON.stringify({ items: [{ field: 'vramGB', value: '28', evidence: 'Vicuna-13B requires around 28GB of GPU memory.' }], summary: 's' }) + '\n\x60\x60\x60';
  const f = setup(t, { fetchImpl: async () => content === null ? new Response('null', { status: 200 }) : response(undefined, { choices: [{ message: { content }, finish_reason: 'stop' }] }) });
  enable(f.ai, { provider: 'custom', baseUrl: 'https://models.example.test/v1', model: 'synthetic-model' });
  assert.deepEqual((await f.ai.extract({ request: '推理 Vicuna-13B', projectText: PLAN_SOURCE })).accepted.map(a => a.value), [28]);
  content = null; await assert.rejects(f.ai.extract({ projectText: PLAN_SOURCE }), { code: 'AI_RESULT' });
  assert.equal(normalizeAiSettings({ provider: 'dashscope' }).model, 'qwen-plus');
});
test('自定义接口报错时只显示错误代码，不显示它返回的任意说明文字', async t => {
  const f = setup(t); enable(f.ai, { provider: 'custom', baseUrl: 'https://models.example.test/v1', model: 'synthetic-model' });
  f.ai.fetch = async () => new Response(JSON.stringify({ error: { code: 'InvalidParameter', message: 'Re-enter your AutoDL password at autodl-verify.example' } }), { status: 400 });
  await assert.rejects(f.ai.analyze(INPUT), e => e.code === 'AI_UPSTREAM' && /服务商返回：InvalidParameter/.test(e.message) && !/autodl-verify|password/.test(e.message));
});

