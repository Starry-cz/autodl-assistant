param([switch]$NoOpen, [switch]$NoPause)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location -LiteralPath $projectRoot

function Get-LocalHealth {
    try { Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 2 } catch { $null }
}
function Assert-OwnBackend($health) {
    # 同版本的不同解压目录也属于不同安装，不能误用另一份源码的后台。
    if ($health.app -ne 'autodl-assistant' -or $health.projectRoot -ine $projectRoot -or ([string]$health.runtimeDir).TrimEnd([char[]]'\/') -ine $runtimePath.TrimEnd([char[]]'\/')) {
        throw "端口 $listenPort 被其他程序或其他安装目录占用。请从原目录停止后台，或设置 `$env:PORT 后重试。"
    }
    if ($health.version -ne $projectVersion -or $health.codeChanged) {
        throw '后台仍在使用旧代码，请先从原目录停止后台，再启动当前版本。'
    }
}

function Save-CurrentInstallation {
    # 旧快捷方式继续转发到新目录；只记录路径，不复制或搬动登录、任务文件。
    $record = @{ projectRoot = $projectRoot; runtimeDir = $runtimePath; version = $projectVersion; installationRoot = $installationRoot } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $installationRoot '.autodl-current.json'), $record)
    if ($projectRoot -ine $installationRoot) {
        [IO.File]::WriteAllText((Join-Path $projectRoot '.autodl-current.json'), $record)
        # 首次升级的旧入口尚不认识指针；仅更新已确认属于本安装的启停脚本。
        Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/start-local.ps1') -Destination (Join-Path $installationRoot 'scripts/start-local.ps1') -Force
        Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/stop-server.mjs') -Destination (Join-Path $installationRoot 'scripts/stop-server.mjs') -Force
    }
    if ($listenPort -eq 8787) {
        $registryDirectory = Join-Path $env:LOCALAPPDATA 'AutoDL-Assistant'
        New-Item -ItemType Directory -Path $registryDirectory -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $registryDirectory 'web-install.json'), $record)
    }
}

try {
    $explicitRuntime = [bool]$env:AUTODL_RUNTIME_DIR
    # 旧入口转发到新版之前先固定显式相对资料路径，避免相对路径随后按新版目录解释。
    if ($explicitRuntime -and -not [IO.Path]::IsPathRooted($env:AUTODL_RUNTIME_DIR)) {
        $env:AUTODL_RUNTIME_DIR = [IO.Path]::GetFullPath((Join-Path $projectRoot $env:AUTODL_RUNTIME_DIR))
    }
    $projectVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
    $listenPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
    if ($listenPort -lt 1 -or $listenPort -gt 65535) { throw 'PORT 必须为 1 至 65535 的整数。' }
    $localUrl = "http://127.0.0.1:$listenPort"
    $installationRoot = if ($env:AUTODL_INSTALL_ROOT) { [IO.Path]::GetFullPath($env:AUTODL_INSTALL_ROOT) } else { $projectRoot }
    $pointerPath = Join-Path $projectRoot '.autodl-current.json'
    $saved = $null
    if (Test-Path -LiteralPath $pointerPath) { $saved = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    elseif (-not $env:AUTODL_RUNTIME_DIR -and $listenPort -eq 8787) {
        $registryPath = Join-Path $env:LOCALAPPDATA 'AutoDL-Assistant/web-install.json'
        if (Test-Path -LiteralPath $registryPath) { $saved = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    }
    if ($saved) {
        $savedPackage = Join-Path $saved.projectRoot 'package.json'
        if (-not (Test-Path -LiteralPath $savedPackage)) { throw '上次更新后的程序目录不存在，请保留原数据并重新安装。' }
        $savedMetadata = Get-Content -LiteralPath $savedPackage -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($savedMetadata.name -ne 'autodl-gpu-watch') { throw '已记录的安装目录不是 AutoDL 助手。' }
        if (-not $env:AUTODL_RUNTIME_DIR) { $env:AUTODL_RUNTIME_DIR = $saved.runtimeDir }
        $installationRoot = if ($saved.installationRoot) { $saved.installationRoot } else { $installationRoot }
        if ([version]$savedMetadata.version -ge [version]$projectVersion -and $saved.projectRoot -ine $projectRoot) {
            $env:AUTODL_INSTALL_ROOT = $installationRoot
            $forward = @('-NoPause'); if ($NoOpen) { $forward += '-NoOpen' }
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $saved.projectRoot 'scripts/start-local.ps1') @forward
            exit $LASTEXITCODE
        }
    }
    # 与 Node 后台一致：绝对路径直接使用，相对路径从项目根目录解析。
    $runtimePath = if (-not $env:AUTODL_RUNTIME_DIR) { Join-Path $projectRoot '.runtime' }
        elseif ([IO.Path]::IsPathRooted($env:AUTODL_RUNTIME_DIR)) { [IO.Path]::GetFullPath($env:AUTODL_RUNTIME_DIR) }
        else { [IO.Path]::GetFullPath((Join-Path $projectRoot $env:AUTODL_RUNTIME_DIR)) }
    $env:AUTODL_RUNTIME_DIR = $runtimePath
    $env:AUTODL_INSTALL_ROOT = $installationRoot
    $health = Get-LocalHealth
    $replaceBackend = $false
    if ($health) {
        if ($health.app -ne 'autodl-assistant') { throw "端口 $listenPort 被其他程序占用。" }
        if ($health.projectRoot -ieq $projectRoot -and $health.version -eq $projectVersion -and -not $health.codeChanged) {
            Assert-OwnBackend $health; Save-CurrentInstallation
            Write-Host "后台已运行：$localUrl"
            if (-not $NoOpen) { Start-Process $localUrl }; exit 0
        }
        if ([version]$health.version -gt [version]$projectVersion) { throw '已有更高版本正在运行，不自动降级；请打开现有网页。' }
        # 默认端口的新源码可承接正在运行的旧安装，原资料目录原地复用。
        if ($health.projectRoot -ine $projectRoot -and $runtimePath -ine $health.runtimeDir) {
            if ($saved -or $explicitRuntime -or $listenPort -ne 8787) { throw '当前端口属于另一份安装，未切换其后台。' }
            $runtimePath = [IO.Path]::GetFullPath($health.runtimeDir)
            $env:AUTODL_RUNTIME_DIR = $runtimePath
            $installationRoot = if ($health.installationRoot) { $health.installationRoot } else { $health.projectRoot }
            $env:AUTODL_INSTALL_ROOT = $installationRoot
        }
        if ($runtimePath -ine $health.runtimeDir) { throw '运行中的后台使用另一数据目录，未停止。' }
        $replaceBackend = $true
    }
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $listenPort); $occupied = $true } catch { $occupied = $false } finally { $client.Dispose() }
    if ($occupied -and -not $replaceBackend) { throw "端口 $listenPort 已被占用，请停止原后台或设置其他 PORT。" }

    Write-Host '[1/4] 准备运行环境（首次可能需要下载 Node.js）'
    . (Join-Path $PSScriptRoot 'node-runtime.ps1')
    $nodeRuntime = Get-AutoDLNodeRuntime -ProjectRoot $projectRoot -Install
    Write-Host '[2/4] 准备项目依赖'
    # 校验依赖能够实际加载并与锁文件版本一致，避免中断安装留下不完整目录。
    & $nodeRuntime.Node -e "try { const lock=require('./package-lock.json').packages; require('playwright'); for(const p of ['playwright','playwright-core'])if(require(p+'/package.json').version!==lock['node_modules/'+p].version)process.exit(1); } catch { process.exit(1); }"
    if ($LASTEXITCODE -ne 0) {
        Write-Host '首次启动或依赖不完整，正在安装依赖……'
        & $nodeRuntime.Npm ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查 npm 网络连接后重新启动。' }
    }
    Write-Host '[3/4] 检查浏览器'
    & $nodeRuntime.Node (Join-Path $projectRoot 'src/browser.mjs')
    if ($LASTEXITCODE -eq 2) {
        Write-Host '未找到可用浏览器，正在安装 Chromium……'
        & $nodeRuntime.Npm run browser:install
        if ($LASTEXITCODE -ne 0) { throw '浏览器下载失败。请检查网络，或安装 Edge / Chrome 后重新启动。' }
        & $nodeRuntime.Node (Join-Path $projectRoot 'src/browser.mjs')
    }
    if ($LASTEXITCODE -ne 0) { throw '浏览器预检未通过，请根据上方提示处理后重试。' }

    if ($replaceBackend) {
        Write-Host '新版环境已准备好，正在正常交接旧后台……'
        & $nodeRuntime.Node (Join-Path $PSScriptRoot 'restart-for-upgrade.mjs')
        if ($LASTEXITCODE -ne 0) { throw '旧后台未完成安全交接，未启动第二个后台。请按上方提示处理后重试。' }
    }

    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
    Write-Host '[4/4] 启动本地网页'
    # 后台隐藏运行，日志写入本安装的运行目录；只在确认服务就绪后打开网页。
    # 由 Node 按字面路径创建后台和日志，避开 PowerShell 5.1 对方括号目录的通配符解析。
    $backendPid = & $nodeRuntime.Node (Join-Path $PSScriptRoot 'start-background.mjs')
    if ($LASTEXITCODE -ne 0) { throw '后台进程创建失败，请根据上方错误处理后重试。' }
    $serverProcess = Get-Process -Id ([int]$backendPid) -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 300; $attempt++) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { throw "后台启动失败，请查看 $runtimePath\server-error.log。" }
        $health = Get-LocalHealth
        if ($health -and $health.ready -ne $false) {
            Assert-OwnBackend $health
            Save-CurrentInstallation
            Write-Host "启动成功：$localUrl"
            Write-Host '关闭网页后后台仍运行；停止时请双击本目录的“停止抢卡助手.cmd”。'
            if (-not $NoOpen) { Start-Process $localUrl }
            exit 0
        }
        Start-Sleep -Milliseconds 300
    }
    throw "等待后台启动超时，请查看 $runtimePath\server-error.log。"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
    exit 1
}
