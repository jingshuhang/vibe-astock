@echo off
setlocal
rem Find powershell on PATH; fall back to the full system path.
rem If PATH misses it the window closes instantly, so we pause on failure.
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
  echo [start failed] exit code %EXITCODE%
  echo See the PowerShell error above. Common causes:
  echo   1. Missing powershell.exe, node or npm - check PATH
  echo   2. Port already in use - pick another one or close the owner
  echo   3. Product config missing
  echo Backup scripts: scripts\start.cmd.bak-20261028 / start.ps1.bak-20261028
  pause
)
endlocal & exit /b %EXITCODE%
