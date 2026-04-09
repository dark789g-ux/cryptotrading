# -*- coding: utf-8 -*-
"""
批量更新已有的 K 线 CSV 文件，添加新的技术指标列。

新添加的指标：
  - low_9: 9日最低价
  - high_9: 9日最高价
  - stop_loss_pct: 止损幅度 = (1 - (9日最低价 / 当日收盘价)) * 100
  - risk_reward_ratio: 盈亏比 = (9日最高价 - 当日收盘价) / (当日收盘价 - 9日最低价)

使用方法：
  直接运行脚本即可，会自动处理 1h_klines 和 4h_klines 目录下的所有 CSV 文件。
"""

import csv
import math
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# ══════════════════════════════════════════════════════════════
#  运行配置
# ══════════════════════════════════════════════════════════════

# 多线程并发数（根据 CPU 核心数调整）
MAX_WORKERS: int = 8

# 是否强制重新计算所有文件（False = 只处理缺少新指标列的文件）
FORCE_RECALC: bool = False

# ──────────────────────────── 内部配置 ────────────────────────────
CACHE_DIR = Path(__file__).parent / "cache"
KLINES_1H_DIR = CACHE_DIR / "1h_klines"
KLINES_4H_DIR = CACHE_DIR / "4h_klines"

# 新的指标列名
NEW_INDICATOR_COLUMNS = ["low_9", "high_9", "stop_loss_pct", "risk_reward_ratio"]

# 所有输出列（用于重新写入文件）
KLINE_OUTPUT_COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades",
    "taker_buy_base_vol", "taker_buy_quote_vol",
]

INDICATOR_COLUMNS = [
    "DIF", "DEA", "MACD", "KDJ.K", "KDJ.D", "KDJ.J", "BBI", "10_quote_volume",
    "atr_14", "loss_atr_14",
    "low_9", "high_9", "stop_loss_pct", "risk_reward_ratio"
]

ALL_OUTPUT_COLUMNS = KLINE_OUTPUT_COLUMNS + INDICATOR_COLUMNS


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# 全局锁用于线程安全的计数
_counter_lock = threading.Lock()
_processed_count = 0
_total_count = 0


def _round_sig(x: float, sig: int = 8) -> float:
    """按有效数字位数 sig 四舍五入。"""
    if x == 0.0 or not math.isfinite(x):
        return x
    magnitude = math.floor(math.log10(abs(x)))
    decimal_places = max(sig - 1 - magnitude, 0)
    return round(x, decimal_places)


def calc_new_indicators(rows: list[dict]) -> list[dict]:
    """
    计算新的技术指标：
      - low_9: 9日最低价
      - high_9: 9日最高价
      - stop_loss_pct: 止损幅度
      - risk_reward_ratio: 盈亏比
    """
    closes = [float(r["close"]) for r in rows]
    highs = [float(r["high"]) for r in rows]
    lows = [float(r["low"]) for r in rows]

    for i, row in enumerate(rows):
        start = max(0, i - 8)
        h_max_9 = max(highs[start: i + 1])
        l_min_9 = min(lows[start: i + 1])

        # 止损幅度 = (1 - (9日最低价 / 当日收盘价)) * 100
        if closes[i] != 0:
            stop_loss_pct = (1 - l_min_9 / closes[i]) * 100
        else:
            stop_loss_pct = 0.0

        # 盈亏比 = (9日最高价 - 当日收盘价) / (当日收盘价 - 9日最低价)
        profit_potential = h_max_9 - closes[i]
        loss_potential = closes[i] - l_min_9
        if loss_potential != 0:
            risk_reward_ratio = profit_potential / loss_potential
        else:
            risk_reward_ratio = 0.0

        row["low_9"] = _round_sig(l_min_9, 8)
        row["high_9"] = _round_sig(h_max_9, 8)
        row["stop_loss_pct"] = round(stop_loss_pct, 4)
        row["risk_reward_ratio"] = _round_sig(risk_reward_ratio, 4)

    return rows


def needs_update(csv_path: Path) -> bool:
    """检查文件是否需要更新（缺少新指标列）。"""
    if FORCE_RECALC:
        return True

    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames or []
            for col in NEW_INDICATOR_COLUMNS:
                if col not in headers:
                    return True
        return False
    except Exception:
        return True


def process_csv_file(csv_path: Path) -> tuple[str, str]:
    """
    处理单个 CSV 文件，添加新指标列。
    返回 (文件名, 状态)。
    """
    global _processed_count

    try:
        # 检查是否需要更新
        if not needs_update(csv_path):
            with _counter_lock:
                _processed_count += 1
            return csv_path.name, "skip: 已包含新指标"

        # 读取现有数据
        with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        if not rows:
            with _counter_lock:
                _processed_count += 1
            return csv_path.name, "skip: 空文件"

        # 计算新指标
        rows = calc_new_indicators(rows)

        # 写回文件
        with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=ALL_OUTPUT_COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

        with _counter_lock:
            _processed_count += 1
            current = _processed_count
        
        if current % 50 == 0 or current == _total_count:
            logger.info("进度 %d/%d (%.1f%%)", current, _total_count, current / _total_count * 100)

        return csv_path.name, "ok"

    except Exception as exc:
        with _counter_lock:
            _processed_count += 1
        return csv_path.name, f"error: {exc}"


def update_klines_directory(klines_dir: Path, label: str) -> None:
    """更新指定目录下的所有 K 线 CSV 文件。"""
    global _processed_count, _total_count

    if not klines_dir.exists():
        logger.warning("目录不存在: %s", klines_dir)
        return

    csv_files = list(klines_dir.glob("*.csv"))
    if not csv_files:
        logger.warning("目录下没有 CSV 文件: %s", klines_dir)
        return

    _processed_count = 0
    _total_count = len(csv_files)

    logger.info("开始处理 %s 目录: 共 %d 个文件", label, len(csv_files))

    results: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(process_csv_file, f): f for f in csv_files}
        for future in as_completed(futures):
            filename, status = future.result()
            results.append((filename, status))

    # 统计结果
    ok_count = sum(1 for _, s in results if s == "ok")
    skip_count = sum(1 for _, s in results if s.startswith("skip"))
    err_count = sum(1 for _, s in results if s.startswith("error"))

    print(f"\n{'='*60}")
    print(f"  {label} 更新完成")
    print(f"  成功更新: {ok_count} 个")
    print(f"  跳过    : {skip_count} 个")
    print(f"  失败    : {err_count} 个")
    print(f"{'='*60}")

    if err_count > 0:
        print("\n失败列表：")
        for filename, status in results:
            if status.startswith("error"):
                print(f"  {filename:<40} {status}")


def main() -> None:
    """主函数：更新 1h 和 4h K 线数据。"""
    print(f"配置信息:")
    print(f"  并发数: {MAX_WORKERS}")
    print(f"  强制重算: {FORCE_RECALC}")
    print()

    # 更新 1h K 线
    update_klines_directory(KLINES_1H_DIR, "1h K 线")

    print()

    # 更新 4h K 线
    update_klines_directory(KLINES_4H_DIR, "4h K 线")

    print("\n所有更新任务完成！")


if __name__ == "__main__":
    main()
