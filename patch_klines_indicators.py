# -*- coding: utf-8 -*-
"""
为 cache 目录下已有的 K 线 CSV 文件补充技术指标列：
  1h_klines/、4h_klines/、1d_klines/ 三个目录均会处理。

指标列：DIF, DEA, MACD, KDJ.K, KDJ.D, KDJ.J, BBI, MA5, MA30, MA60, MA120, MA240,
       10_quote_volume, atr_14, loss_atr_14, low_9, high_9, stop_loss_pct, risk_reward_ratio

已包含全部指标列的文件自动跳过（由 FORCE_PATCH 控制）。
多线程并行处理，原地覆盖原文件。

指标说明：
  MACD        : DIF = EMA12 - EMA26；DEA = DIF 的 9 日 EMA；MACD = 2×(DIF-DEA)
  KDJ         : 9 周期随机指标，初始 K=D=50
  BBI         : (MA3 + MA6 + MA12 + MA24) / 4
  MA5/30/60/120/240 : 收盘价简单移动平均（SMA）
  atr_14      : 14 周期 Wilder's ATR
  loss_atr_14 : 收盘价 - atr_14（ATR 止损参考价）
"""

import csv
import logging
import sys
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# 防止 Windows 下 stdout 乱码
if sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from kline_indicators import (
    KLINE_OUTPUT_COLUMNS,
    INDICATOR_COLUMNS,
    ALL_OUTPUT_COLUMNS,
    calc_indicators,
)

# ══════════════════════════════════════════════════════════════
#  运行配置
# ══════════════════════════════════════════════════════════════

# True：强制重新计算并覆盖，即使文件中已有指标列
FORCE_PATCH: bool = False

# 多线程并发数
MAX_WORKERS: int = 8

# ──────────────────────────── 内部配置 ────────────────────────────
CACHE_DIR = Path(__file__).parent / "cache"
KLINES_DIRS = [
    CACHE_DIR / "1h_klines",
    CACHE_DIR / "4h_klines",
    CACHE_DIR / "1d_klines",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

_progress_lock = threading.Lock()
_done_count = 0


# ──────────────────────────── 文件处理 ────────────────────────────
def patch_file(path: Path) -> tuple[Path, str]:
    """
    为单个 CSV 文件补充指标列。
    返回 (path, "ok" | "skip" | "error: ...")
    """
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            existing_fields = reader.fieldnames or []
            rows = list(reader)

        if not rows:
            return path, "skip: 空文件"

        if not FORCE_PATCH and all(col in existing_fields for col in INDICATOR_COLUMNS):
            return path, "skip: 已含全部指标列"

        # 确保行中有 KLINE_OUTPUT_COLUMNS 所需字段
        required = {"close", "high", "low"}
        if not required.issubset(set(existing_fields)):
            return path, f"skip: 缺少必要字段 {required - set(existing_fields)}"

        calc_indicators(rows)

        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=ALL_OUTPUT_COLUMNS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

        return path, "ok"

    except Exception as exc:
        return path, f"error: {exc}"


# ──────────────────────────── 主逻辑 ────────────────────────────
def main() -> None:
    global _done_count

    csv_files: list[Path] = []
    for klines_dir in KLINES_DIRS:
        if klines_dir.exists():
            csv_files.extend(sorted(klines_dir.glob("*.csv")))
        else:
            logger.warning("目录不存在，跳过: %s", klines_dir)

    total = len(csv_files)

    if total == 0:
        logger.info("cache 目录下没有找到任何 K 线 CSV 文件")
        return

    logger.info(
        "找到 %d 个 CSV 文件（1h + 4h + 1d），开始补充指标（并发 %d）...",
        total, MAX_WORKERS,
    )
    logger.info("指标列：%s", ", ".join(INDICATOR_COLUMNS))

    results: list[tuple[Path, str]] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(patch_file, p): p for p in csv_files}

        for future in as_completed(futures):
            path, status = future.result()
            results.append((path, status))

            with _progress_lock:
                _done_count += 1
                cnt = _done_count
            if cnt % 100 == 0 or cnt == total:
                logger.info(
                    "进度 %d/%d (%.1f%%)", cnt, total, cnt / total * 100
                )

    ok_count   = sum(1 for _, s in results if s == "ok")
    skip_count = sum(1 for _, s in results if s.startswith("skip"))
    err_count  = sum(1 for _, s in results if s.startswith("error"))

    print(f"\n{'='*55}")
    print(f"  技术指标补充完成")
    print(f"  成功补充  : {ok_count} 个文件")
    print(f"  跳过      : {skip_count} 个文件（已含指标或为空）")
    print(f"  失败      : {err_count} 个文件")
    print(f"{'='*55}")

    if err_count > 0:
        print("\n失败列表：")
        for p, s in results:
            if s.startswith("error"):
                print(f"  {p.name:<30} {s}")


if __name__ == "__main__":
    main()
