$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# 与健康接口使用同一版本来源，发布时只更新 package.json。
$projectVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version

try {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
    if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw '请安装 Node.js 22 或更新版本。' }

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/playwright/package.json'))) {
        Write-Host '首次启动，正在安装依赖……'
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重新启动。' }
    }

    $listenPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
    $localUrl = "http://127.0.0.1:$listenPort"
    $runtimePath = Join-Path $projectRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

    # 再次双击只打开现有页面，不启动第二个抢卡进程。
    $health = $null
    try { $health = Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 2 } catch { }
    if ($health) {
        if ($health.version -ne $projectVersion) { throw "端口 $listenPort 上已有其他版本，请先停止旧后台。" }
        Start-Process $localUrl
        exit 0
    }

    # 后台运行且隐藏窗口；输出保存在本项目目录，停止入口见停止抢卡助手.cmd。
    $serverScript = Join-Path $projectRoot 'src/server.mjs'
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($serverProcess.HasExited) { throw '后台启动失败，请查看 .runtime/server-error.log。' }
        try { $health = Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 1 } catch { }
        if ($health.ok) {
            Start-Process $localUrl
            Write-Host '助手已在后台运行。关闭网页不会停止任务，电脑休眠会停止检测。'
            exit 0
        }
        Start-Sleep -Milliseconds 300
    }
    throw '后台尚未就绪，请查看 .runtime/server-error.log。'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host '按回车关闭'
    exit 1
}
