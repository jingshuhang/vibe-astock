@echo off
:: Vibe AStock launcher. ASCII-only + CRLF on purpose: CMD reads .bat under cp936,
:: so UTF-8 Chinese comments get misdecoded and can turn a rem line into a fake command.
:: The Chinese explanation lives in README, "install and start".
cd /d "C:/Users/51092/WorkBuddy/2026-10-26-10-53-21/vibe-astock"

:: Clear proxy vars so local 127.0.0.1 requests are not intercepted
set http_proxy=
set https_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set NO_PROXY=*
set no_proxy=*

:: Read the Agnes AI API key from WorkBuddy models.json.
:: Use the USERPROFILE env var, not PowerShell-style env syntax: cmd expands it
:: before the for /f call; otherwise the key is empty and the AI source fails.
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content '%USERPROFILE%\.workbuddy\models.json' | ConvertFrom-Json) | Where-Object { $_.id -eq 'custom-local:agnes-2.5-flash' } | Select-Object -ExpandProperty apiKey"') do set AGNES_API_KEY=%%i
if not defined AGNES_API_KEY echo [warn] AGNES_API_KEY not set; AI source unavailable. Check USERPROFILE\.workbuddy\models.json for id=custom-local:agnes-2.5-flash

:: Start services
call scripts\start.cmd
