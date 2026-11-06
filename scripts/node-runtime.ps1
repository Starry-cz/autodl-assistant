# 仅使用项目内便携版或现有系统 Node，不需要管理员权限，也不修改系统或用户 PATH。
function Get-AutoDLNodeRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [switch]$Install
    )

    $projectPath = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
    $osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch -Regex ($osArchitecture) {
        '^(AMD64|x64)$' { $archiveArchitecture = 'x64'; break }
        '^ARM64$' { $archiveArchitecture = 'arm64'; break }
        default { throw '仅支持 64 位 Windows（x64 / ARM64），不支持 32 位 Windows。' }
    }
    # PowerShell 5.1 的下载进度条会显著拖慢大文件下载，步骤提示由 Write-Host 提供。
    $ProgressPreference = 'SilentlyContinue'
    $nodeVersion = 'v22.23.4'
    $folderName = 'node-' + $nodeVersion + '-win-' + $archiveArchitecture
    $toolsPath = Join-Path $projectPath '.tools'
    $portablePath = Join-Path $toolsPath $folderName

    # 同时验证 node 与 npm，避免只存在 node.exe 的残缺安装被当作可用环境。
    function Read-NodeRuntime([string]$Directory, [bool]$Portable) {
        $nodePath = Join-Path $Directory 'node.exe'
        $npmPath = Join-Path $Directory 'npm.cmd'
        if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { return $null }
        try {
            $version = & $nodePath --version 2>$null
            if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { return $null }
            $npmVersion = & $npmPath --version 2>$null
            if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch '^\d+\.') { return $null }
        } catch { return $null }
        return [pscustomobject]@{ Node = $nodePath; Npm = $npmPath; Directory = $Directory; Portable = $Portable }
    }
    function Use-NodeRuntime($Runtime) {
        # PATH 修改只属于当前进程及其子进程，退出后恢复，不影响已安装的系统 Node。
        $prefix = $Runtime.Directory + [IO.Path]::PathSeparator
        if (-not $env:PATH -or -not $env:PATH.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $env:PATH = $prefix + $env:PATH }
        return $Runtime
    }

    $runtime = Read-NodeRuntime -Directory $portablePath -Portable $true
    if ($runtime) { return Use-NodeRuntime $runtime }
    $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($systemNode) {
        $runtime = Read-NodeRuntime -Directory (Split-Path -Parent $systemNode.Source) -Portable $false
        if ($runtime) { return Use-NodeRuntime $runtime }
    }
    if (-not $Install) { throw '未找到可用的 Node.js 22 或更新版本。请先双击“启动抢卡助手.cmd”，自动准备本项目的运行环境。' }
    if (Test-Path -LiteralPath $portablePath) { throw ('项目内的 Node 目录不完整，未覆盖已有文件。请将此目录改名后重新启动：' + $portablePath) }

    New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
    # 下载与解压使用较短的系统临时路径，避免 PowerShell 5.1 的长路径限制。
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $downloadDirectory = Join-Path $temporaryRoot ('autodl-node-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    try {
        Write-Host ('未找到 Node.js 22+，正在下载官方便携版 ' + $nodeVersion + '（' + $archiveArchitecture + '）……')
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $zipPath = Join-Path $downloadDirectory 'node.zip'
        $url = 'https://nodejs.org/dist/' + $nodeVersion + '/' + $folderName + '.zip'
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
        Write-Host '正在解压并检查项目运行环境……'
        $unpackPath = Join-Path $downloadDirectory 'unpacked'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $unpackPath)
        $downloadedPath = Join-Path $unpackPath $folderName
        if (-not (Read-NodeRuntime -Directory $downloadedPath -Portable $true)) { throw '下载的 Node.js 无法运行或 npm 不完整，请检查网络与系统架构后重试。' }
        # 只移动本次解压的目录，分别确认源在本次临时目录、目标在当前项目 .tools 内。
        $sourceBoundary = [IO.Path]::GetFullPath($downloadDirectory) + [IO.Path]::DirectorySeparatorChar
        $targetBoundary = [IO.Path]::GetFullPath($toolsPath) + [IO.Path]::DirectorySeparatorChar
        if (-not [IO.Path]::GetFullPath($downloadedPath).StartsWith($sourceBoundary, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($portablePath).StartsWith($targetBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw '运行环境目录超出预期范围，已停止安装。' }
        Move-Item -LiteralPath $downloadedPath -Destination $portablePath -ErrorAction Stop
        $runtime = Read-NodeRuntime -Directory $portablePath -Portable $true
        if (-not $runtime) { throw '项目运行环境检查失败，请重新启动并查看错误信息。' }
        Write-Host '项目运行环境已准备好，后续启动将直接复用。'
        return Use-NodeRuntime $runtime
    } finally {
        # 清理仅限本次创建的临时下载目录，保留已安装环境及 .runtime 数据。
        $temporaryFullPath = [IO.Path]::GetFullPath($downloadDirectory)
        if ((Split-Path -Parent $temporaryFullPath) -ne $temporaryRoot -or (Split-Path -Leaf $temporaryFullPath) -notlike 'autodl-node-*') { throw '临时下载目录校验失败，未执行清理。' }
        if (Test-Path -LiteralPath $temporaryFullPath) { Remove-Item -LiteralPath $temporaryFullPath -Recurse -Force }
    }
}
