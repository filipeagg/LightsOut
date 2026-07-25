@echo off
REM Double-click entry point: connect the Codex engine (RT-04).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-Engine.ps1" -Engine codex
pause
