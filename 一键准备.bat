@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
title WPS便签爬取 - 一键准备助手

echo ========================================================
echo          WPS 便签自动导出 - 一键准备助手
echo ========================================================
echo.

echo [1/2] 正在将导出脚本 (wps_scraper_snippet.js) 复制到剪贴板...
powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0wps_scraper_snippet.js' -Raw -Encoding UTF8 | Set-Clipboard"
if %errorlevel% equ 0 (
    echo       √ 复制成功！去浏览器 F12 控制台直接按 Ctrl+V 即可粘贴。
) else (
    echo       × 复制失败，请手动打开 wps_scraper_snippet.js 复制。
)
echo.

echo [2/2] 正在检查并启动本地接收服务 (端口 8765)...
netstat -ano | findstr ":8765 " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo       √ 检测到 8765 端口已有接收服务在运行，无需重复启动！
    echo.
    echo ========================================================
    echo  现在请前往 WPS 便签网页版 ^(https://note.wps.cn^)：
    echo  按 F12 打开控制台 ^(Console^)，按 Ctrl+V 粘贴并回车！
    echo ========================================================
    echo.
    pause
    exit /b 0
)

echo       正在启动 local_receiver.py（爬取完成前请勿关闭此窗口）...
echo ========================================================
echo  现在请前往 WPS 便签网页版 ^(https://note.wps.cn^)：
echo  按 F12 打开控制台 ^(Console^)，按 Ctrl+V 粘贴并回车！
echo ========================================================
echo.

python -B local_receiver.py
pause
