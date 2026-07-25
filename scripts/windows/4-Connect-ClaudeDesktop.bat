@echo off
REM Double-click entry point: register LightsOut in Claude Desktop (MC-01, SU-09).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-ClaudeDesktop.ps1"
pause
