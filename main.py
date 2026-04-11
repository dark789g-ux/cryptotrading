# -*- coding: utf-8 -*-
"""
FastAPI 入口：托管静态前端 + 挂载所有 API 路由。

启动方式：
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

访问：http://localhost:8000
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.symbols import router as symbols_router
from api.backtest_api import router as backtest_router
from api.sync_api import router as sync_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

app = FastAPI(title="CryptoTrading", version="2.0.0")

# ── API 路由 ──────────────────────────────────────────────────
app.include_router(symbols_router, prefix="/api")
app.include_router(backtest_router, prefix="/api")
app.include_router(sync_router, prefix="/api")

# ── 静态文件（前端构建产物）────────────────────────────────────
DIST_DIR = Path("frontend/dist")

if DIST_DIR.exists():
    from fastapi.responses import FileResponse
    
    # 先挂载静态文件目录
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")
    
    # 前端路由处理：所有非 API 路由返回 index.html
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # API 路由不走这里
        if full_path.startswith("api/"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Not Found")
        
        index_file = DIST_DIR / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file))
        return {"message": "前端未构建"}
else:
    from fastapi.responses import JSONResponse

    @app.get("/")
    def root():
        return JSONResponse(
            {"message": "前端未构建，请运行: cd frontend && npm install && npm run build"}
        )
