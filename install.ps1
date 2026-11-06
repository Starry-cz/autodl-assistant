param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AutoDL-Assistant'),
    [switch]$NoOpen,
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$releaseVersion = '1.2.0'
$downloadUrl = "https://github.com/Starry-cz/autodl-assistant/releases/download/v$releaseVersion/autodl-assistant-v$releaseVersion.zip"
$temporaryDirectory = $null
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$installationCopied = $false

function Start-InstalledProject([string]$Directory) {
    # 安装与下载源码后双击使用同一入口，缺少 Node.js 时由启动器自动准备。
    $launcher = Join-Path $Directory 'scripts/start-local.ps1'
    $launchArguments = @('-NoPause')
    if ($NoOpen) { $launchArguments += '-NoOpen' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher @launchArguments
    if ($LASTEXITCODE -ne 0) {
        throw "程序已保留在 $Directory，但启动没有完成。解决上方错误后，双击目录中的启动抢卡助手.cmd 重试，无需重新下载。"
    }
    if (-not $NoShortcut) {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $shortcutPath = Join-Path $desktop 'AutoDL助手.lnk'
        # 不覆盖已有快捷方式；创建失败不影响已经启动的服务。
        if (Test-Path -LiteralPath $desktop -PathType Container) {
            if (-not (Test-Path -LiteralPath $shortcutPath)) {
                try {
                    $shell = New-Object -ComObject WScript.Shell
                    $shortcut = $shell.CreateShortcut($shortcutPath)
                    $shortcut.TargetPath = Join-Path $Directory '启动抢卡助手.cmd'
                    $shortcut.WorkingDirectory = $Directory
                    $shortcut.Description = '打开 AutoDL 助手'
                    $shortcut.Save()
                    Write-Host '已创建桌面快捷方式：AutoDL助手。'
                } catch { Write-Host '桌面快捷方式未创建；以后可双击安装目录中的“启动抢卡助手.cmd”。' }
            }
        }
    }
    Write-Host '安装和启动完成。以后双击“AutoDL助手”桌面快捷方式或安装目录中的“启动抢卡助手.cmd”。'
}

try {
    $installationPath = [IO.Path]::GetFullPath($InstallDir)
    if (Test-Path -LiteralPath $installationPath) {
        if (-not (Test-Path -LiteralPath $installationPath -PathType Container)) {
            throw "安装路径已被文件占用：$installationPath。请使用 -InstallDir 指定其他目录。"
        }
        if (@(Get-ChildItem -LiteralPath $installationPath -Force).Count -gt 0) {
            $packagePath = Join-Path $installationPath 'package.json'
            $launcherPath = Join-Path $installationPath 'scripts/start-local.ps1'
            if ((Test-Path -LiteralPath $packagePath -PathType Leaf) -and (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
                $installed = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($installed.name -eq 'autodl-gpu-watch' -and $installed.version -eq $releaseVersion) {
                    Write-Host '已找到当前版本，直接启动，不覆盖本地数据。'
                    Start-InstalledProject $installationPath
                    exit 0
                }
            }
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

    Start-InstalledProject $installationPath
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
