@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo FIRE EVACUATION AND CROWD SIMULATION SYSTEM
echo Building 1 - Suankularb Wittayalai Rangsit
echo ============================================================
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm was not found. Please install Node.js first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)
echo Starting development server...
call npm run dev
if errorlevel 1 goto :error
exit /b 0
:error
echo The application could not start. Review the error above.
pause
exit /b 1
