import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import { redact, messageOf } from '../src/errors.mjs';
import { allowsNotification, createExitController, desktopPaths, navigationKind } from './lifecycle.mjs';
import { listenDesktop } from './listen.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = desktopPaths({
  appData: app.getPath('appData'), dataDir: process.env.AUTODL_DESKTOP_DATA_DIR,
  projectRoot, packaged: app.isPackaged, resourcesPath: process.resourcesPath,
});
let backend = null, mainWindow = null, tray = null, localOrigin = '', startupFailed = false;

function writeLog(level, value) {
  // 记录经过脱敏的错误与生命周期，不记录请求正文、账号资料或本地访问令牌。
  const message = redact(value instanceof Error ? messageOf(value) : String(value));
  try { fs.appendFileSync(paths.log, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8'); }
  catch { /* 日志目录不可写时仍继续显示原始的操作错误提示。 */ }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const exitController = createExitController({
  getBackend: () => backend,
  async confirm({ active, busy }) {
    showWindow();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: '退出 AutoDL 助手',
      message: '退出后将停止本机监测，是否继续？',
      detail: `${active ? `当前有 ${active} 个任务正在监测或等待核对。\n` : ''}${busy ? '当前页面操作会完成后再退出，请稍候。\n' : ''}云端实例不会自动关机或释放。`,
      buttons: ['继续运行', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  },
  onStopping() {
    writeLog('info', '正在停止本地后台，等待当前操作收尾');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle('AutoDL 助手 · 正在退出');
    if (tray && !tray.isDestroyed()) tray.setToolTip('AutoDL 助手 · 正在退出，请等待当前操作完成');
  },
  onClosed() {
    writeLog('info', '本地后台已停止');
    tray?.destroy();
    app.quit();
  },
  onError(error) {
    writeLog('error', error);
    dialog.showErrorBox('暂时无法退出', `本地后台未能正常停止，未强制终止操作。\n${redact(messageOf(error))}\n日志：${paths.log}`);
  },
});

function openExternal(url) {
  if (navigationKind(url, localOrigin) !== 'external') return;
  void shell.openExternal(url).catch(error => {
    writeLog('error', error);
    dialog.showErrorBox('无法打开网页', '系统浏览器未能打开该网页，请检查默认浏览器设置。');
  });
}

function configureWebContents(contents) {
  const browserSession = contents.session;
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowsNotification(permission, requestingOrigin, localOrigin));
  browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowsNotification(permission, details.requestingUrl, localOrigin));
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationKind(url, localOrigin) === 'local') void contents.loadURL(url).catch(error => writeLog('error', error));
    else openExternal(url);
    return { action: 'deny' };
  });
  const navigate = event => {
    if (navigationKind(event.url, localOrigin) === 'local') return;
    event.preventDefault();
    openExternal(event.url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.on('will-attach-webview', event => event.preventDefault());
}

async function startDesktop() {
  // 必须先固定浏览器资源目录，再导入 Playwright 和后端，避免借用系统浏览器或其他账号的环境变量。
  process.env.PLAYWRIGHT_BROWSERS_PATH = paths.browsers;
  delete process.env.AUTODL_BROWSER_CHANNEL;
  const { chromium } = await import('playwright');
  if (!fs.existsSync(chromium.executablePath())) {
    throw new Error(app.isPackaged
      ? '桌面版内置浏览器文件缺失，请重新安装完整的 AutoDL 助手桌面版。账号资料保留在用户数据目录中。'
      : '未找到桌面版开发浏览器，请先运行项目的桌面浏览器准备命令。');
  }
  const { createApplication } = await import('../src/server.mjs');
  // 桌面窗口共用网页界面，但更新入口应推荐带运行环境的桌面安装包。
  backend = createApplication({ runtimeDir: paths.runtime, updatesOptions: { channel: 'desktop' }, onStop: () => { void exitController.request(); } });
  await listenDesktop(backend.server, {
    portFile: path.join(paths.userData, 'local-port.json'),
    onPortChanged: ({ previous, port }) => writeLog('warn', `桌面端口 ${previous} 已被占用，已重新分配为 ${port}`),
  });
  localOrigin = `http://127.0.0.1:${backend.server.address().port}`;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '助手', submenu: [
      { id: 'desktop-open', label: '打开 AutoDL 助手', click: showWindow },
      { id: 'desktop-quit', label: '停止并退出', click: () => { void exitController.request(); } },
    ] },
  ]));
  const icon = nativeImage.createFromPath(path.join(projectRoot, 'desktop', 'assets', 'icon.png'));
  if (icon.isEmpty()) throw new Error('桌面版图标资源缺失，请重新安装完整桌面版。');
  mainWindow = new BrowserWindow({
    title: 'AutoDL 助手', width: 1440, height: 960, minWidth: 900, minHeight: 640,
    show: false, icon, backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.setMenu(null);
  configureWebContents(mainWindow.webContents);
  // 窗口关闭仅隐藏到托盘，后台仍继续；退出入口始终经过上面的确认与收尾流程。
  const hintMarker = path.join(paths.userData, 'tray-hint-shown');
  let hintShown = fs.existsSync(hintMarker);
  mainWindow.on('close', event => {
    if (exitController.finished) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hintShown && tray) {
      hintShown = true;
      tray.displayBalloon({ title: 'AutoDL 助手仍在运行', content: '窗口已收起到右下角托盘。监测会继续；右键托盘图标可打开助手或停止并退出。', iconType: 'info', noSound: true });
      try { fs.writeFileSync(hintMarker, '', 'utf8'); } catch (error) { writeLog('error', error); }
    }
  });
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('AutoDL 助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 AutoDL 助手', click: showWindow },
    { type: 'separator' },
    { label: '停止并退出', click: () => { void exitController.request(); } },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  await mainWindow.loadURL(localOrigin);
  showWindow();
  writeLog('info', `桌面版已启动，版本 ${app.getVersion()}，本地端口 ${backend.server.address().port}`);
}

try {
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.mkdirSync(path.join(paths.userData, 'session'), { recursive: true });
  app.setName('AutoDL Assistant Desktop');
  app.setPath('userData', paths.userData);
  app.setPath('sessionData', path.join(paths.userData, 'session'));
  app.setAppUserModelId('com.starrycz.autodlassistant');
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    // 将现有后端的日志一并留在桌面数据目录；不把登录信息回显到控制台。
    console.error = (...values) => writeLog('error', values.map(value => value instanceof Error ? messageOf(value) : String(value)).join(' '));
    console.warn = (...values) => writeLog('warn', values.map(String).join(' '));
    app.on('second-instance', showWindow);
    app.on('activate', showWindow);
    app.on('window-all-closed', () => {});
    app.on('before-quit', event => {
      if (exitController.finished) return;
      event.preventDefault();
      void exitController.request({ prompt: !startupFailed });
    });
    void app.whenReady().then(startDesktop).catch(async error => {
      startupFailed = true;
      writeLog('error', error);
      dialog.showErrorBox('AutoDL 助手启动失败', `${redact(messageOf(error))}\n\n日志：${paths.log}`);
      await exitController.request({ prompt: false });
    });
  }
} catch (error) {
  writeLog('error', error);
  dialog.showErrorBox('AutoDL 助手无法启动', `无法准备桌面数据目录。\n${redact(messageOf(error))}`);
  app.quit();
}
