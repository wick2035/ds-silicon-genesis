@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node\node.exe" (
  echo 缺少随包 Node 运行时。
  pause
  exit /b 1
)
if not exist "dist\host\main.js" (
  echo 缺少生产构建，请先运行构建。
  pause
  exit /b 1
)
"runtime\node\node.exe" "dist\host\main.js"
if errorlevel 1 pause
endlocal
