@echo off
REM Legacy entry point (DESIGN 14.3b). Recent Claude Desktop builds manage MCP servers through
REM extensions and never read claude_desktop_config.json, so patching that file does nothing on
REM them. The documented path is installing lightsout.mcpb. This script stays for builds that do
REM still read the config file, behind a confirmation so nobody walks into it by counting to four.
echo.
echo   Connecting Claude Desktop is installing a file, not editing one.
echo.
echo   Install lightsout.mcpb: double-click it, drag it onto the Claude Desktop window,
echo   or Settings - Extensions - Advanced settings - Install Extension.
echo   In a clone it is dist\lightsout.mcpb; otherwise download it from the latest release:
echo   https://github.com/filipeagg/LightsOut/releases/latest
echo.
echo   This script instead patches claude_desktop_config.json, which recent builds ignore.
echo   Only older builds need it.
echo.
set /p answer=Patch the config file anyway? [y/N] 
if /i not "%answer%"=="y" (
  echo Nothing was changed.
  pause
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-ClaudeDesktop.ps1"
pause
