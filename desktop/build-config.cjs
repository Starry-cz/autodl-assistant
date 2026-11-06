// Electron Builder 26 配置：完整离线安装包与解压即用 ZIP，共用同一份桌面程序。
module.exports = {
  appId: 'com.starrycz.autodlassistant',
  productName: 'AutoDL助手桌面版',
  executableName: 'AutoDL Assistant',
  electronVersion: '45.2.3',
  electronDist: 'node_modules/electron/dist',
  asar: false,
  npmRebuild: false,
  allowMissingDependencies: false,
  forceCodeSigning: false,
  publish: null,
  directories: {
    output: 'output/desktop',
    buildResources: 'desktop/assets',
  },
  extraMetadata: { main: 'desktop/main.mjs' },
  // 使用包含清单；Builder 自动收集生产依赖，不会把 Electron 等开发依赖装进应用。
  files: [
    'src/**/*',
    'public/**/*',
    'desktop/*.mjs',
    'desktop/assets/icon.png',
    'package.json',
    'LICENSE',
  ],
  // 浏览器来自构建准备步骤，连同许可证和 ffmpeg/winldd 一起打包；不读取用户浏览器缓存。
  extraResources: [{
    from: '.cache/desktop-browsers',
    to: 'browsers',
    // 构建机的依赖验证标记不随包分发，让新电脑首次启动时正常检查其系统依赖。
    filter: ['**/*', '!chromium_headless_shell-*{,/**/*}', '!.links{,/**/*}', '!**/DEPENDENCIES_VALIDATED'],
  }],
  win: {
    icon: 'desktop/assets/icon.png',
    requestedExecutionLevel: 'asInvoker',
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    artifactName: 'autodl-assistant-desktop-${version}-win-${arch}.${ext}',
  },
  nsis: {
    artifactName: 'autodl-assistant-desktop-${version}-setup-${arch}.${ext}',
    oneClick: true,
    perMachine: false,
    packElevateHelper: false,
    differentialPackage: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'AutoDL助手桌面版',
    deleteAppDataOnUninstall: false,
  },
};
