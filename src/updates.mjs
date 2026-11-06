const REPOSITORY = 'https://github.com/Starry-cz/autodl-assistant';
export const RELEASE_API = 'https://api.github.com/repos/Starry-cz/autodl-assistant/releases/latest';
export const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000;
export const UPDATE_RETRY_MS = 15 * 60 * 1000;
const MANUAL_INTERVAL_MS = 60 * 1000;
const emptyDownloads = () => ({ desktopInstaller: null, desktopPortable: null, source: null, onlineInstaller: null });

// 按主、次、修订号比较；不把预发布版本当作正式更新，构建标记不影响版本先后。
function versionParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function releaseInfo(release, currentVersion) {
  const tag = release?.tag_name;
  if (release?.draft || release?.prerelease || !versionParts(tag)) throw new Error('发布信息不是有效的正式版本，请稍后重试。');
  const version = tag.replace(/^v/, ''), comparison = compareVersions(version, currentVersion);
  if (comparison === null) throw new Error('当前版本号无法比较，请到发布页查看更新。');
  const releaseUrl = `${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
  if (release.html_url !== releaseUrl) throw new Error('发布信息与本项目不一致，请稍后重试。');
  const names = {
    desktopInstaller: `autodl-assistant-desktop-${version}-setup-x64.exe`,
    desktopPortable: `autodl-assistant-desktop-${version}-win-x64.zip`,
    source: `autodl-assistant-v${version}.zip`,
    onlineInstaller: 'autodl-assistant-setup.cmd',
  };
  const downloads = emptyDownloads();
  for (const [kind, name] of Object.entries(names)) {
    const expected = `${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${name}`;
    // 只提供本仓库、同一版本、对应类型的已上传附件，不打开发布正文里的任意链接。
    if (release.assets?.some(asset => asset.name === name && asset.state === 'uploaded' && asset.browser_download_url === expected)) downloads[kind] = expected;
  }
  return { latestVersion: version, updateAvailable: comparison > 0, status: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
    releaseUrl, publishedAt: release.published_at || null, notes: typeof release.body === 'string' ? release.body : '', downloads };
}

export class ReleaseUpdates {
  #pending = null;
  #controller = null;
  #closed = false;
  #lastAttemptAt = null;
  #rateLimitUntil = 0;
  constructor({ currentVersion, channel = 'web', fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 10000 } = {}) {
    this.fetchImpl = fetchImpl; this.clock = clock; this.timeoutMs = timeoutMs;
    // 使用真实启动时间作为序号起点，同版本后台重启后，未关闭的网页也能接收新状态。
    this.state = { currentVersion, channel: channel === 'desktop' ? 'desktop' : 'web', status: 'idle', revision: Date.now(), latestVersion: null, updateAvailable: false,
      checkedAt: null, nextCheckAt: null, error: null, releaseUrl: null, publishedAt: null, notes: '', downloads: emptyDownloads() };
  }
  publicState() { return { ...this.state, downloads: { ...this.state.downloads } }; }
  check({ force = false } = {}) {
    if (this.#pending) return this.#pending;
    const now = this.clock();
    if (this.#closed || now < this.#rateLimitUntil || (this.#lastAttemptAt !== null && now - this.#lastAttemptAt < MANUAL_INTERVAL_MS)
      || (!force && this.state.nextCheckAt !== null && now < this.state.nextCheckAt)) return Promise.resolve(this.publicState());
    this.#lastAttemptAt = now;
    const previousStatus = this.state.status;
    this.state.status = 'checking';
    // checkedAt 仅代表上次成功检查；独立序号才能区分失败后状态与迟到的旧轮询响应。
    this.state.revision = Math.max(Date.now(), this.state.revision + 1);
    const controller = new AbortController();
    this.#controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    this.#pending = Promise.resolve().then(async () => {
      try {
        // 版本检查与 AutoDL 会话完全独立；只访问公开发布接口，不携带账号或本机凭据。
        const response = await this.fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json',
          'User-Agent': 'autodl-assistant-update-check', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal });
        if (response.status === 403 || response.status === 429) {
          const retrySeconds = Number(response.headers.get('retry-after'));
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          this.#rateLimitUntil = Math.max(this.clock() + UPDATE_RETRY_MS, Number.isFinite(reset) ? reset : 0,
            Number.isFinite(retrySeconds) ? this.clock() + retrySeconds * 1000 : 0);
          throw new Error('更新检查暂时受限，请稍后重试。');
        }
        if (response.status === 404) throw new Error('暂未找到正式发布版本，请稍后重试。');
        if (!response.ok) throw new Error('暂时无法读取发布信息，请稍后重试。');
        const info = releaseInfo(await response.json(), this.state.currentVersion);
        if (!this.#closed) Object.assign(this.state, info, { checkedAt: this.clock(), nextCheckAt: this.clock() + UPDATE_CACHE_MS, error: null });
        else this.state.status = previousStatus;
      } catch (error) {
        if (this.#closed) this.state.status = previousStatus;
        else Object.assign(this.state, { status: 'error', nextCheckAt: Math.max(this.clock() + UPDATE_RETRY_MS, this.#rateLimitUntil),
          // 离线时保留上次查到的版本与下载入口，但不能把失败显示成“已是最新版”。
          error: timedOut ? '检查更新超时，请检查网络后重试。' : error?.name === 'TypeError' || error?.name === 'SyntaxError'
            ? '暂时无法检查更新，请检查网络后重试。' : error.message });
      } finally {
        this.state.revision = Math.max(Date.now(), this.state.revision + 1);
        clearTimeout(timer); this.#controller = null; this.#pending = null;
      }
      return this.publicState();
    });
    return this.#pending;
  }
  close() { this.#closed = true; this.#controller?.abort(); }
}
