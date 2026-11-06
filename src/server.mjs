import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Notifier } from './notifications.mjs';
import { normalizeConfig, normalizeNotifications, REGIONS } from './config.mjs';
import { normalizeGpuCatalog, catalogModelCount } from './gpu-catalog.mjs';
import { officialPricing } from './matching.mjs';
import { blocksTask, sameTaskResource, canReplaceTask, conflictError } from './task-conflicts.mjs';
import { previewPricing, pricingKey, QUOTE_MAX_AGE } from './pricing.mjs';
import { normalizeImagePrefix } from './images.mjs';
import { Wallet, minimumBudget, availableMilli } from './wallet.mjs';
import { Observatory } from './observatory.mjs';
import { Market } from './market.mjs';
import { marketHostQuery } from './adapters/autodl-market.mjs';
import { assertTaskOwner, filterAccountTasks, filterAccountNotifications, claimLegacyTasks } from './account-scope.mjs';
import { validateCloneSource, validateBootSource, publicInstance } from './instances.mjs';
import { AppError, redact, messageOf, fail } from './errors.mjs';
import { assertLocalRequest } from './local-access.mjs';
import { AutoDLBrowserAdapter } from './adapters/autodl.mjs';
import { AiAssistant, AI_PROVIDERS } from './ai.mjs';
import { ReleaseUpdates } from './updates.mjs';
import { normalizePlanInput, extractConstraints, mergeConstraints, buildPlan, normalizeImageHint, pickImageOption } from './env-plan.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 发布版本统一来自包信息，避免健康检查与下载版本不一致。
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// 启动时发现运行锁被占用：查询已在运行的后台属于哪种情况。令牌只用于本机停止请求，不返回、不打印。
export async function inspectRunningBackend(port, { fetchImpl = fetch } = {}) {
  const base = 'http://127.0.0.1:' + port;
  try {
    const html = await (await fetchImpl(base + '/', { signal: AbortSignal.timeout(3000) })).text();
    const token = html.match(/name="local-token" content="([0-9a-f]+)"/)?.[1];
    if (!token) return { kind: 'unreachable' };
    const state = await (await fetchImpl(base + '/api/state', { headers: { 'X-Local-Token': token }, signal: AbortSignal.timeout(3000) })).json();
    const active = (state.tasks || []).filter(t => ['queued','watching','preparing','submitting','verifying','reconciling'].includes(t.state)).length;
    if (!state.server) return { kind: 'legacy', active };
    const stop = () => fetchImpl(base + '/api/server/stop', { method: 'POST', headers: { 'X-Local-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(15000) });
    return { kind: state.server.codeChanged ? 'outdated' : 'current', active, canStop: state.server.canStop === true, stop };
  } catch { return { kind: 'unreachable' }; }
}
export function describeRunningBackend(info, { pid, port }) {
  const head = '本项目的后台（PID ' + pid + '）已在运行，端口 ' + port + '。为避免两个程序同时抢卡，这次没有再启动一份。\n关闭网页不会停止后台，再次双击启动也不会替换它。';
  const busy = info.active ? '当前有 ' + info.active + ' 个任务正在监测、提交或等待核对。' : '';
  if (info.kind === 'current') return head + '\n它运行的就是当前代码，直接在浏览器打开 http://127.0.0.1:' + port + ' 即可。要停止它，运行 npm.cmd run stop。';
  if (info.kind === 'outdated') return head + '\n它仍在运行启动时的代码，磁盘上的程序已更新。' + busy + '正常重启时，后台会等当前页面操作结束、保存状态并关闭专用浏览器，云端实例不受影响。';
  if (info.kind === 'legacy') return head + '\n它是不支持正常停止的旧版本，新功能和1秒检查间隔都没有生效。' + busy
    + '\n请先在网页中暂停任务，确认没有“提交中/验证实例与数据/等待绑定核对”的任务；再在任务管理器“详细信息”中结束 PID ' + pid + ' 的 node.exe，关闭专用浏览器窗口，然后重新双击“启动抢卡助手.cmd”。';
  return head + '\n但端口没有正常响应，后台可能正在启动或停止。请稍等几秒再试；若一直如此，在任务管理器中核对 PID ' + pid + ' 是否为本项目的 node.exe。';
}
// 运行锁是否已释放：文件不在、已换成别的进程，或记录的进程已不存在（异常退出留下的锁，启动时按同样规则接管）。
export function lockReleased(lockPath, pid) {
  let owner;
  try { owner = Number(fs.readFileSync(lockPath, 'utf8')); } catch { return true; }
  if (owner !== pid) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
// 正常停止后台并等待它释放运行锁。没收到回复不等于后台没收到请求（它可能已经开始停止），
// 所以先核对运行锁和端口；后台仍在正常运行时再发一次（停止请求可重复发送）。不强制结束进程，不删除运行锁。
export async function stopRunningBackend(info, { pid, port, lockPath, name = '旧后台', waitSeconds = 180, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), released = () => lockReleased(lockPath, pid),
  log = console.log, warn = console.error } = {}) {
  const alive = async () => { try { return (await fetchImpl('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
  const send = async () => {
    try {
      const response = await info.stop();
      if (response.ok) return { ok: true };
      const data = await response.json().catch(() => ({}));
      return { refused: 'HTTP ' + response.status + (data.message ? '，' + redact(String(data.message)) : '') };
    } catch (error) {
      return { lost: error?.name === 'TimeoutError' ? '15秒内没有回复' : '连接中断（' + (error?.cause?.code || error?.code || error?.name || '未知原因') + '）' };
    }
  };
  let result = await send();
  if (!result.refused) log(result.ok ? '已请求' + name + '正常停止，正在等待当前页面操作结束……'
    : '停止请求没有收到回复：' + result.lost + '。' + name + '可能已经开始停止，正在核对运行锁和端口……');
  for (let i = 1; i <= waitSeconds && !result.refused; i++) {
    await sleep(1000);
    if (await released()) return true;
    if (result.ok || (i !== 5 && i !== 30) || !await alive()) continue;
    result = await send();
    if (!result.refused) log(result.ok ? name + '仍在正常运行，已重新发送停止请求并收到确认，继续等待……'
      : name + '仍在正常运行，重新发送的停止请求也没有收到回复（' + result.lost + '），继续等待……');
  }
  if (result.refused) warn(name + '拒绝停止（' + result.refused + '），未做任何处理');
  else warn('等待' + (waitSeconds >= 60 ? Math.round(waitSeconds / 60) + '分钟' : waitSeconds + '秒') + '后' + name + '仍未退出，未强制结束；请查看其窗口或任务管理器' + (pid ? '中的 PID ' + pid : ''));
  return false;
}
// 直接比较文件元信息，用于提示重启后台；不计算文件哈希。
export function codeFingerprint(root = ROOT) {
  const files = [];
  for (const dir of ['src', 'src/adapters', 'public']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const name of names) {
      if (!/\.(?:mjs|js|html|css)$/.test(name)) continue;
      try { const info = fs.statSync(path.join(root, dir, name)); files.push(dir + '/' + name + ':' + info.size + ':' + Math.round(info.mtimeMs)); } catch {}
    }
  }
  return files.sort().join('\n');
}
export function createApplication({ runtimeDir = process.env.AUTODL_RUNTIME_DIR || path.join(ROOT,'.runtime'),
  adapters: suppliedAdapters, startEngine = true, lock = true, aiOptions = {}, walletOptions = {}, secretProtector,
  onStop = null, fingerprint = codeFingerprint, imageBusyWaitMs = 20000, updatesOptions = {} } = {}) {
  // 相对运行目录统一从项目根目录解析，不依赖启动终端所在位置。
  runtimeDir = path.resolve(ROOT, runtimeDir);
  fs.mkdirSync(runtimeDir, {recursive:true,mode:0o700});
  const lockPath = path.join(runtimeDir,'server.lock');
  if (lock) {
    try {
      const fd = fs.openSync(lockPath,'wx',0o600); fs.writeFileSync(fd,String(process.pid)); fs.closeSync(fd);
    } catch(e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lockPath,'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) fail('LOCK','运行锁内容异常，请核对没有其他服务后删除 .runtime/server.lock');
      try { process.kill(pid,0); fail('LOCK','已有服务正在使用此状态目录，请勿启动第二个抢卡进程'); }
      catch(error) { if(error.code !== 'ESRCH') throw error; }
      // 接管失效的运行锁：删除前确认锁文件仍是那个已退出的进程；写入后稍等再读一次，若被同时启动的另一进程接管就退出。
      // 避免两次几乎同时启动时，一个进程删掉另一个刚写入的锁，两个后台共用同一状态。
      if (fs.readFileSync(lockPath,'utf8') !== String(pid)) fail('LOCK','运行锁刚被另一个进程接管，请勿同时启动两个服务');
      fs.unlinkSync(lockPath);
      const fd = fs.openSync(lockPath,'wx',0o600); fs.writeFileSync(fd,String(process.pid)); fs.closeSync(fd);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      if (fs.readFileSync(lockPath,'utf8') !== String(process.pid)) fail('LOCK','运行锁被同时启动的另一个进程接管，本进程退出；请勿同时启动两个服务');
    }
  }
  const releaseLock = () => {
    if (lock) { try { if (fs.readFileSync(lockPath,'utf8') === String(process.pid)) fs.unlinkSync(lockPath); } catch {} }
  };
  let store;
  try { store = new Store(runtimeDir,{secretProtector}); } catch (error) { releaseLock(); throw error; }
  const adapters = suppliedAdapters || {autodl:new AutoDLBrowserAdapter(runtimeDir)};
  const wallet = new Wallet({...walletOptions,store});
  const observatory = new Observatory({adapter:adapters.autodl});
  const market = new Market();
  // 真实适配器提供账号身份；注入的离线测试适配器可独立测试原流程。
  const accountEnabled = typeof adapters.autodl.readIdentity === 'function';
  let identity = null, accountError = null;
  const notifier = new Notifier(store,{canDeliver:n=>!accountEnabled || !!visibleIdentity() && store.tasks().some(t=>t.id===n.taskId&&t.ownerId===identity.ownerId)});
  const engine = new Engine(store,adapters,notifier,{wallet,verifyOwner:accountEnabled?verifyTaskOwner:null});
  if(accountEnabled)adapters.autodl.verifyTaskOwner=verifyTaskOwner;
  let pricePreview = null;
  let instanceSync = { instances: [], checkedAt: null, error: null };
  function visibleIdentity(){const session=adapters.autodl.sessionStatus?.();return session?.state==='ready'&&session.browserOpen?identity:null;}
  function visibleCatalog(){return !accountEnabled||visibleIdentity()&&store.data.gpuCatalogOwnerId===identity.ownerId?store.data.gpuCatalog:null;}
  function clearAccountCache(){instanceSync={instances:[],checkedAt:null,error:null};pricePreview=null;observatory.clear();market.clear();}
  function pauseAccountTasks(){for(const task of store.tasks())if(['queued','watching','preparing','submitting','verifying'].includes(task.state))engine.control(task,'pause');}
  async function connectIdentity({allowSwitch=false}={}) {
    if(!accountEnabled)return null;
    let next;
    try {next=await adapters.autodl.readIdentity();}
    catch(error){identity=null;accountError=redact(messageOf(error));clearAccountCache();throw error;}
    if(!allowSwitch && identity && next.ownerId!==identity.ownerId){
      pauseAccountTasks();identity=null;clearAccountCache();accountError='专用浏览器中的账号已变化，请重新连接当前账号';
      fail('LOGIN_CHECK_REQUIRED',accountError,{status:409});
    }
    const previousOwner=store.data.accountOwnerId;
    if(previousOwner!==next.ownerId){
      clearAccountCache();
      if(previousOwner){
        pauseAccountTasks();wallet.clearToken();
        // 自动通知及余额凭据不会沿用到另一个账号；本机 AI 配置独立保留。
        store.data.settings={...store.data.settings,webhookEnabled:false,wechatEnabled:false,wechatToken:''};
      }
      store.data.accountOwnerId=next.ownerId;store.save();
    }
    identity=next;accountError=null;return next;
  }
  async function verifyTaskOwner(task){
    requireSession();await connectIdentity();assertTaskOwner(task,identity);
  }
  function scopedStoreState(){
    const state=store.publicState();if(!accountEnabled)return state;
    const account=visibleIdentity();
    return {...state,tasks:filterAccountTasks(state.tasks,account),notifications:filterAccountNotifications(state.notifications,store.tasks(),account)};
  }
  function claimExisting(overview){
    if(!accountEnabled||!identity||!overview?.pagination?.complete)return;
    const result=claimLegacyTasks(store.tasks(),identity,overview.instances,{complete:true});
    if(result.claimed.length){
      for(const claimed of result.tasks){const original=store.tasks().find(t=>t.id===claimed.id);if(original!==claimed)Object.assign(original,claimed);}
      store.save();
    }
  }
  function requireSession() {
    const session = adapters.autodl.sessionStatus?.();
    if (session?.state !== 'ready' || !session.browserOpen)
      fail('LOGIN_CHECK_REQUIRED', '请点击账号头像，打开专用浏览器并连接 AutoDL 后再操作', { status: 409 });
    if(accountEnabled&&!identity)fail('LOGIN_CHECK_REQUIRED',accountError||'请在账号页检查连接，确认当前账号后再操作',{status:409});
  }
  async function browserWork(work, { waitMs = 0, verifyIdentity = true, verifyAfter = true } = {}) {
    // waitMs：允许等待引擎完成当前一轮检查（镜像菜单在单独标签页读取，可与监测任务交替进行）。
    for (const deadline = Date.now() + waitMs; engine.busy && !engine.stopping && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    if(engine.busy || engine.stopping) fail('BUSY','正在执行页面操作，请稍后重试；如持续忙碌，请先暂停真实任务',{status:409});
    engine.busy=true;
    try {
      if(verifyIdentity&&accountEnabled&&identity)await connectIdentity();
      const result=await work();
      if(verifyAfter&&verifyIdentity&&accountEnabled&&identity)await connectIdentity();
      return result;
    } finally { engine.busy=false; }
  }
  const reading = new Map();
  function browserRead(name, query, work, { waitMs = 0, afterRead, onError } = {}) {
    requireSession();
    const ownerId = identity?.ownerId ?? null, key = JSON.stringify([ownerId, name, query]);
    if (reading.has(key)) return reading.get(key);
    // 只合并同账号、同参数的进行中读取；完成或失败立即移除，下一次刷新仍读取实时数据。
    const pending = (async () => {
      try {
        const result = await browserWork(() => {
          requireSession();
          // 等待页面锁期间可能完成账号切换，旧账号排队的请求不能转而读取新账号。
          if (accountEnabled && identity.ownerId !== ownerId)
            fail('LOGIN_CHECK_REQUIRED', '等待期间账号已变化，请重新同步当前账号', { status: 409 });
          return work();
        }, { waitMs });
        // 身份后验通过后再写本地目录和采样；多个调用者共享同一次副作用。
        afterRead?.(result);
        return result;
      } catch (error) {
        if (!accountEnabled || identity?.ownerId === ownerId) onError?.(error);
        throw error;
      }
    })().finally(() => reading.delete(key));
    reading.set(key, pending);
    return pending;
  }
  function checkTaskSlot(config, replaceTaskId = null) {
    const replaces = replaceTaskId ? store.get(replaceTaskId) : null;
    if(accountEnabled&&replaces)assertTaskOwner(replaces,identity);
    if (replaces && (!sameTaskResource(replaces, config) || !canReplaceTask(replaces))) {
      if (blocksTask(replaces, config)) throw conflictError(replaces);
      fail('TASK_CHANGED', '旧任务状态已变化或与当前资源不匹配，请重新检查后再重建', { status: 409 });
    }
    const duplicate = store.tasks().find(t => t !== replaces && (!accountEnabled||t.ownerId===identity?.ownerId) && blocksTask(t, config));
    if (duplicate) throw conflictError(duplicate);
    return replaces;
  }
  async function readInstances(expectedModel = '') {
    requireSession();
    try {
      if (typeof adapters.autodl.instances !== 'function') fail('INSTANCES','当前适配器不支持实例同步');
      const rows = await adapters.autodl.instances(expectedModel);
      instanceSync = { instances: rows.map(publicInstance), checkedAt: Date.now(), error: null };
      return rows;
    } catch (error) {
      instanceSync = { ...instanceSync, error: redact(messageOf(error)) };
      throw error;
    }
  }
  const ai = new AiAssistant(store, aiOptions);
  // 检查器不主动联网；启动页请求与手动检查共用缓存，当前版本始终来自本项目包信息。
  const updates = new ReleaseUpdates({ ...updatesOptions, currentVersion: APP_VERSION });
  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now(), startCode = fingerprint();
  let codeCheck = { at: 0, changed: false };
  function serverState() {
    // 每5秒最多重新计算一次，避免网页轮询频繁读取文件信息。
    if (Date.now() - codeCheck.at > 5000) codeCheck = { at: Date.now(), changed: fingerprint() !== startCode };
    return { startedAt, codeChanged: codeCheck.changed, canStop: typeof onStop === 'function' };
  }
  function json(res,status,body) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
  async function body(req) {
    let size=0, chunks=[];
    for await (const part of req) { size+=part.length; if(size>98304) fail('SIZE','请求过大',{status:413}); chunks.push(part); }
    let data;
    try { data=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('JSON','请求不是有效 JSON'); }
    if(!data || typeof data!=='object' || Array.isArray(data)) fail('JSON','请求正文必须是 JSON 对象');
    return data;
  }
  const server = http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    // 别的网站打开控制台后不能保留对这个标签页的引用（例如之后把它跳转到仿冒页面）。
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = assertLocalRequest(req);
      const url = new URL(req.url,`http://${host}`);
      // 启停入口用安装目录确认后台归属，避免同版本的不同副本误开、误停。
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res,200,{ok:true,app:'autodl-assistant',version:APP_VERSION,pid:process.pid,projectRoot:ROOT,runtimeDir,codeChanged:serverState().codeChanged});
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['x-local-token'] !== token) fail('TOKEN','本地访问令牌无效，请重新加载页面',{status:403});
        if(req.method === 'GET' && url.pathname === '/api/state') return json(res,200,{...scopedStoreState(),
          account:{enabled:accountEnabled,identity:visibleIdentity(),error:accountError,
            unclaimedCount:visibleIdentity()?store.tasks().filter(t=>t.config.provider==='autodl'&&!t.ownerId).length:0},
          browser:{status:adapters.autodl.lastStatus || '会话不可用',busy:engine.busy,
            session:adapters.autodl.sessionStatus?.() || {state:'unavailable',label:'会话不可用',message:'请打开专用浏览器并核验登录',checkedAt:null,browserOpen:false}},
          autodlInstances: adapters.autodl.sessionStatus?.()?.state === 'ready' && (!accountEnabled||visibleIdentity()) ? instanceSync : {instances:[],checkedAt:null,error:null},
          observatory:adapters.autodl.sessionStatus?.()?.state === 'ready' && (!accountEnabled||visibleIdentity()) ? observatory.publicState() : null,
          market:adapters.autodl.sessionStatus?.()?.state === 'ready' && (!accountEnabled||visibleIdentity()) ? market.publicState(visibleCatalog()) : null,
          wallet:accountEnabled&&!visibleIdentity()?{configured:false,snapshot:null}:wallet.publicState(),credentialStorage:store.secretStorage.publicState(),regions:REGIONS,
          gpuCatalog:normalizeGpuCatalog(visibleCatalog()),ai:ai.publicState(),aiProviders:AI_PROVIDERS,updates:updates.publicState(),server:serverState(),now:Date.now()});
        const taskLogs = url.pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
        if(req.method === 'GET' && taskLogs) {
          requireSession();
          const task = store.get(decodeURIComponent(taskLogs[1]));
          if(accountEnabled)assertTaskOwner(task,visibleIdentity());
          if(task.config.provider !== 'autodl')fail('PROVIDER_REMOVED','旧版演练任务已停用',{status:410});
          // 导出当前账号本机保留的日志，不用界面轮询中截断为 80 条的列表，也不附带凭据或页面原文。
          return json(res,200,{task:{id:task.id,name:task.config.name,mode:task.config.mode,state:task.state,createdAt:task.createdAt,updatedAt:task.updatedAt},
            logs:task.logs.slice(-200).map(log=>({at:log.at,level:log.level,message:redact(log.message)})),limit:200});
        }
        if(req.method !== 'POST') fail('METHOD','不支持的请求方法',{status:405});
        if(!(req.headers['content-type'] || '').startsWith('application/json')) fail('CONTENT_TYPE','控制请求需使用 JSON',{status:415});
        const data = await body(req);
        if(url.pathname === '/api/updates/check') {
          if(data.force !== undefined && typeof data.force !== 'boolean') fail('UPDATES','是否立即检查更新必须为布尔值');
          return json(res,200,{updates:await updates.check({force:data.force===true})});
        }
        // 看板只读同步与抢卡共用页面操作锁；账户信息只在当前本地服务内缓存。
        if(url.pathname === '/api/observatory/overview') {
          if(data.targetId !== undefined && (typeof data.targetId !== 'string' || data.targetId.length > 100))fail('TARGET','监控实例 ID 无效');
          const query={targetId:data.targetId||''};
          const overview=await browserRead('overview',query,()=>observatory.refreshOverview(query),{afterRead:claimExisting});
          return json(res,200,{overview});
        }
        if(url.pathname === '/api/observatory/billing') {
          const query={days:35};
          const billing=await browserRead('billing',query,()=>observatory.refreshBilling(query));
          return json(res,200,{billing});
        }
        // 正常停止本地后台：等待当前页面操作结束、保存状态、关闭专用浏览器。不关闭云端实例。
        if(url.pathname === '/api/server/stop') {
          if(data.confirm !== true) fail('CONFIRM','请明确确认停止本地后台',{status:400});
          if(typeof onStop !== 'function') fail('UNSUPPORTED','当前运行方式不支持从页面停止后台',{status:409});
          // 回复发完、连接关闭后再停止：停止时会断开空闲连接，过早停止可能让调用方收不到这条回复。
          res.once('close',()=>setImmediate(onStop));res.setHeader('Connection','close');
          json(res,202,{ok:true,message:'后台正在停止：等待当前页面操作结束后关闭专用浏览器；云端实例不受影响'});
          return;
        }
        if(url.pathname === '/api/ai/settings') return json(res,200,{ok:true,ai:ai.saveSettings(data)});
        if(url.pathname === '/api/ai/clear-key') return json(res,200,{ok:true,ai:ai.clearKey()});
        if(url.pathname === '/api/ai/cancel') { ai.cancel(); return json(res,200,{ok:true}); }
        if(url.pathname === '/api/ai/analyze') return json(res,200,await ai.analyze(data));
        // 环境与选卡规划：规则部分在本机完成、不调用模型；勾选模型时由模型补充，模型失败仍返回规则结果。不创建或修改任务。
        if(url.pathname === '/api/plan') {
          const input = normalizePlanInput(data), text = input.request + '\n' + input.projectText;
          const rules = extractConstraints(text, { request: input.request });
          let model = null, constraints = rules;
          if (input.useModel) {
            try {
              const out = await ai.extract(input);
              constraints = mergeConstraints(rules, out.accepted);
              model = { accepted: out.accepted.length, rejected: out.rejected, summary: out.summary, meta: out.meta };
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              model = { error: redact(messageOf(error)), code: error.code };
            }
          }
          return json(res,200,{ ...buildPlan(constraints, normalizeGpuCatalog(visibleCatalog()), { gpuCount: input.gpuCount }), model,
            advisoryOnly: true, automaticExecution: false });
        }
        // 按规划结果在 AutoDL 官方镜像菜单中逐级选择（只读菜单），返回每级选项供页面填入；不提交任何任务。
        if(url.pathname === '/api/plan/image') {
          const hint = normalizeImageHint(data.hint);
          return json(res,200,await browserWork(async()=>{
            requireSession();
            if(typeof adapters.autodl.imageOptions !== 'function')fail('IMAGES','当前适配器不支持官方基础镜像同步，请更新后台');
            const path = [], levels = [];
            for (let level = 0; level < 4; level++) {
              const menu = await adapters.autodl.imageOptions(path), pick = pickImageOption(level, menu.options, hint);
              levels.push({ level, options: menu.options, label: pick.label, reason: pick.reason });
              if (!pick.label) break;
              path.push(pick.label);
            }
            return { path, complete: path.length === 4, levels, checkedAt: Date.now() };
          },{waitMs:imageBusyWaitMs}));
        }
        if(url.pathname === '/api/wallet/token') {
          if(accountEnabled)requireSession();
          wallet.setToken(data.token,{rememberToken:data.rememberToken ?? false}); await wallet.refresh({force:true});
          return json(res,200,{ok:true,wallet:wallet.publicState()});
        }
        if(url.pathname === '/api/wallet/clear-token') { if(accountEnabled)requireSession();wallet.clearToken(); return json(res,200,{ok:true,wallet:wallet.publicState()}); }
        if(url.pathname === '/api/wallet/refresh') { if(accountEnabled)requireSession();await wallet.refresh({force:true}); return json(res,200,{wallet:wallet.publicState()}); }
        if(url.pathname === '/api/wallet/preflight') {
          if(accountEnabled)requireSession();
          const config=normalizeConfig({...data,action:'observe',paidConsent:false});
          if(officialPricing(config) && (!pricePreview?.quote || pricePreview.configKey!==pricingKey(config) || Date.now()-pricePreview.checkedAt>QUOTE_MAX_AGE))
            fail('PRICE_REQUIRED','请先读取当前配置的官方报价，再预检余额；过期或无库存时不会用固定价格估算',{status:409});
          return json(res,200,{check:await wallet.check(config,officialPricing(config)?pricePreview.quote:null,{force:true}),wallet:wallet.publicState()});
        }
        if(url.pathname === '/api/autodl/images') {
          const prefix = normalizeImagePrefix(data.prefix);
          return json(res,200,await browserRead('images',prefix,async()=>{
            if(typeof adapters.autodl.imageOptions !== 'function')fail('IMAGES','当前适配器不支持官方基础镜像同步，请更新后台');
            return adapters.autodl.imageOptions(prefix);
          },{waitMs:imageBusyWaitMs}));
        }
        // 从 AutoDL 只读接口按地区同步官方 GPU 型号；保存本次快照，后续刷新重新读取。
        if(url.pathname === '/api/autodl/gpus') {
          const catalog = await browserRead('gpus',REGIONS,async()=>{
            if(typeof adapters.autodl.gpuCatalog !== 'function')fail('GPU_CATALOG','当前后台不支持同步 AutoDL 型号，请重启后台加载新版代码');
            return normalizeGpuCatalog(await adapters.autodl.gpuCatalog(REGIONS));
          },{waitMs:imageBusyWaitMs,afterRead:catalog=>{
            // 一个型号都没读到时不覆盖上次保存的目录。
            if(!catalogModelCount(catalog)) fail('GPU_CATALOG','没有从 AutoDL 创建页读到任何 GPU 型号：'+((catalog?.regions||[]).map(row=>row.region+(row.error?'（'+row.error+'）':row.missing?'（页面没有此地区）':row.disabled?'（地区不可选）':'（无型号）')).join('、')||'页面没有可读取的地区')+'。上次同步的型号已保留，请检查专用浏览器页面后重试',{status:502});
            store.data.gpuCatalog = catalog;if(identity)store.data.gpuCatalogOwnerId=identity.ownerId;store.save();market.record(catalog);
          },onError:error=>{if(error.code!=='BUSY')market.recordGap(redact(messageOf(error)));}});
          return json(res,200,catalog);
        }
        // 主机明细至少限定一个型号或地区，不缓存跨账号数据，也不创建监测任务。
        if(url.pathname === '/api/market/hosts') {
          const query = marketHostQuery(data);
          return json(res,200,await browserRead('hosts',query,async()=>{
            if(typeof adapters.autodl.marketHosts !== 'function')fail('MARKET_HOSTS','当前后台不支持主机明细，请更新并重启后台');
            return adapters.autodl.marketHosts(query);
          }));
        }
        if(url.pathname === '/api/pricing/preview') {
          const config=normalizeConfig({...data,action:'observe',paidConsent:false});
          const work=async()=>{pricePreview=null;requireSession();pricePreview=await previewPricing(adapters.autodl,config);return pricePreview;};
          return json(res,200,await browserWork(work));
        }
        if(url.pathname === '/api/browser/logout') {
          if(data.clearCredentials!==undefined && typeof data.clearCredentials!=='boolean')fail('CONFIG','清除凭据选项必须为布尔值');
          const result=await browserWork(async()=>{
            if(typeof adapters.autodl.logout!=='function')fail('BROWSER','当前适配器不支持清除专用浏览器登录');
            let paused=0;
            for(const task of store.tasks())if(task.config.provider==='autodl' && ['queued','watching','preparing','submitting','verifying'].includes(task.state)) {engine.control(task,'pause');paused++;}
            clearAccountCache();identity=null;accountError=null;
            const result=await adapters.autodl.logout();
            if(data.clearCredentials===true) {
              ai.clearKey();wallet.clearToken();
              store.data.settings={webhookEnabled:false,wechatEnabled:false,rememberCredentials:false};store.save();
            }
            return {...result,paused,credentialsCleared:data.clearCredentials===true};
          },{verifyIdentity:false}); // 登录已过期时仍必须允许正常退出和清除专用会话。
          return json(res,200,result);
        }
        if(url.pathname === '/api/autodl/instances') {
          await browserWork(()=>readInstances());
          return json(res,200,instanceSync);
        }
        if(url.pathname === '/api/tasks') {
          const config = normalizeConfig(data), replaceTaskId = data.replaceTaskId ?? null;
          if (replaceTaskId !== null && (typeof replaceTaskId !== 'string' || !/^[\w-]{1,80}$/.test(replaceTaskId)))
            fail('CONFIG', '替换任务 ID 无效');
          const create = async () => {
            requireSession();
            if(store.tasks().length>=500) fail('LIMIT','任务数量已达500，请备份状态并更换运行目录');
            checkTaskSlot(config, replaceTaskId);
            if (config.provider === 'autodl' && ['clone', 'boot'].includes(config.mode)) {
              const rows=await readInstances(config.gpuModel);
              const source = rows.find(i=>i.id===config.sourceId);
              // 已有实例按原配置开机，创建任务前重新读取账号实例，避免使用过期选择。
              if (config.mode === 'boot') validateBootSource(config, source);
              else validateCloneSource(config, source);
            }
            let balanceCheck = null;
            if (config.provider === 'autodl' && config.action === 'execute' && config.balanceGuard) {
              if(officialPricing(config)) {
                const fresh=pricePreview && pricePreview.configKey===pricingKey(config) && Date.now()-pricePreview.checkedAt<=QUOTE_MAX_AGE ? pricePreview : null;
                if(fresh?.quote)balanceCheck=await wallet.check(config,fresh.quote,{force:true});
                else {
                  const snapshot=await wallet.refresh({force:true});balanceCheck={pendingQuote:true,checkedAt:Date.now()};
                  // 暂无完整报价时，按刚读到的页面单卡价估算下限：余额确定不够就先请用户充值，不开始监测。
                  const prices=(fresh?.listed||[]).map(host=>host.price).filter(price=>Number.isFinite(price)&&price>0);
                  const need=prices.length?minimumBudget(config,Math.min(...prices)):null;
                  if(need&&availableMilli(snapshot,config)<need.requiredMilli)
                    fail('BALANCE_INSUFFICIENT','可用余额 ¥'+(availableMilli(snapshot,config)/1000).toFixed(2)+'，不足页面单卡价 ¥'+Math.min(...prices)+'/时 × '+config.gpuCount+' 卡 × '+need.hours+' 小时'+(config.balanceReserve?' + 保留余额':'')+' ≈ ¥'+need.required.toFixed(2)+'。找到空闲 GPU 也无法提交，请先充值后再开始监测',{status:409});
                }
              }
              else balanceCheck = await wallet.check(config,null,{force:true});
            }
            // 查询结束后先复核账号，再原子落盘；写入成功后不因额外身份请求失败而误报创建失败。
            if(accountEnabled)await connectIdentity();
            // 源实例/余额查询期间可能有暂停或恢复请求；落盘前再次校验旧任务状态。
            const replaces = checkTaskSlot(config, replaceTaskId);
            return store.create(config, { balanceCheck, replaces,ownerId:identity?.ownerId });
          };
          const task=await browserWork(create,{verifyAfter:false});
          return json(res,201,{task});
        }
        if(url.pathname === '/api/notifications/settings') {
          const previous=store.data.settings;store.data.settings=normalizeNotifications(data,previous);
          try {store.save();} catch(error) {store.data.settings=previous;throw error;}
          return json(res,200,{ok:true,message:'已保存。外部渠道仅在任务发现资源、完成、失败或需处理时发送通知'});
        }
        if(url.pathname === '/api/notifications/read') {
          const visible=accountEnabled?filterAccountNotifications(store.data.notifications,store.tasks(),visibleIdentity()):store.data.notifications;
          visible.forEach(n=>n.read=true);store.save();return json(res,200,{ok:true});
        }
        if(['/api/browser/open','/api/browser/check'].includes(url.pathname)) {
          if(engine.busy || engine.stopping) fail('BUSY','正在执行页面操作，请稍后重试；如持续忙碌，请先暂停真实任务，不会打断正在进行的提交',{status:409});
          engine.busy=true;
          try {
            const method = url.pathname.endsWith('/check') ? 'checkLogin' : 'login';
            if (typeof adapters.autodl[method] !== 'function') fail('BROWSER','当前适配器未连接真实浏览器');
            const result=await adapters.autodl[method]();
            if(result.session?.state==='ready')await connectIdentity({allowSwitch:true});
            else {identity=null;clearAccountCache();}
            return json(res,200,{...result,account:identity});
          } finally {engine.busy=false;}
        }
        const matched = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(pause|resume|cancel|attach|verify-data|recheck)$/);
        if(matched) {
          const task=store.get(matched[1]);
          if(accountEnabled){assertTaskOwner(task,visibleIdentity());if(!['pause','cancel'].includes(matched[2]))await verifyTaskOwner(task);}
          if(matched[2] === 'attach') await engine.attach(task,data.instanceId);
          else if(matched[2] === 'recheck') {
            if(data.confirmed !== true) fail('CONFIRM','请确认已了解：仅在完整实例列表没有新增实例时才清除提交记录',{status:400});
            requireSession();
            return json(res,200,{task,result:await engine.recheck(task)});
          }
          else {
            if (matched[2] === 'resume' && !task.operation) {
              const duplicate = store.tasks().find(t => t !== task && t.ownerId===task.ownerId && blocksTask(t, task.config));
              if (duplicate) throw conflictError(duplicate);
            }
            engine.control(task,matched[2],data);
          }
          return json(res,200,{task});
        }
        fail('NOT_FOUND','接口不存在',{status:404});
      }
      if(req.method!=='GET') fail('METHOD','不支持的请求方法',{status:405});
      const assets = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/task-monitor.js':'task-monitor.js','/account.js':'account.js','/updates.js':'updates.js','/images.js':'images.js','/ai.js':'ai.js','/plan.js':'plan.js','/observatory.js':'observatory.js','/market.js':'market.js','/profile.js':'profile.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      const asset=assets[url.pathname];
      if(!asset) fail('NOT_FOUND','页面不存在',{status:404});
      const contentType=asset.endsWith('.css')?'text/css':asset.endsWith('.js')?'text/javascript':asset.endsWith('.svg')?'image/svg+xml':'text/html';
      let content=fs.readFileSync(path.join(ROOT,'public',asset),'utf8');
      if(asset==='index.html') content=content.replace('__LOCAL_TOKEN__',token);
      res.writeHead(200,{'Content-Type':`${contentType}; charset=utf-8`,'Cache-Control':'no-store'});res.end(content);
    } catch(error) {
      const conflict = error.code === 'DUPLICATE' && error.conflict ? {
        ...error.conflict, name: redact(error.conflict.name), lastError: error.conflict.lastError ? redact(error.conflict.lastError) : null,
      } : null;
      json(res,error.status || 500,{error:error.code || 'INTERNAL',message:redact(messageOf(error)),...(conflict ? { conflict } : {})});
    }
  });
  if(startEngine) engine.start();
  let closing;
  return {server,store,engine,adapters,ai,wallet,observatory,market,updates,token,close(){
    if (!closing) closing = (async () => {
      ai.close(); wallet.close(); updates.close();
      const closed = new Promise(resolve => server.close(resolve));
      try {
        await engine.stop(); await notifier.stop();
        await Promise.allSettled(Object.values(adapters).map(a=>a.close?.()));
        await closed;
      } finally { releaseLock(); }
    })();
    return closing;
  }};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let app, closing=false;
  const port=Number(process.env.PORT || 8787);
  const lockPath=path.join(path.resolve(ROOT,process.env.AUTODL_RUNTIME_DIR || '.runtime'),'server.lock');
  const shutdown=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  const start=()=>{
    app=createApplication({onStop:()=>void shutdown()});
    app.server.listen(port,'127.0.0.1',()=>console.log(`AutoDL GPU 监测台已启动：http://127.0.0.1:${port}\n仅连接真实 AutoDL，默认仅监测；关闭此进程或电脑休眠将停止检查，关闭网页不会停止。\n正常停止：在此窗口按 Ctrl+C，或在项目目录运行 npm.cmd run stop。`));
    app.server.on('error',async error=>{console.error(redact(messageOf(error)));await app.close();process.exitCode=1;});
  };
  // 已有后台在运行时说明是哪一个；代码已更新的后台可在确认后正常停止并用当前代码重启。
  const explainRunning=async error=>{
    let pid=null;try{pid=Number(fs.readFileSync(lockPath,'utf8'));}catch{}
    if(!Number.isInteger(pid)||pid<=0){console.error(redact(messageOf(error)));return 1;}
    const info=await inspectRunningBackend(port);
    console.log(describeRunningBackend(info,{pid,port}));
    if(info.kind!=='outdated'||!info.canStop||!process.stdin.isTTY)return info.kind==='current'?0:1;
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    const answer=await rl.question('输入 Y 并回车：正常停止旧后台并用当前代码重新启动；直接回车：不处理。');rl.close();
    if(!/^y(?:es)?$/i.test(answer.trim()))return 1;
    if(!await stopRunningBackend(info,{pid,port,lockPath}))return 1;
    start();console.log('重启后请在网页中重新打开专用浏览器并检查登录状态，再恢复需要处理的任务。');return null;
  };
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{if(app)void shutdown();else process.exit(130);});
  try { start(); }
  catch(error){
    if(error.code==='LOCK'){const code=await explainRunning(error).catch(e=>{console.error(redact(messageOf(e)));return 1;});if(code!==null)process.exitCode=code;}
    else{console.error(redact(messageOf(error)));process.exitCode=1;}
  }
}

