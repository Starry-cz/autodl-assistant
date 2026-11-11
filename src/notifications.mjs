import { randomUUID } from 'node:crypto';
import { AppError, fail, redact } from './errors.mjs';
const CHANNELS = ['webhook', 'wechat'];
// 通用 Webhook 可只用状态码确认；微信必须有业务成功回执。网络中断不能当成空正文成功。
async function receipt(response, limit = 16384) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const reader = response.body?.getReader?.();
  if (!reader) return object(await response.json().catch(error => { if (error instanceof SyntaxError) return null; throw error; }));
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return null; }
}
export class Notifier {
  constructor(store, { fetchImpl = fetch, clock = () => Date.now(), canDeliver = () => true } = {}) {
    this.store = store; this.fetch = fetchImpl; this.clock = clock; this.canDeliver = canDeliver; this.busy = false; this.stopping = false;
  }
  async stop() {
    this.stopping = true;
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 25));
  }
  // 手动测试与任务提醒共用微信额度；发送前落盘，重启不能绕过限速。
  reserveWechat(now) {
    const limit = this.store.data.deliveryState ||= {};
    limit.wechatAttempts = (limit.wechatAttempts || []).filter(at => at > now - 86400000);
    if (limit.wechatAttempts.length >= 50)
      return Math.max(1, Math.ceil((Math.min(...limit.wechatAttempts) + 86400000 - now) / 1000));
    if ((limit.wechatNextAt || 0) > now) return Math.ceil((limit.wechatNextAt - now) / 1000);
    limit.wechatNextAt = now + 15000; limit.wechatAttempts.push(now);
    return 0;
  }
  failure(error, settings) {
    let message = String(error.message || error), code = error instanceof AppError ? error.code : 'NOTIFICATION_FAILED';
    if (['TimeoutError', 'AbortError'].includes(error.name)) {
      code = 'NOTIFICATION_TIMEOUT'; message = '10 秒内未收到完整回执，发送结果暂不确定。请先查看接收端，再决定是否重试。';
    } else if (error instanceof TypeError && /fetch failed|network/i.test(message)) {
      code = 'NOTIFICATION_NETWORK'; message = '无法连接通知服务，请检查网络与接收地址；如果使用代理，也请检查代理设置。';
    }
    // 服务返回的错误可能包含地址或凭据；前端与日志都只能收到脱敏后的短文本。
    const secrets = [settings.webhookToken, settings.wechatToken, settings.webhookUrl].filter(value => typeof value === 'string' && value);
    message = secrets.reduce((text, secret) => text.split(secret).join('[已隐藏]'), message);
    return { code, message: redact(message).slice(0, 500) };
  }
  async send(channel, n, settings) {
    const common = { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000) };
    const response = channel === 'webhook' ? await this.fetch(settings.webhookUrl, {
      ...common, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': n.key,
        ...(settings.webhookToken ? { Authorization: `Bearer ${settings.webhookToken}` } : {}) },
      body: JSON.stringify({ id: n.id, event: n.event, title: n.title || 'AutoDL GPU 监测', name: n.name,
        content: n.message, taskId: n.taskId, timestamp: new Date(n.at).toISOString() }),
    }) : await this.fetch('https://www.autodl.com/api/v1/wechat/message/send', {
      ...common, headers: { 'Content-Type': 'application/json', Authorization: settings.wechatToken },
      body: JSON.stringify({ title: n.title || 'AutoDL GPU 监测', name: n.name.slice(0,40), content: n.message.slice(0,200) }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const hint = { 401: '凭据无效或已过期，请检查 Token 后重新保存', 403: channel === 'wechat' ? '服务拒绝访问，请检查 Token 权限及微信绑定' : '服务拒绝访问，请检查 Token 和接收服务权限',
        404: '通知接口不存在，请检查接收地址', 429: '通知服务已限流，请稍后重试并检查消息配额' }[response.status]
        || (response.status >= 500 ? '通知服务暂时不可用，请稍后重试' : '请求被拒绝，请检查配置和接收服务');
      throw new AppError('NOTIFICATION_HTTP', `HTTP ${response.status}：${hint}。`);
    }
    const body = await receipt(response);
    const successCode = [0,200,'0','200','Success'].includes(body?.code);
    if (body?.success === false || (body?.code != null && !successCode)) {
      const reason = [body?.message, body?.msg].find(value => typeof value === 'string' && value.trim());
      throw new AppError('NOTIFICATION_REJECTED', reason
        ? `通知服务拒绝：${reason.replace(/\s+/g, ' ')}。请检查 Token、微信绑定或消息配额。`
        : '通知服务返回失败，请检查 Token、微信绑定与消息配额。');
    }
    if (channel === 'wechat' && !successCode && body?.success !== true)
      throw new AppError('NOTIFICATION_RECEIPT', '未收到明确的微信成功回执，发送结果暂不确定；请先检查微信消息。');
  }
  async test(channel, { isCurrent = () => true } = {}) {
    if (!CHANNELS.includes(channel)) fail('CONFIG', '请选择 Webhook 或 AutoDL 微信通知渠道');
    if (this.busy || this.stopping) fail('NOTIFICATION_BUSY', '正在发送通知或停止服务，请稍后再试', { status: 409 });
    const settings = this.store.data.settings || {};
    if (!settings[`${channel}Enabled`]) fail('CONFIG', '请先启用这个通知渠道并保存设置');
    if (channel === 'webhook' && !settings.webhookUrl) fail('CONFIG', '请先填写 Webhook 接收地址并保存设置');
    if (channel === 'wechat' && !settings.wechatToken) fail('CONFIG', '请先填写 AutoDL 开发者 Token 并保存设置');
    const current = () => settings === this.store.data.settings && isCurrent();
    if (!current()) fail('NOTIFICATION_CONTEXT_CHANGED', '账号或通知设置已变化，请重新确认后测试', { status: 409 });
    const previousLimit = structuredClone(this.store.data.deliveryState);
    const now = this.clock(), limit = this.store.data.deliveryState ||= {};
    const wait = channel === 'wechat' ? this.reserveWechat(now) : Math.max(0, Math.ceil(((limit.testWebhookNextAt || 0) - now) / 1000));
    if (wait) fail('NOTIFICATION_RATE_LIMIT', channel === 'wechat'
      ? `发送过于频繁或已达微信每日额度，请等待 ${wait} 秒后再试`
      : `Webhook 测试发送过于频繁，请等待 ${wait} 秒后再试`, { status: 429 });
    if (channel === 'webhook') limit.testWebhookNextAt = now + 10000;
    this.busy = true;
    try {
      // 此时尚未外发；写盘失败不能消耗冷却或微信额度，否则修复存储后仍无法测试。
      try { this.store.save(); }
      catch (error) { this.store.data.deliveryState = previousLimit; throw error; }
      // 测试只发送一次，不创建任务、不进入自动重试队列，超时后由用户核对收信。
      const id = randomUUID(), n = { id, key: 'notification-test:' + id, event: 'test', taskId: null, at: now,
        title: 'AutoDL 助手测试通知', name: '通知渠道测试', message: '这是一条测试通知。收到此消息说明当前通知渠道可以接收提醒；本次测试不会创建或启动实例。' };
      let result;
      try {
        await this.send(channel, n, settings);
        result = { success: true, message: channel === 'wechat' ? 'AutoDL 已确认发送，请到微信查看“AutoDL 助手测试通知”。' : 'Webhook 已确认接收测试请求，请在接收服务中查看消息。' };
      } catch (error) { result = { success: false, ...this.failure(error, settings) }; }
      if (!current()) fail('NOTIFICATION_CONTEXT_CHANGED', '发送期间账号或通知设置已变化，请核对原接收端后再测试当前配置', { status: 409 });
      return { channel, at: this.clock(), ...result };
    } finally { this.busy = false; }
  }
  async flush() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const settings = this.store.data.settings || {};
      for (const n of this.store.data.notifications) {
        if (this.stopping) break;
        // 等待上一条发送回执期间可能切换账号；旧渠道不能用于新账号的消息。
        if(settings!==this.store.data.settings)break;
        // 未连接账号或消息属于另一账号时，不从当前账号的通知渠道发送。
        if (!this.canDeliver(n)) continue;
        if(this.store.tasks().some(t=>t.id===n.taskId && t.config.provider!=='autodl')) continue;
        n.deliveries ||= {};
        for (const channel of CHANNELS) {
          // 退出只等待当前渠道回执落盘，未发送的渠道留给下次启动，避免退出期间又发起请求。
          if(this.stopping || settings!==this.store.data.settings || !this.canDeliver(n))break;
          const previousDelivery = n.deliveries[channel], previous = previousDelivery || {};
          const attempts = previous.attempts ?? (previous.ok === false ? n.attempts || 0 : 0);
          const now = this.clock();
          if (!settings[`${channel}Enabled`] || previous.ok || attempts >= 5 || (previous.nextAttemptAt || 0) > now) continue;
          const previousLimit = structuredClone(this.store.data.deliveryState);
          if (channel === 'wechat' && this.reserveWechat(now)) continue;
          const previousAttempts = n.attempts, previousNextAt = n.nextAttemptAt;
          const delivery = { ok: false, attempts: attempts + 1, at: now,
            nextAttemptAt: now + Math.min(300000, 15000 * 2 ** attempts), pending: true };
          n.deliveries[channel] = delivery;
          n.attempts = (n.attempts || 0) + 1;
          n.nextAttemptAt = delivery.nextAttemptAt;
          // 发送前先持久化。未发出请求时保存失败，需一起还原重试次数与共享限额。
          try { this.store.save(); }
          catch (error) {
            if (previousDelivery) n.deliveries[channel] = previousDelivery;
            else delete n.deliveries[channel];
            n.attempts = previousAttempts; n.nextAttemptAt = previousNextAt;
            this.store.data.deliveryState = previousLimit;
            throw error;
          }
          try {
            await this.send(channel, n, settings);
            Object.assign(delivery, { ok: true, at: this.clock(), pending: false });
          } catch (error) {
            Object.assign(delivery, { ok: false, at: this.clock(), pending: false, error: this.failure(error, settings).message });
          }
          this.store.save();
        }
      }
    } finally { this.busy = false; }
  }
}
