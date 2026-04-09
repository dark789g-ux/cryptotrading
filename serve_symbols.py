# -*- coding: utf-8 -*-
"""
标的数据展示服务

从项目根目录启动 HTTP 服务，提供 symbols.html 及 K 线数据 API。
标的列表从 cache/{interval}_klines/ 目录扫描，K 线数据从对应 CSV 读取。

用法：
    python serve_symbols.py

配置写在脚本顶部，不使用 argparse。
"""

from __future__ import annotations

import http.server
import json
import re
import subprocess
import sys
import socketserver
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

# 项目根目录（用于 subprocess 工作目录）
PROJECT_ROOT = Path(__file__).resolve().parent

# ══════════════════════════════════════════════════════════════
#  配置
# ══════════════════════════════════════════════════════════════

PORT = 8889  # 与 serve_report.py(8888) 区分，可同时运行
SERVE_DIR = Path(".")
CACHE_DIR = Path("cache")
HTML_FILE = "symbols.html"

# 支持的 K 线周期及对应目录
INTERVALS = {
    "1h": CACHE_DIR / "1h_klines",
    "4h": CACHE_DIR / "4h_klines",
    "1d": CACHE_DIR / "1d_klines",
}

# 策略筛选：多线程并发数
STRATEGY_MAX_WORKERS = 8

# 可用策略列表（id 对应 API 参数 strategy 的值）
STRATEGIES = [
    {"id": "", "name": "无"},
    {"id": "jdj_ma", "name": "KDJ超卖+均线多头"},
]


def _get_last_row_indicators(path: Path) -> tuple[float | None, float | None]:
    """从 CSV 最后一行读取 stop_loss_pct、risk_reward_ratio。"""
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
        if df.empty:
            return None, None
        row = df.iloc[-1]
        sl = pd.to_numeric(row.get("stop_loss_pct"), errors="coerce")
        rr = pd.to_numeric(row.get("risk_reward_ratio"), errors="coerce")
        return (float(sl) if pd.notna(sl) else None), (float(rr) if pd.notna(rr) else None)
    except Exception:
        return None, None


def _check_strategy_jdj_ma(path: Path) -> tuple[bool, float | None, float | None]:
    """
    检查标的最后一根 K 线是否满足策略条件：
    1. KDJ.J < 10
    2. 收盘价 > MA60
    3. MA30 > MA60
    4. MA60 > MA120
    返回 (是否通过, stop_loss_pct, risk_reward_ratio)
    """
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
        if df.empty:
            return False, None, None
        row = df.iloc[-1]
        j = pd.to_numeric(row.get("KDJ.J"), errors="coerce")
        close = pd.to_numeric(row.get("close"), errors="coerce")
        ma30 = pd.to_numeric(row.get("MA30"), errors="coerce")
        ma60 = pd.to_numeric(row.get("MA60"), errors="coerce")
        ma120 = pd.to_numeric(row.get("MA120"), errors="coerce")
        sl = pd.to_numeric(row.get("stop_loss_pct"), errors="coerce")
        rr = pd.to_numeric(row.get("risk_reward_ratio"), errors="coerce")
        if pd.isna(j) or pd.isna(close) or pd.isna(ma30) or pd.isna(ma60) or pd.isna(ma120):
            return False, None, None
        ok = j < 10 and close > ma60 and ma30 > ma60 and ma60 > ma120
        return ok, (float(sl) if pd.notna(sl) else None), (float(rr) if pd.notna(rr) else None)
    except Exception:
        return False, None, None


# 策略 id -> 检查函数（便于后续扩展，新增策略时在此注册）
STRATEGY_CHECKERS: dict[str, object] = {
    "jdj_ma": _check_strategy_jdj_ma,
}

# 数据同步状态（idle | running | done | error）
# 扩展字段：phase, current, total, percent 用于前端展示进度
_sync_lock = threading.Lock()
_sync_status: dict = {"status": "idle", "message": ""}

# fetch_klines 日志格式: [1h·首轮] 进度 50/200 (25.0%) 等
_RE_FETCH_PROGRESS = re.compile(r"\[([^\]]+)\].*?进度\s+(\d+)/(\d+)\s+\(([\d.]+)%\)")
# patch_klines 日志格式: 进度 50/300 (16.7%)
_RE_PATCH_PROGRESS = re.compile(r"进度\s+(\d+)/(\d+)\s+\(([\d.]+)%\)")


def _parse_fetch_phase(label: str) -> str:
    """将 fetch_klines 的 label 转为可读阶段名。"""
    if "首轮" in label or "重试" in label:
        for iv in ("1h", "4h", "1d"):
            if label.startswith(iv):
                return f"拉取 {iv} K 线"
        return "拉取 K 线"
    return "拉取数据"


def _run_subprocess_with_progress(
    cmd: list[str],
    phase_name: str,
    progress_re: re.Pattern,
    phase_mapper: callable | None = None,
) -> tuple[int, str]:
    """
    运行子进程并实时解析 stderr 中的进度，更新 _sync_status。
    返回 (returncode, error_message_or_empty)
    """
    global _sync_status
    err_lines: list[str] = []

    def read_stderr(stream):
        for line in stream:
            err_lines.append(line)
            m = progress_re.search(line)
            if m:
                if phase_mapper:
                    phase = phase_mapper(m.group(1))
                    current, total, percent = int(m.group(2)), int(m.group(3)), float(m.group(4))
                else:
                    phase = phase_name
                    current, total, percent = int(m.group(1)), int(m.group(2)), float(m.group(3))
                msg = f"{phase} {current}/{total} ({percent:.1f}%)"
                with _sync_lock:
                    _sync_status.update({
                        "message": msg,
                        "phase": phase,
                        "current": current,
                        "total": total,
                        "percent": percent,
                    })

    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    t = threading.Thread(target=read_stderr, args=(proc.stderr,), daemon=True)
    t.start()
    try:
        proc.wait(timeout=3600)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return -1, "同步超时"
    t.join(timeout=2)
    err_text = "".join(err_lines) if err_lines else ""
    return proc.returncode, err_text


def _run_sync_background() -> None:
    """后台执行：从 Binance 拉取 K 线 → 补充技术指标。实时解析子进程进度。"""
    global _sync_status
    with _sync_lock:
        if _sync_status["status"] == "running":
            return
        _sync_status = {
            "status": "running",
            "message": "正在从 Binance 拉取数据…",
            "phase": "",
            "current": 0,
            "total": 0,
            "percent": 0,
        }

    try:
        # 1. 从 Binance 拉取 K 线
        code, err = _run_subprocess_with_progress(
            [sys.executable, "fetch_klines.py"],
            phase_name="拉取 K 线",
            progress_re=_RE_FETCH_PROGRESS,
            phase_mapper=_parse_fetch_phase,
        )
        if code != 0:
            with _sync_lock:
                _sync_status = {"status": "error", "message": "fetch_klines 失败: " + (err or str(code))[:200]}
            return

        # 2. 补充技术指标
        with _sync_lock:
            _sync_status.update({
                "message": "正在更新技术指标…",
                "phase": "更新技术指标",
                "current": 0,
                "total": 0,
                "percent": 0,
            })
        code, err = _run_subprocess_with_progress(
            [sys.executable, "patch_klines_indicators.py"],
            phase_name="更新技术指标",
            progress_re=_RE_PATCH_PROGRESS,
            phase_mapper=None,
        )
        if code != 0:
            with _sync_lock:
                _sync_status = {"status": "error", "message": "patch_klines_indicators 失败: " + (err or str(code))[:200]}
            return

        with _sync_lock:
            _sync_status = {"status": "done", "message": "数据同步完成", "percent": 100}
    except Exception as e:
        with _sync_lock:
            _sync_status = {"status": "error", "message": str(e)[:200]}


# ══════════════════════════════════════════════════════════════
#  HTTP Handler
# ══════════════════════════════════════════════════════════════


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR.resolve()), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/intervals":
            self._serve_intervals()
        elif self.path == "/api/strategies":
            self._serve_strategies()
        elif self.path == "/api/sync/status":
            self._serve_sync_status()
        elif self.path.startswith("/api/symbols"):
            self._serve_symbols()
        elif self.path.startswith("/api/klines/"):
            self._serve_klines()
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/sync":
            self._serve_sync_start()
        else:
            self.send_error(404, "Not Found")

    def _serve_json(self, data: dict | list) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_intervals(self) -> None:
        """返回可用的 K 线周期列表。"""
        items = [
            {"id": "1h", "name": "1 小时"},
            {"id": "4h", "name": "4 小时"},
            {"id": "1d", "name": "日线"},
        ]
        self._serve_json(items)

    def _serve_strategies(self) -> None:
        """返回可用的策略列表。"""
        self._serve_json(STRATEGIES)

    def _serve_sync_status(self) -> None:
        """GET /api/sync/status 返回当前同步状态。"""
        with _sync_lock:
            data = dict(_sync_status)
        self._serve_json(data)

    def _serve_sync_start(self) -> None:
        """POST /api/sync 启动后台数据同步（从 Binance 拉取 + 更新指标）。"""
        with _sync_lock:
            if _sync_status["status"] == "running":
                self._serve_json({"status": "running", "message": "同步已在执行中"})
                return
        t = threading.Thread(target=_run_sync_background, daemon=True)
        t.start()
        self._serve_json({"status": "running", "message": "同步已开始"})

    def _serve_symbols(self) -> None:
        """从 query 解析 interval，扫描对应目录返回标的列表。支持 strategy=jdj_ma 策略筛选。"""
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        interval = (params.get("interval", ["1d"]) or ["1d"])[0]
        strategy = (params.get("strategy", [""]) or [""])[0]

        if interval not in INTERVALS:
            self.send_error(400, f"不支持的周期: {interval}")
            return

        klines_dir = SERVE_DIR / INTERVALS[interval]
        if not klines_dir.exists():
            self._serve_json([])
            return

        suffix = f"_{interval}.csv"
        all_files = sorted(klines_dir.glob("*" + suffix))
        candidates = [(f, f.stem.replace(f"_{interval}", "")) for f in all_files if f.is_file()]

        def _build_item(sym: str, sl: float | None, rr: float | None) -> dict:
            return {"symbol": sym, "interval": interval, "stop_loss_pct": sl, "risk_reward_ratio": rr}

        checker = STRATEGY_CHECKERS.get(strategy) if strategy else None
        if checker:
            filtered = []
            with ThreadPoolExecutor(max_workers=STRATEGY_MAX_WORKERS) as ex:
                futures = {ex.submit(checker, f): (f, sym) for f, sym in candidates}
                for fut in as_completed(futures):
                    res = fut.result()
                    path, sym = futures[fut]
                    if isinstance(res, tuple):
                        passed, sl, rr = res[0], res[1] if len(res) > 1 else None, res[2] if len(res) > 2 else None
                    else:
                        passed, sl, rr = bool(res), None, None
                        if passed:
                            sl, rr = _get_last_row_indicators(path)
                    if passed:
                        filtered.append(_build_item(sym, sl, rr))
            symbols = sorted(filtered, key=lambda x: x["symbol"])
        else:
            with ThreadPoolExecutor(max_workers=STRATEGY_MAX_WORKERS) as ex:
                futures = {ex.submit(_get_last_row_indicators, f): (f, sym) for f, sym in candidates}
                symbols = []
                for fut in as_completed(futures):
                    sl, rr = fut.result()
                    _, sym = futures[fut]
                    symbols.append(_build_item(sym, sl, rr))
            symbols = sorted(symbols, key=lambda x: x["symbol"])

        self._serve_json(symbols)

    def _serve_klines(self) -> None:
        """GET /api/klines/{interval}/{symbol}.csv 返回 K 线 CSV。"""
        from urllib.parse import unquote

        parts = [p for p in self.path.split("/") if p]
        if len(parts) < 4:
            self.send_error(400, "路径格式: /api/klines/{interval}/{symbol}.csv")
            return

        # /api/klines/1d/BTCUSDT.csv -> interval=1d, symbol=BTCUSDT
        interval = parts[2]
        filename = parts[3]
        if not filename.endswith(".csv"):
            self.send_error(400, "需要 .csv 后缀")
            return

        symbol = unquote(filename[:-4])
        if interval not in INTERVALS:
            self.send_error(400, f"不支持的周期: {interval}")
            return

        klines_dir = SERVE_DIR / INTERVALS[interval]
        path = klines_dir / f"{symbol}_{interval}.csv"
        if not path.exists():
            self.send_error(404, f"未找到: {symbol} ({interval})")
            return

        try:
            body = path.read_text(encoding="utf-8-sig")
        except Exception as e:
            self.send_error(500, str(e))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(body.encode("utf-8"))))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, fmt, *args) -> None:
        code = args[1] if len(args) > 1 else "?"
        if str(code) not in ("200", "304"):
            print(f"  [{code}] {args[0]}")


# ══════════════════════════════════════════════════════════════
#  入口
# ══════════════════════════════════════════════════════════════


def main() -> None:
    if sys.stdout.encoding != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    url = f"http://localhost:{PORT}/{HTML_FILE}"
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.TCPServer(("", PORT), _Handler) as httpd:
        print(f"标的数据服务已启动 → {url}")
        print("按 Ctrl+C 停止\n")
        print("API:")
        print("  GET  /api/intervals     → 可用周期列表")
        print("  GET  /api/strategies    → 可用策略列表")
        print("  POST /api/sync          → 启动数据同步（Binance 拉取 + 指标更新）")
        print("  GET  /api/sync/status   → 同步状态")
        print("  GET  /api/symbols?interval=1d&strategy=jdj_ma → 标的列表（策略筛选）")
        print("  GET  /api/klines/1d/BTCUSDT.csv → K 线 CSV")

        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止")


if __name__ == "__main__":
    main()
