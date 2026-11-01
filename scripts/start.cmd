@echo off
setlocal
rem 先按 PATH 找 powershell；找不到时回退到系统完整路径。
rem 有些环境的 PATH 不含 PowerShell 目录，此时窗口会一闪而过、看不出原因 —— 所以下面失败时会 pause。
set "PS_EXE=powershell.exe"
where powershell.exe >nul 2>nul
if errorlevel 1 (
  if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  )
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [启动失败] 退出码 %EXITCODE%
  echo 上面是 PowerShell 报的错误。常见原因：
  echo   1. 找不到 powershell.exe / node / npm（PATH 问题）
  echo   2. 端口被占用（换端口或关掉占用者）
  echo   3. 产品配置缺失
  echo 备份脚本在 scripts\start.cmd.bak-20261028 / start.ps1.bak-20261028
  pause
)
endlocal & exit /b %EXITCODE%
