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

try {
    $projectVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
    $listenPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
    if ($listenPort -lt 1 -or $listenPort -gt 65535) { throw 'PORT 必须为 1 至 65535 的整数。' }
    $localUrl = "http://127.0.0.1:$listenPort"
    # 与 Node 后台一致：绝对路径直接使用，相对路径从项目根目录解析。
    $runtimePath = if (-not $env:AUTODL_RUNTIME_DIR) { Join-Path $projectRoot '.runtime' }
        elseif ([IO.Path]::IsPathRooted($env:AUTODL_RUNTIME_DIR)) { [IO.Path]::GetFullPath($env:AUTODL_RUNTIME_DIR) }
        else { [IO.Path]::GetFullPath((Join-Path $projectRoot $env:AUTODL_RUNTIME_DIR)) }
    $env:AUTODL_RUNTIME_DIR = $runtimePath
    $health = Get-LocalHealth
    if ($health) {
        Assert-OwnBackend $health
        Write-Host "后台已运行：$localUrl"
        if (-not $NoOpen) { Start-Process $localUrl }
        exit 0
    }
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $listenPort); $occupied = $true } catch { $occupied = $false } finally { $client.Dispose() }
    if ($occupied) { throw "端口 $listenPort 已被占用，请停止原后台或设置其他 PORT。" }

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

    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
    Write-Host '[4/4] 启动本地网页'
    # 后台隐藏运行，日志写入本安装的运行目录；只在确认服务就绪后打开网页。
    # 由 Node 按字面路径创建后台和日志，避开 PowerShell 5.1 对方括号目录的通配符解析。
    $backendPid = & $nodeRuntime.Node (Join-Path $PSScriptRoot 'start-background.mjs')
    if ($LASTEXITCODE -ne 0) { throw '后台进程创建失败，请根据上方错误处理后重试。' }
    $serverProcess = Get-Process -Id ([int]$backendPid) -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { throw "后台启动失败，请查看 $runtimePath\server-error.log。" }
        $health = Get-LocalHealth
        if ($health) {
            Assert-OwnBackend $health
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
