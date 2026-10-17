@echo off
setlocal
cd /d "%~dp0"
title SKR Evacuation Simulator - Production Mode

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm are required.
  pause
  exit /b 1
)

echo Building the optimized production version...
call npm run build
if errorlevel 1 (
  echo Build failed. Review the message above.
  pause
  exit /b 1
)

echo Starting at http://127.0.0.1:4173/
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173/'"
call npm run start:performance
