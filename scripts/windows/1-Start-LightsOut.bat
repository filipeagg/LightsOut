@echo off
REM Double-click entry point: start LightsOut (SU-02).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LightsOut.ps1" %*
if errorlevel 1 pause
