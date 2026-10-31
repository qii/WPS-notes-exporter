@echo off
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
chcp 65001 >nul
cd /d "%~dp0"
title WPS Notes Exporter

where python >nul 2>nul
if errorlevel 1 (
    cls
    echo ========================================================
    echo  [Error] Python 3 was not found!
    echo  Please install Python 3 from https://www.python.org
    echo ========================================================
    echo.
    pause
    exit /b 1
)

python -B local_receiver.py
if errorlevel 1 (
    echo.
    pause
)
