@echo off
:: Vibe AStock 启动脚本
cd /d "C:/Users/51092/WorkBuddy/2026-10-26-10-53-21/vibe-astock"

:: 清除代理变量（避免拦截本地请求）
set http_proxy=
set https_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set NO_PROXY=*
set no_proxy=*

:: 设置 Agnes AI API Key（从 WorkBuddy models.json 读取）
for /f "tokens=*" %%i in ('powershell -Command "(Get-Content '$env:USERPROFILE\.workbuddy\models.json' | ConvertFrom-Json) | Where-Object { $_.id -eq 'custom-local:agnes-2.5-flash' } | Select-Object -ExpandProperty apiKey"') do set AGNES_API_KEY=%%i

:: 启动服务
call scripts\start.cmd
