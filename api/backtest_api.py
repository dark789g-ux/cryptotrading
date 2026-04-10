# -*- coding: utf-8 -*-
"""
策略管理 CRUD + 回测执行（SSE 推送进度）。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backtest.config import BacktestConfig

router = APIRouter()

STRATEGIES_FILE = Path("data/strategies.json")
STRATEGY_TYPES = [
    {"id": "ma_kdj", "name": "MA+KDJ 超卖策略"},
]

# 每个策略的回测运行状态 {strategy_id: {...}}
_run_status: dict[str, dict] = {}
_run_lock = threading.Lock()


# ── 数据模型 ──────────────────────────────────────────────────

class StrategyParams(BaseModel):
    initial_capital: float = 1000000.0
    position_ratio: float = 0.40
    max_positions: int = 2
    timeframe: str = "1h"
    date_start: str
    date_end: str
    ma_periods: list[int] = Field(default_factory=lambda: [30, 60, 120, 240])
    kdj_k_max: float = 200.0
    kdj_d_max: float = 200.0
    kdj_j_max: float = 0.0
    stop_loss_factor: float = 1.0
    enable_partial_profit: bool = False
    max_init_loss: float = 0.01
    min_risk_reward_ratio: float = 4.0
    cooldown_hours: int = 2
    consecutive_losses_threshold: int = 2
    base_cooldown_candles: int = 1
    max_cooldown_candles: int = 10000
    consecutive_losses_reduce_on_profit: int = 2
    warmup_bars: int = 240
    max_backtest_bars: int = 10000
    lookback_buffer: int = 50
    min_open_cash: float = 100.0


class StrategyCreate(BaseModel):
    name: str = ""
    type: str = "ma_kdj"
    params: StrategyParams


class StrategyUpdate(BaseModel):
    name: str | None = None
    type: str | None = None
    params: StrategyParams | None = None


# ── 文件读写 ──────────────────────────────────────────────────

def _load_strategies() -> list[dict]:
    if not STRATEGIES_FILE.exists():
        return []
    try:
        return json.loads(STRATEGIES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_strategies(strategies: list[dict]) -> None:
    STRATEGIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    STRATEGIES_FILE.write_text(
        json.dumps(strategies, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _find_strategy(strategies: list[dict], strategy_id: str) -> tuple[int, dict | None]:
    for i, s in enumerate(strategies):
        if s["id"] == strategy_id:
            return i, s
    return -1, None


# ── CRUD 路由 ──────────────────────────────────────────────────

@router.get("/strategy-types")
def get_strategy_types():
    return STRATEGY_TYPES


@router.get("/strategies")
def list_strategies():
    return _load_strategies()


@router.post("/strategies", status_code=201)
def create_strategy(body: StrategyCreate):
    strategies = _load_strategies()
    now = datetime.now().isoformat(timespec="seconds")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # 自动生成名称
    type_names = {t["id"]: t["name"] for t in STRATEGY_TYPES}
    type_label = type_names.get(body.type, body.type)
    count = sum(1 for s in strategies if s.get("type") == body.type) + 1
    auto_name = f"{type_label}_{ts}_{count}"

    strategy: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": body.name or auto_name,
        "type": body.type,
        "created_at": now,
        "params": body.params.model_dump(),
        "last_backtest_at": None,
        "last_backtest_return": None,
    }
    strategies.append(strategy)
    _save_strategies(strategies)
    return strategy


@router.put("/strategies/{strategy_id}")
def update_strategy(strategy_id: str, body: StrategyUpdate):
    strategies = _load_strategies()
    idx, strategy = _find_strategy(strategies, strategy_id)
    if strategy is None:
        raise HTTPException(404, "策略不存在")

    if body.name is not None:
        strategy["name"] = body.name
    if body.type is not None:
        strategy["type"] = body.type
    if body.params is not None:
        strategy["params"] = body.params.model_dump()

    strategies[idx] = strategy
    _save_strategies(strategies)
    return strategy


@router.delete("/strategies/{strategy_id}", status_code=204)
def delete_strategy(strategy_id: str):
    strategies = _load_strategies()
    idx, strategy = _find_strategy(strategies, strategy_id)
    if strategy is None:
        raise HTTPException(404, "策略不存在")
    strategies.pop(idx)
    _save_strategies(strategies)


@router.get("/backtest/{strategy_id}/result")
def get_backtest_result(strategy_id: str):
    strategies = _load_strategies()
    _, strategy = _find_strategy(strategies, strategy_id)
    if strategy is None:
        raise HTTPException(404, "策略不存在")
    if not strategy.get("last_backtest_at"):
        raise HTTPException(404, "尚未执行过回测")

    result_file = strategy.get("last_result_file")
    if result_file and Path(result_file).exists():
        return json.loads(Path(result_file).read_text(encoding="utf-8"))
    raise HTTPException(404, "回测结果文件不存在")


# ── 回测 SSE ──────────────────────────────────────────────────

def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _run_backtest_thread(strategy_id: str, cfg: BacktestConfig, params: dict) -> None:
    """在后台线程中执行回测，通过 _run_status 共享进度。"""
    import backtest_strategy as bs

    def _cb(cur, tot, pct, phase):
        with _run_lock:
            _run_status[strategy_id].update({
                "current": cur, "total": tot,
                "percent": round(pct, 1), "phase": phase,
            })

    with _run_lock:
        _run_status[strategy_id] = {
            "status": "running", "percent": 0, "phase": "准备中",
            "current": 0, "total": 0, "error": None, "result": None,
        }

    try:
        result = bs.run(cfg, progress_cb=_cb)

        # 更新策略的最近回测信息
        strategies = _load_strategies()
        idx, strategy = _find_strategy(strategies, strategy_id)
        if strategy is not None:
            now = datetime.now().isoformat(timespec="seconds")
            run_id = result.get("run_id", "")
            result_file = f"backtest_results/{run_id}/report_data.json" if run_id else ""
            strategy["last_backtest_at"] = now
            strategy["last_backtest_return"] = result.get("last_backtest_return")
            strategy["last_result_file"] = result_file
            strategies[idx] = strategy
            _save_strategies(strategies)

        with _run_lock:
            _run_status[strategy_id].update({
                "status": "done", "percent": 100,
                "phase": "完成", "result": result,
            })
    except Exception as e:
        with _run_lock:
            _run_status[strategy_id].update({
                "status": "error", "error": str(e), "percent": 100,
            })


@router.post("/backtest/{strategy_id}/run")
def run_backtest_sse(strategy_id: str):
    strategies = _load_strategies()
    _, strategy = _find_strategy(strategies, strategy_id)
    if strategy is None:
        raise HTTPException(404, "策略不存在")

    with _run_lock:
        cur = _run_status.get(strategy_id, {})
        if cur.get("status") == "running":
            raise HTTPException(409, "回测正在运行中")

    params = strategy["params"]
    cfg = BacktestConfig(**params)

    t = threading.Thread(
        target=_run_backtest_thread,
        args=(strategy_id, cfg, params),
        daemon=True,
    )
    t.start()

    def _stream():
        yield _sse_event({"type": "start", "message": "回测开始"})
        while True:
            time.sleep(0.5)
            with _run_lock:
                st = dict(_run_status.get(strategy_id, {}))
            if not st:
                break

            if st["status"] == "running":
                yield _sse_event({
                    "type": "progress",
                    "phase": st.get("phase", ""),
                    "current": st.get("current", 0),
                    "total": st.get("total", 0),
                    "percent": st.get("percent", 0),
                })
            elif st["status"] == "done":
                yield _sse_event({"type": "done", "message": "回测完成"})
                break
            elif st["status"] == "error":
                yield _sse_event({"type": "error", "message": st.get("error", "未知错误")})
                break

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
