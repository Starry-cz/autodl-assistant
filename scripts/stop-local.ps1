param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
try {
    . (Join-Path $PSScriptRoot 'node-runtime.ps1')
    # 停止只复用已有环境，缺失时给出指引，不在停止过程中下载软件。
    $runtime = Get-AutoDLNodeRuntime -ProjectRoot $projectRoot
    & $runtime.Node (Join-Path $PSScriptRoot 'stop-server.mjs')
    $stopExit = $LASTEXITCODE
    if ($stopExit -ne 0 -and -not $NoPause) { Read-Host '按回车关闭' | Out-Null }
    exit $stopExit
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
    exit 1
}
