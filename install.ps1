param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AutoDL-Assistant'),
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$releaseVersion = '1.0.1'
$downloadUrl = "https://github.com/Starry-cz/autodl-assistant/releases/download/v$releaseVersion/autodl-assistant-v$releaseVersion.zip"
$temporaryDirectory = $null
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$installationCopied = $false

try {
    # 安装入口只准备本项目，不修改系统软件；新装 Node.js 后需要重新打开 PowerShell。
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not $npmCommand) {
        throw '请先从 https://nodejs.org/ 安装 Node.js 22 或更新版本，然后重新打开 PowerShell 再运行本命令。'
    }
    $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) {
        throw '需要 Node.js 22 或更新版本。升级后请重新打开 PowerShell，再运行安装命令。'
    }

    $installationPath = [IO.Path]::GetFullPath($InstallDir)
    if (Test-Path -LiteralPath $installationPath) {
        if (-not (Test-Path -LiteralPath $installationPath -PathType Container)) {
            throw "安装路径已被文件占用：$installationPath。请使用 -InstallDir 指定其他目录。"
        }
        if (@(Get-ChildItem -LiteralPath $installationPath -Force).Count -gt 0) {
            throw "安装目录不为空，未覆盖任何文件：$installationPath。已有项目请直接双击其中的启动抢卡助手.cmd；新安装可用 -InstallDir 指定空目录。"
        }
    }

    # 每次下载使用独立临时目录，已有安装中的 .runtime 和登录资料不参与此流程。
    $temporaryDirectory = Join-Path $temporaryParent ('autodl-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $archivePath = Join-Path $temporaryDirectory 'source.zip'
    Write-Host "正在下载 AutoDL 助手 v$releaseVersion……"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
    Expand-Archive -LiteralPath $archivePath -DestinationPath (Join-Path $temporaryDirectory 'unpacked')
    $sourcePath = Join-Path $temporaryDirectory "unpacked\autodl-assistant-v$releaseVersion"
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'scripts/start-local.ps1') -PathType Leaf)) {
        throw '下载包目录结构不完整，未安装。请从 GitHub Releases 下载源码包并完整解压。'
    }

    New-Item -ItemType Directory -Path $installationPath -Force | Out-Null
    Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $installationPath -Recurse
    $installationCopied = $true
    Write-Host "源码已安装到：$installationPath"

    # 独立运行启动器，让失败退出码返回安装入口，并保证临时下载目录能够清理。
    $launcher = Join-Path $installationPath 'scripts/start-local.ps1'
    $launchArguments = @('-NoPause')
    if ($NoOpen) { $launchArguments += '-NoOpen' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher @launchArguments
    if ($LASTEXITCODE -ne 0) {
        throw "源码已保留在 $installationPath，但启动没有完成。解决上方错误后，双击目录中的启动抢卡助手.cmd 重试，无需再次下载安装。"
    }
    Write-Host '安装和启动完成。以后双击安装目录中的“启动抢卡助手.cmd”即可。'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $installationCopied -and $temporaryDirectory) {
        Write-Host '下载或解压失败时可重新运行安装命令；如已产生文件，请改用一个空的安装目录。'
    }
    exit 1
} finally {
    if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        # 只清理本次创建且仍位于临时目录直属范围内的下载目录。
        $cleanupTarget = [IO.Path]::GetFullPath($temporaryDirectory)
        if ([IO.Path]::GetDirectoryName($cleanupTarget).Equals($temporaryParent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($cleanupTarget).StartsWith('autodl-install-')) {
            Remove-Item -LiteralPath $cleanupTarget -Recurse -Force
        }
    }
}
