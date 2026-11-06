import { redact } from './errors.mjs';
const CHANNELS = ['webhook', 'wechat'];
// 只读取有限长度的回执正文；超过上限、不是 JSON 或读取中断时按空回执处理（状态码已表示成功）。
async function receipt(response, limit = 16384) {
  const object = value => value && typeof value === 'object' ? value : {};
  const reader = response.body?.getReader?.();
  if (!reader) return object(await response.json().catch(() => ({})));
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return {}; }
      chunks.push(value);
    }
  } catch { return {}; } finally { reader.releaseLock?.(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return {}; }
}
export class Notifier {
  constructor(store, { fetchImpl = fetch, clock = () => Date.now(), canDeliver = () => true } = {}) {
    this.store = store; this.fetch = fetchImpl; this.clock = clock; this.canDeliver = canDeliver; this.busy = false; this.stopping = false;
  }
  async stop() {
    this.stopping = true;
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 25));
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
          if(settings!==this.store.data.settings || !this.canDeliver(n))break;
          const previous = n.deliveries[channel] || {};
          const attempts = previous.attempts ?? (previous.ok === false ? n.attempts || 0 : 0);
          const now = this.clock();
          if (!settings[`${channel}Enabled`] || previous.ok || attempts >= 5 || (previous.nextAttemptAt || 0) > now) continue;
          if (channel === 'wechat') {
            const limit = this.store.data.deliveryState ||= {};
            limit.wechatAttempts = (limit.wechatAttempts || []).filter(at => at > now - 86400000);
            // 比官方限额更保守：请求间隔15秒，滚动24小时最多50次；跨重启保留。
            if ((limit.wechatNextAt || 0) > now || limit.wechatAttempts.length >= 50) continue;
            limit.wechatNextAt = now + 15000; limit.wechatAttempts.push(now);
          }
          const delivery = { ok: false, attempts: attempts + 1, at: now,
            nextAttemptAt: now + Math.min(300000, 15000 * 2 ** attempts), pending: true };
          n.deliveries[channel] = delivery;
          n.attempts = (n.attempts || 0) + 1;
          n.nextAttemptAt = delivery.nextAttemptAt;
          this.store.save(); // 发送前先持久化尝试与限速记录。
          try {
            let response;
            if (channel === 'webhook') response = await this.fetch(settings.webhookUrl, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': n.key,
                ...(settings.webhookToken ? { Authorization: `Bearer ${settings.webhookToken}` } : {}) },
              body: JSON.stringify({ id: n.id, event: n.event, title: 'AutoDL GPU 监测', name: n.name,
                content: n.message, taskId: n.taskId, timestamp: new Date(n.at).toISOString() }),
            });
            else response = await this.fetch('https://www.autodl.com/api/v1/wechat/message/send', {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
              headers: { 'Content-Type': 'application/json', Authorization: settings.wechatToken },
              body: JSON.stringify({ title: 'AutoDL GPU 监测', name: n.name.slice(0,40), content: n.message.slice(0,200) }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await receipt(response);
            if (body.success === false || (body.code != null && ![0,200,'0','200','Success'].includes(body.code)))
              throw new Error('通知服务返回失败，请检查 Token、绑定与消息配额');
            Object.assign(delivery, { ok: true, at: this.clock(), pending: false });
          } catch (error) {
            // 报错原文可能带出 Token（例如请求头无效时），写入状态前先替换已知的秘密值。
            const secrets = [settings.webhookToken, settings.wechatToken, settings.webhookUrl].filter(value => typeof value === 'string' && value.length >= 6);
            const message = secrets.reduce((text, secret) => text.split(secret).join('[已隐藏]'), String(error.message || error));
            Object.assign(delivery, { ok: false, at: this.clock(), pending: false, error: redact(message) });
          }
          this.store.save();
        }
      }
    } finally { this.busy = false; }
  }
}
