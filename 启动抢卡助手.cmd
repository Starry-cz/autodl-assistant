@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 统一启动入口：监控室和抢卡控制台共用同一个后台。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
