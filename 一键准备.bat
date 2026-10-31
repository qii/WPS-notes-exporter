@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WPS 便签自动导出助手

python -B local_receiver.py
if %errorlevel% neq 0 (
    echo.
    echo ----------------------------------------------------
    echo [提示] 启动失败，请检查是否已安装 Python 3 环境。
    echo ----------------------------------------------------
    pause
)
