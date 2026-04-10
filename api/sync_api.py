# -*- coding: utf-8 -*-
"""
数据同步 API：用户偏好存取 + 同步执行（SSE 推送进度）。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()

PREFS_FILE = Path("data/sync_preferences.json")
PROJECT_ROOT = Path(__file__).resolve().parent.parent

_sync_lock = threading.Lock()
_sync_status: dict = {"status": "idle", "message": "", "percent": 0, "phase": ""}

# 进度正则
_RE_FETCH  = re.compile(r"\[([^\]]+)\].*?进度\s+(\d+)/(\d+)\s+\(([\d.]+)%\)")
_RE_PATCH  = re.compile(r"进度\s+(\d+)/(\d+)\s+\(([\d.]+)%\)")


# ── 偏好 ──────────────────────────────────────────────────────

class SyncPreferences(BaseModel):
    symbols: list[str] = []
    intervals: list[str] = ["1h"]


def _load_prefs() -> dict:
    if not PREFS_FILE.exists():
        return {"symbols": [], "intervals": ["1h"]}
    try:
        return json.loads(PREFS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"symbols": [], "intervals": ["1h"]}


def _save_prefs(prefs: dict) -> None:
    PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PREFS_FILE.write_text(
        json.dumps(prefs, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/sync/preferences")
def get_preferences():
    return _load_prefs()


@router.put("/sync/preferences")
def save_preferences(body: SyncPreferences):
    prefs = body.model_dump()
    _save_prefs(prefs)
    return prefs


# ── 同步执行（后台线程 + SSE） ─────────────────────────────────

def _run_subprocess_with_progress(
    cmd: list[str],
    phase_name: str,
    progress_re: re.Pattern,
    phase_mapper=None,
) -> tuple[int, str]:
    global _sync_status
    err_lines: list[str] = []

    def _read(stream):
        for line in stream:
            err_lines.append(line)
            m = progress_re.search(line)
            if not m:
                continue
            if phase_mapper:
                phase = phase_mapper(m.group(1))
                cur, tot, pct = int(m.group(2)), int(m.group(3)), float(m.group(4))
            else:
                phase = phase_name
                cur, tot, pct = int(m.group(1)), int(m.group(2)), float(m.group(3))
            with _sync_lock:
                _sync_status.update({
                    "message": f"{phase} {cur}/{tot} ({pct:.1f}%)",
                    "phase": phase, "current": cur, "total": tot, "percent": pct,
                })

    proc = subprocess.Popen(
        cmd, cwd=str(PROJECT_ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    t = threading.Thread(target=_read, args=(proc.stderr,), daemon=True)
    t.start()
    try:
        proc.wait(timeout=3600)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return -1, "同步超时"
    t.join(timeout=2)
    return proc.returncode, "".join(err_lines)


def _parse_fetch_phase(label: str) -> str:
    if "首轮" in label or "重试" in label:
        for iv in ("1h", "4h", "1d"):
            if label.startswith(iv):
                return f"拉取 {iv} K 线"
        return "拉取 K 线"
    return "拉取数据"


def _run_sync_background(prefs: dict) -> None:
    global _sync_status

    with _sync_lock:
        if _sync_status.get("status") == "running":
            return
        _sync_status = {
            "status": "running", "message": "正在从 Binance 拉取数据…",
            "phase": "拉取数据", "current": 0, "total": 0, "percent": 0,
        }

    try:
        # 构建 fetch_klines.py 的参数（symbols 和 intervals）
        extra_args: list[str] = []
        symbols = prefs.get("symbols", [])
        intervals = prefs.get("intervals", ["1h"])
        if symbols:
            extra_args += ["--symbols"] + symbols
        if intervals:
            extra_args += ["--intervals"] + intervals

        code, err = _run_subprocess_with_progress(
            [sys.executable, "fetch_klines.py"] + extra_args,
            phase_name="拉取 K 线",
            progress_re=_RE_FETCH,
            phase_mapper=_parse_fetch_phase,
        )
        if code != 0:
            with _sync_lock:
                _sync_status = {"status": "error",
                                "message": "fetch_klines 失败: " + (err or str(code))[:200]}
            return

        with _sync_lock:
            _sync_status.update({
                "message": "正在更新技术指标…", "phase": "更新技术指标",
                "current": 0, "total": 0, "percent": 0,
            })

        code, err = _run_subprocess_with_progress(
            [sys.executable, "patch_klines_indicators.py"],
            phase_name="更新技术指标",
            progress_re=_RE_PATCH,
        )
        if code != 0:
            with _sync_lock:
                _sync_status = {"status": "error",
                                "message": "patch_klines 失败: " + (err or str(code))[:200]}
            return

        with _sync_lock:
            _sync_status = {"status": "done", "message": "数据同步完成",
                            "percent": 100, "phase": "完成"}
    except Exception as e:
        with _sync_lock:
            _sync_status = {"status": "error", "message": str(e)[:200]}


def _sse_event(data: dict) -> str:
    import json as _json
    return f"data: {_json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/sync/run")
def run_sync():
    with _sync_lock:
        if _sync_status.get("status") == "running":
            raise HTTPException(409, "同步正在运行中")

    prefs = _load_prefs()
    t = threading.Thread(target=_run_sync_background, args=(prefs,), daemon=True)
    t.start()

    def _stream():
        yield _sse_event({"type": "start", "message": "同步开始"})
        while True:
            time.sleep(0.8)
            with _sync_lock:
                st = dict(_sync_status)
            if st["status"] == "running":
                yield _sse_event({
                    "type": "progress",
                    "phase": st.get("phase", ""),
                    "current": st.get("current", 0),
                    "total": st.get("total", 0),
                    "percent": st.get("percent", 0),
                    "message": st.get("message", ""),
                })
            elif st["status"] == "done":
                yield _sse_event({"type": "done", "message": "数据同步完成"})
                break
            elif st["status"] == "error":
                yield _sse_event({"type": "error", "message": st.get("message", "未知错误")})
                break

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
