@echo off
setlocal

rem Packaged terminal entry point. The installed Maestro.exe contains the
rem Electron runtime, so no external Node/npm/tsx installation is required.
set "MAESTRO_CLI_MODE=packaged"
set "MAESTRO_RUNTIME_MODE=packaged"
if not defined MAESTRO_DATA_DIR set "MAESTRO_DATA_DIR=%APPDATA%\Maestro"
set "MAESTRO_RUNTIME_ROOT=%~dp0resources\app"
set "ELECTRON_RUN_AS_NODE=1"

"%~dp0Maestro.exe" "%~dp0resources\app\dist\cli\index.js" %*
set "exitCode=%ERRORLEVEL%"
endlocal & exit /b %exitCode%
