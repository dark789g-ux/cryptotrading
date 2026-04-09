# -*- coding: utf-8 -*-
"""
从币安 REST API 批量获取所有 USDT 交易对 K 线数据。

数据来源：cache/exchange_info.csv
输出：cache/{1h|4h|1d}_klines/（由 KLINE_INTERVAL 选择）

同步逻辑：
  - 通过 KLINE_INTERVAL 选择从 API 直接下载 1h / 4h / 1d K 线
  - 增量更新时回溯 UPDATE_LOOKBACK_DAYS 天以确保指标准确
"""

import csv
import sys
import time
import logging
import random
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from kline_indicators import (
    KLINE_COLUMNS, KLINE_OUTPUT_COLUMNS, ALL_OUTPUT_COLUMNS, calc_indicators,
)

if sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# ══════════════════════════════════════════════════════════════
#  运行配置
# ══════════════════════════════════════════════════════════════
# 下载周期：从 API 直接拉取对应 interval，写入 cache/{interval}_klines/
KLINE_INTERVAL: str          = "1h"     # "1h" | "4h" | "1d"

FORCE_REFRESH: bool          = False   # True = 重新下载该周期全部数据
KLINE_LIMIT: int             = 1000    # 单次 API 请求 K 线数量（最大 1000）
START_TIME: str | None       = "2024-01-01 00:00:00"  # 数据起始时间（UTC+8）
END_TIME: str | None         = None    # 数据截止时间（None = 当前时间）
MAX_WORKERS: int             = 8       # 并发线程数
REQUEST_DELAY: float         = 0.05   # 每次请求后的固定间隔（秒）
WEIGHT_SLOW_DOWN_THRESHOLD: int = 900 # 已用权重超过阈值时主动降速
MAX_RETRY_ROUNDS: int        = 3       # 最大重试轮数
RETRY_WORKERS: int           = 3       # 重试并发数
RETRY_ROUND_DELAY: float     = 5.0    # 每轮重试前等待时间（秒）
UPDATE_LOOKBACK_DAYS: int    = 30      # 增量更新时回溯天数

# ──────────────────────────── 内部常量 ────────────────────────────
BASE_URL          = "https://api.binance.com"
KLINES_ENDPOINT   = "/api/v3/klines"
_VALID_INTERVALS  = ("1h", "4h", "1d")
# 未指定时间范围时，各周期默认最多保留的根数（与历史跨度大致可比）
_DEFAULT_KLINES_LIMIT_BY_INTERVAL: dict[str, int] = {
    "1h": 10_000,
    "4h": 2_500,
    "1d": 1_000,
}
_INTERVAL_MS: dict[str, int] = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
}

CACHE_DIR         = Path(__file__).parent / "cache"
EXCHANGE_INFO_CSV = CACHE_DIR / "exchange_info.csv"
_INTERVAL_TO_DIR: dict[str, Path] = {
    "1h": CACHE_DIR / "1h_klines",
    "4h": CACHE_DIR / "4h_klines",
    "1d": CACHE_DIR / "1d_klines",
}
UTC8              = timezone(timedelta(hours=8))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger            = logging.getLogger(__name__)
_rate_semaphore   = threading.Semaphore(MAX_WORKERS)
_weight_lock      = threading.Lock()
_current_weight   = 0


# ──────────────────────────── 工具函数 ────────────────────────────
def _ms_to_utc8(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC8).strftime("%Y-%m-%d %H:%M:%S")


def _parse_time_to_ms(time_str: str | None) -> int | None:
    if time_str is None:
        return None
    try:
        dt = datetime.strptime(time_str.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC8)
        return int(dt.timestamp() * 1000)
    except ValueError:
        raise ValueError(f"无法解析时间格式：{time_str}，必须为 YYYY-MM-DD HH:MM:SS")


def _safe_get(url: str, params: dict, max_retries: int = 5) -> requests.Response:
    """带 429/418/451 处理与指数退避的 GET 请求，同时追踪已用权重。"""
    global _current_weight
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, params=params, timeout=30)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                requests.exceptions.ChunkedEncodingError) as exc:
            wait = 2 ** (attempt + 1) + random.uniform(0, 1)
            logger.warning("连接异常（%d/%d），%.1fs 后重试：%s", attempt+1, max_retries, wait, exc)
            time.sleep(wait)
            continue
        with _weight_lock:
            _current_weight = int(resp.headers.get("X-MBX-USED-WEIGHT-1M", 0))
        if _current_weight > WEIGHT_SLOW_DOWN_THRESHOLD:
            wait = 2.0 + random.uniform(0, 1)
            logger.warning("权重 %d 超阈值，降速 %.1fs", _current_weight, wait)
            time.sleep(wait)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
            logger.warning("触发限速(429)，等待 %ds（%d/%d）", wait, attempt+1, max_retries)
            time.sleep(wait)
            continue
        if resp.status_code == 418:
            raise RuntimeError(f"IP 已被封禁(418)，需等待 {resp.headers.get('Retry-After', 300)} 秒")
        if resp.status_code == 451:
            try:
                msg = resp.json().get("msg", "")
            except Exception:
                msg = resp.text[:200]
            raise RuntimeError(f"当前 IP 所在地区被 Binance 限制访问(451)：{msg}")
        resp.raise_for_status()
        return resp
    raise RuntimeError(f"请求失败，已重试 {max_retries} 次：{url} {params}")


# ──────────────────────────── 缓存工具 ────────────────────────────
def load_symbols() -> list[str]:
    """从 exchange_info.csv 读取所有 TRADING 状态的 USDT 交易对。"""
    if not EXCHANGE_INFO_CSV.exists():
        raise FileNotFoundError(f"缓存不存在：{EXCHANGE_INFO_CSV}\n请先运行 fetch_symbols.py")
    symbols = []
    with EXCHANGE_INFO_CSV.open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("status") == "TRADING" and row.get("quoteAsset") == "USDT":
                symbols.append(row["symbol"])
    logger.info("读取到 %d 个 TRADING USDT 交易对", len(symbols))
    return symbols


def _kline_cache_path(symbol: str, interval: str) -> Path:
    base = _INTERVAL_TO_DIR.get(interval)
    if base is None:
        raise ValueError(f"不支持的周期：{interval}")
    return base / f"{symbol}_{interval}.csv"


def _get_cache_last_time(symbol: str, interval: str) -> datetime | None:
    path = _kline_cache_path(symbol, interval)
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
            if not rows:
                return None
            return datetime.strptime(rows[-1]["open_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC8)
    except Exception:
        return None


def _load_existing_cache(symbol: str, interval: str) -> list[dict]:
    path = _kline_cache_path(symbol, interval)
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    except Exception:
        return []


def save_klines(symbol: str, rows: list[dict], interval: str) -> None:
    path = _kline_cache_path(symbol, interval)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=ALL_OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


# ──────────────────────────── K 线获取 ────────────────────────────
def fetch_klines(
    symbol: str,
    interval: str = "1h",
    start_time_ms: int | None = None,
    end_time_ms: int | None = None,
    total_limit: int | None = None,
) -> list[dict]:
    """分页从币安 API 获取指定 interval 的 K 线，计算指标后返回。"""
    iv_ms = _INTERVAL_MS.get(interval, _INTERVAL_MS["1h"])
    default_limit = _DEFAULT_KLINES_LIMIT_BY_INTERVAL.get(interval, _DEFAULT_KLINES_LIMIT_BY_INTERVAL["1h"])

    if total_limit is not None:
        target = total_limit
    elif start_time_ms is not None and end_time_ms is not None:
        target = max(1, (end_time_ms - start_time_ms) // iv_ms + 1)
    else:
        target = default_limit

    all_raw: list = []
    if start_time_ms is not None and end_time_ms is not None:
        cur = start_time_ms
        while len(all_raw) < target:
            need = min(KLINE_LIMIT, target - len(all_raw))
            batch = _safe_get(BASE_URL + KLINES_ENDPOINT, {
                "symbol": symbol, "interval": interval, "limit": need,
                "startTime": cur, "endTime": end_time_ms,
            }).json()
            if not batch: break
            all_raw.extend(batch)
            if len(batch) < need or int(batch[-1][0]) >= end_time_ms: break
            cur = int(batch[-1][0]) + iv_ms
            time.sleep(REQUEST_DELAY)
    else:
        cur = end_time_ms
        while len(all_raw) < target:
            need = min(KLINE_LIMIT, target - len(all_raw))
            params: dict = {"symbol": symbol, "interval": interval, "limit": need}
            if cur is not None: params["endTime"] = cur
            if start_time_ms is not None: params["startTime"] = start_time_ms
            batch = _safe_get(BASE_URL + KLINES_ENDPOINT, params).json()
            if not batch: break
            all_raw = batch + all_raw
            if len(batch) < need: break
            bs = int(batch[0][0])
            if start_time_ms is not None and bs <= start_time_ms: break
            cur = bs - 1
            time.sleep(REQUEST_DELAY)

    all_raw = all_raw[-target:]
    if start_time_ms: all_raw = [c for c in all_raw if int(c[0]) >= start_time_ms]
    if end_time_ms:   all_raw = [c for c in all_raw if int(c[0]) <= end_time_ms]

    rows = []
    for candle in all_raw:
        row = dict(zip(KLINE_COLUMNS, candle))
        out = {k: row[k] for k in KLINE_OUTPUT_COLUMNS}
        out["open_time"] = _ms_to_utc8(int(out["open_time"]))
        rows.append(out)
    calc_indicators(rows)
    return rows


# ──────────────────────────── 并发处理 ────────────────────────────
def _process_symbol(
    symbol: str, interval: str, force_flag: bool,
    progress: dict,
    start_time_ms: int | None, end_time_ms: int | None,
) -> tuple[str, str]:
    """拉取指定 interval 的 K 线，增量合并后保存。"""
    cap = _DEFAULT_KLINES_LIMIT_BY_INTERVAL.get(interval, _DEFAULT_KLINES_LIMIT_BY_INTERVAL["1h"])
    with _rate_semaphore:
        try:
            existing_rows: list[dict] = []
            fetch_start = start_time_ms
            if not force_flag and _kline_cache_path(symbol, interval).exists():
                existing_rows = _load_existing_cache(symbol, interval)
                if existing_rows:
                    last_time = _get_cache_last_time(symbol, interval)
                    if last_time:
                        last_time_ms = int(last_time.timestamp() * 1000)
                        if start_time_ms is None:
                            fetch_start = int((last_time - timedelta(days=UPDATE_LOOKBACK_DAYS)).timestamp() * 1000)
                        else:
                            fetch_start = min(start_time_ms, last_time_ms)

            rows = fetch_klines(symbol, interval, fetch_start, end_time_ms)

            if existing_rows and not force_flag:
                merged = {r["open_time"]: r for r in existing_rows}
                for r in rows:
                    merged[r["open_time"]] = r
                rows = [merged[t] for t in sorted(merged)]
                if len(rows) > cap:
                    rows = rows[-cap:]

            save_klines(symbol, rows, interval)
            time.sleep(REQUEST_DELAY)
            progress["done"] += 1
            return symbol, "ok"
        except Exception as exc:
            progress["done"] += 1
            progress["errors"] += 1
            return symbol, f"error: {exc}"


def _run_batch(
    symbols: list[str], workers: int, label: str, fn,
    start_time_ms: int | None, end_time_ms: int | None,
) -> list[tuple[str, str]]:
    """并发执行 fn(symbol, progress, start_ms, end_ms)，返回结果列表。"""
    total = len(symbols)
    progress = {"done": 0, "errors": 0}
    results: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fn, sym, progress, start_time_ms, end_time_ms): sym for sym in symbols}
        for future in as_completed(futures):
            sym, status = future.result()
            results.append((sym, status))
            done = progress["done"]
            if done % 20 == 0 or done == total:
                with _weight_lock: weight = _current_weight
                logger.info("[%s·首轮] %d/%d (%.1f%%) | 权重 %d/1200", label, done, total, done/total*100, weight)
    return results


def _run_with_retry(fn, symbols: list[str], start_ms, end_ms, label: str, workers: int) -> list[tuple[str, str]]:
    """首轮 + 多轮重试，返回全部结果。"""
    results = _run_batch(symbols, workers, f"{label}·首轮", fn, start_ms, end_ms)
    for i in range(1, MAX_RETRY_ROUNDS + 1):
        failed = [s for s, st in results if st.startswith("error")]
        if not failed: break
        logger.info("%s：%d 个失败，%.1fs 后重试第 %d/%d 轮", label, len(failed), RETRY_ROUND_DELAY, i, MAX_RETRY_ROUNDS)
        time.sleep(RETRY_ROUND_DELAY)
        results = [(s, st) for s, st in results if not st.startswith("error")]
        results.extend(_run_batch(failed, RETRY_WORKERS, f"{label}·重试{i}", fn, start_ms, end_ms))
    return results


# ──────────────────────────── 打印汇总 ────────────────────────────
def _print_summary(title: str, ok: int, skip: int, err: int, out_dir: Path, err_list: list = (), elapsed: float | None = None) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}完成")
    if elapsed is not None: print(f"  总耗时    : {elapsed:.1f} 秒")
    print(f"  成功      : {ok} 个")
    if skip: print(f"  跳过      : {skip} 个")
    print(f"  失败      : {err} 个")
    print(f"  输出目录  : {out_dir}")
    print(f"{'='*60}")
    if err_list:
        print("\n失败列表：")
        for sym, s in err_list: print(f"  {sym:<20} {s}")


# ──────────────────────────── 主逻辑 ────────────────────────────
def main() -> None:
    if KLINE_INTERVAL not in _VALID_INTERVALS:
        raise ValueError(f"KLINE_INTERVAL 必须是 {list(_VALID_INTERVALS)} 之一，当前为 {KLINE_INTERVAL!r}")

    out_dir = _INTERVAL_TO_DIR[KLINE_INTERVAL]
    symbols = load_symbols()
    out_dir.mkdir(parents=True, exist_ok=True)

    start_ms = _parse_time_to_ms(START_TIME)
    end_ms   = _parse_time_to_ms(END_TIME) or int(datetime.now(UTC8).timestamp() * 1000)
    logger.info("周期 %s | 时间范围：%s → %s (UTC+8)", KLINE_INTERVAL, START_TIME or "不限制", END_TIME or "当前时间")

    missing      = [s for s in symbols if not _kline_cache_path(s, KLINE_INTERVAL).exists()]
    need_refresh = [s for s in symbols if _kline_cache_path(s, KLINE_INTERVAL).exists()]
    ordered      = missing + need_refresh
    if missing:      logger.info("缺失缓存 %d 个，优先处理", len(missing))
    if need_refresh: logger.info("增量更新 %d 个", len(need_refresh))
    logger.info("开始抓取 %s K 线：共 %d 个 | 并发 %d | 每批 %d 根", KLINE_INTERVAL, len(ordered), MAX_WORKERS, KLINE_LIMIT)

    fn_fetch = lambda sym, prog, s, e: _process_symbol(sym, KLINE_INTERVAL, FORCE_REFRESH, prog, s, e)
    t0       = datetime.now(timezone.utc)
    results  = _run_with_retry(fn_fetch, ordered, start_ms, end_ms, KLINE_INTERVAL, MAX_WORKERS)
    elapsed  = (datetime.now(timezone.utc) - t0).total_seconds()
    ok_cnt   = sum(1 for _, st in results if st == "ok")
    err_list = [(s, st) for s, st in results if st.startswith("error")]
    _print_summary(f"{KLINE_INTERVAL} K 线抓取", ok_cnt, 0, len(err_list), out_dir, err_list, elapsed)


if __name__ == "__main__":
    main()
