@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node\node.exe" (
  echo Missing bundled Node runtime.
  pause
  exit /b 1
)
if not exist "dist\host\main.js" (
  echo Missing production build. Please build the project first.
  pause
  exit /b 1
)
"runtime\node\node.exe" "dist\host\main.js"
if errorlevel 1 pause
endlocal
