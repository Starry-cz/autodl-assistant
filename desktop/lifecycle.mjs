import path from 'node:path';

const ACTIVE_TASK_STATES = new Set(['queued', 'watching', 'preparing', 'submitting', 'verifying', 'reconciling']);

// 桌面数据与安装目录分离；测试可以指定独立目录，不接触真实账号资料。
export function desktopPaths({ appData, dataDir, projectRoot, packaged, resourcesPath }) {
  const userData = path.resolve(dataDir || path.join(appData, 'AutoDL Assistant Desktop'));
  return {
    userData,
    runtime: path.join(userData, 'runtime'),
    log: path.join(userData, 'desktop.log'),
    browsers: packaged ? path.join(resourcesPath, 'browsers') : path.join(projectRoot, '.cache', 'desktop-browsers'),
  };
}

// 主窗口只承载本地工作台，普通网页交给系统浏览器，其他协议不交给操作系统执行。
export function navigationKind(value, localOrigin) {
  let url;
  try { url = new URL(value); } catch { return 'blocked'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked';
  return url.origin === localOrigin ? 'local' : 'external';
}

export function allowsNotification(permission, requestingUrl, localOrigin) {
  return permission === 'notifications' && navigationKind(requestingUrl, localOrigin) === 'local';
}

export function exitActivity(backend) {
  const active = backend ? backend.store.tasks().filter(task => ACTIVE_TASK_STATES.has(task.state)).length : 0;
  const busy = backend?.engine.busy === true;
  return { active, busy, needsConfirmation: active > 0 || busy };
}

// 合并托盘、系统退出和后台停止请求，确认取消不停止任务，确认退出则等待现有操作自然收尾。
export function createExitController({ getBackend, confirm, onStopping, onClosed, onError }) {
  let pending = null, stopping = false, finished = false;
  return {
    get stopping() { return stopping; },
    get finished() { return finished; },
    request({ prompt = true } = {}) {
      if (finished) return Promise.resolve(true);
      if (pending) return pending;
      pending = (async () => {
        const activity = exitActivity(getBackend());
        if (prompt && activity.needsConfirmation && !await confirm(activity)) return false;
        stopping = true;
        onStopping();
        await getBackend()?.close();
        finished = true;
        onClosed();
        return true;
      })().catch(error => {
        stopping = false;
        onError(error);
        return false;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
