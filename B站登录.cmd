@echo off
setlocal
chcp 65001 >nul
set "PYTHONHOME=%~dp0runtime\python311"
set "PYTHONPATH=%~dp0runtime\python311\Lib\site-packages"
set "PYTHONNOUSERSITE=1"
set "BILI_DUTY_HOME=%~dp0data\bili"
set "TEMP=%~dp0data\runtime\tmp"
set "TMP=%~dp0data\runtime\tmp"
if not exist "%TEMP%" mkdir "%TEMP%"
"%~dp0runtime\python311\python.exe" "%~dp0tools\bili-login.py"
pause
