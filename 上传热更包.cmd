@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MyTV hot-update upload

where node >nul 2>nul
if errorlevel 1 goto nonode

node "scripts\ops\hu-upload.mjs" %*
set RC=%errorlevel%
echo.
if not "%RC%"=="0" echo [FAILED] exit code %RC%
goto done

:nonode
echo [X] Node.js not found in PATH.
echo     Install Node.js, or run this manually:
echo         node scripts\ops\hu-upload.mjs

:done
echo.
if "%NOPAUSE%"=="" pause >nul
