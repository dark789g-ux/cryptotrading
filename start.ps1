# -*- coding: utf-8 -*-
# CryptoTrading 快速启动脚本
# 用法：右键 -> 用 PowerShell 运行，或在终端执行 .\start.ps1

$root = $PSScriptRoot

Write-Host "[1/3] 启动后端 (uvicorn :8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; uvicorn main:app --host 0.0.0.0 --port 8000 --reload" -WindowStyle Normal

Write-Host "[2/3] 启动前端 (npm run dev)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev" -WindowStyle Normal

Write-Host "[3/3] 等待服务就绪..." -ForegroundColor Yellow
Start-Sleep -Seconds 4

Write-Host "自动打开浏览器: http://localhost:8000" -ForegroundColor Green
Start-Process "http://localhost:8000"

Write-Host "启动完成。关闭此窗口不影响后端和前端进程。" -ForegroundColor Green
