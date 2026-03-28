@echo off
chcp 65001 >nul
cd /d %~dp0
echo 启动工具管理服务...
start /b cmd /c "chcp 65001 >nul && npm start"
timeout /t 3 /nobreak >nul
start http://localhost:3070
echo 服务已启动，浏览器将自动打开
