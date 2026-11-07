@echo off
setlocal
chcp 65001 >nul
title AutoDL Assistant Setup
rem 解压后的源码直接使用本地启动器；单独下载本文件时自动获取完整程序。
if exist "%~dp0scripts\start-local.ps1" goto local
echo AutoDL 助手：正在准备安装，请保持联网并等待窗口提示。
set "AUTODL_SETUP_SCRIPT=%TEMP%\autodl-setup-%RANDOM%-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/Starry-cz/autodl-assistant/v1.2.1/install.ps1' -OutFile $env:AUTODL_SETUP_SCRIPT } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AUTODL_SETUP_SCRIPT%" %*
set "AUTODL_SETUP_EXIT=%ERRORLEVEL%"
powershell.exe -NoProfile -Command "Remove-Item -LiteralPath $env:AUTODL_SETUP_SCRIPT -Force -ErrorAction SilentlyContinue"
if not "%AUTODL_SETUP_EXIT%"=="0" goto failed
exit /b 0
:local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
exit /b %ERRORLEVEL%
:failed
echo 安装未完成，请查看上方提示。检查网络后重新运行本文件。
pause
exit /b 1
