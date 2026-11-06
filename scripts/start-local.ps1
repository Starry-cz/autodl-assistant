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
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not $npmCommand) { throw '请先从 https://nodejs.org/en/download 安装 Node.js 22 或更新版本（包含 npm），然后重新打开终端。' }
    $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) { throw '请安装 Node.js 22 或更新版本。' }
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

    # 校验依赖能够实际加载并与锁文件版本一致，避免中断安装留下不完整目录。
    & $nodeCommand.Source -e "try { const lock=require('./package-lock.json').packages; require('playwright'); for(const p of ['playwright','playwright-core'])if(require(p+'/package.json').version!==lock['node_modules/'+p].version)process.exit(1); } catch { process.exit(1); }"
    if ($LASTEXITCODE -ne 0) {
        Write-Host '首次启动或依赖不完整，正在安装依赖……'
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查 npm 网络连接后重新启动。' }
    }
    & $nodeCommand.Source (Join-Path $projectRoot 'src/browser.mjs')
    if ($LASTEXITCODE -eq 2) {
        Write-Host '未找到可用浏览器，正在安装 Chromium……'
        & $npmCommand.Source run browser:install
        if ($LASTEXITCODE -ne 0) { throw '浏览器下载失败。请检查网络，或安装 Edge / Chrome 后重新启动。' }
        & $nodeCommand.Source (Join-Path $projectRoot 'src/browser.mjs')
    }
    if ($LASTEXITCODE -ne 0) { throw '浏览器预检未通过，请根据上方提示处理后重试。' }

    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
    # 后台隐藏运行，日志写入本安装的运行目录；只在确认服务就绪后打开网页。
    $serverScript = Join-Path $projectRoot 'src/server.mjs'
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log')
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
