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
:: 🔴 路径必须用 %USERPROFILE% 而不是 $env:USERPROFILE:% 会被 cmd 展开,而 $env: 写在
::    PowerShell 单引号里不会被展开(报「找不到驱动器。名为 $env 的驱动器不存在」),
::    for /f 拿不到值 → AGNES_API_KEY 为空 → 后台默认 AI 来源直接 FAIL。
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content '%USERPROFILE%\.workbuddy\models.json' | ConvertFrom-Json) | Where-Object { $_.id -eq 'custom-local:agnes-2.5-flash' } | Select-Object -ExpandProperty apiKey"') do set AGNES_API_KEY=%%i
if not defined AGNES_API_KEY echo [warn] 没读到 AGNES_API_KEY,后台默认 AI 来源会不可用:检查 %USERPROFILE%\.workbuddy\models.json 里有没有 id=custom-local:agnes-2.5-flash 的条目

:: 启动服务
call scripts\start.cmd
