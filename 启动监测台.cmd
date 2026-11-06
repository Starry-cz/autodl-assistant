@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本。
  pause
  exit /b 1
)
if not exist node_modules\playwright\package.json (
  echo 首次启动，安装项目依赖...
  call npm.cmd install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"

