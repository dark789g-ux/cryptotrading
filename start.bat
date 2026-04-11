@echo off
chcp 65001 >nul
title CryptoTrading 启动器

echo [1/3] 启动后端 (uvicorn :8000)...
start "CryptoTrading - Backend" cmd /k "uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

echo [2/3] 启动前端 (npm run dev)...
start "CryptoTrading - Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo [3/3] 等待服务就绪，稍后自动打开浏览器...
timeout /t 4 /nobreak >nul
start http://localhost:5173

echo 启动完成。关闭此窗口不影响后端和前端进程。
