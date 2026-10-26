@echo off
:: Vibe AStock 启动脚本（含 Agnes AI API Key）
cd /d "C:/Users/51092/WorkBuddy/2026-10-26-10-53-21/vibe-astock"

:: 设置 Agnes AI API Key
set AGNES_API_KEY=sk-jb7fuhpiNi6YSUEMMwbHW4P1XOJiL4Qh5IgfeB5woK0kDOvK

:: 清除代理变量（避免拦截本地请求）
set http_proxy=
set https_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set NO_PROXY=*
set no_proxy=*

:: 启动服务
call scripts\start.cmd
