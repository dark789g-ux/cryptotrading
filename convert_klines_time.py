"""
将 cache/1h_klines/ 目录下所有 CSV 文件的 open_time 字段
从毫秒时间戳（整数）转换为 UTC+8 时间字符串（YYYY-MM-DD HH:MM:SS）。

仅处理 open_time 仍为纯数字的文件，已转换过的文件自动跳过。
多线程并行处理，处理完成后原地覆盖原文件。
"""

import csv
import logging
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# ══════════════════════════════════════════════════════════════
#  运行配置
# ══════════════════════════════════════════════════════════════

# 是否强制重新转换（即使 open_time 看起来已经是字符串格式）
FORCE_CONVERT: bool = False

# 多线程并发数
MAX_WORKERS: int = 8

# ──────────────────────────── 内部配置 ────────────────────────────
KLINES_DIR = Path(__file__).parent / "cache" / "1h_klines"

UTC8 = timezone(timedelta(hours=8))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

_progress_lock = threading.Lock()


# ──────────────────────────── 转换工具 ────────────────────────────
def _ms_to_utc8(ms: int) -> str:
    """将毫秒时间戳转换为 UTC+8 时间字符串，格式：YYYY-MM-DD HH:MM:SS"""
    return datetime.fromtimestamp(ms / 1000, tz=UTC8).strftime("%Y-%m-%d %H:%M:%S")


def _is_timestamp(value: str) -> bool:
    """判断字段值是否为纯数字时间戳（未转换）。"""
    return value.strip().isdigit()


# ──────────────────────────── 文件处理 ────────────────────────────
def convert_file(path: Path) -> tuple[Path, str]:
    """
    处理单个 CSV 文件，将 open_time 列从毫秒时间戳转换为 UTC+8 字符串。
    返回 (path, "ok" | "skip" | "error: ...")
    """
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            if not fieldnames or "open_time" not in fieldnames:
                return path, "skip: 无 open_time 列"

            rows = list(reader)

        if not rows:
            return path, "skip: 空文件"

        first_val = rows[0].get("open_time", "")
        if not FORCE_CONVERT and not _is_timestamp(first_val):
            return path, "skip: 已是字符串格式"

        for row in rows:
            raw = row["open_time"].strip()
            if _is_timestamp(raw):
                row["open_time"] = _ms_to_utc8(int(raw))

        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        return path, "ok"

    except Exception as exc:
        return path, f"error: {exc}"


# ──────────────────────────── 主逻辑 ────────────────────────────
def main() -> None:
    if not KLINES_DIR.exists():
        raise FileNotFoundError(
            f"K 线目录不存在：{KLINES_DIR}\n请先运行 fetch_klines.py 生成数据。"
        )

    csv_files = sorted(KLINES_DIR.glob("*.csv"))
    total = len(csv_files)

    if total == 0:
        logger.info("cache/1h_klines/ 目录下没有找到 CSV 文件")
        return

    logger.info("找到 %d 个 CSV 文件，开始转换（并发 %d）...", total, MAX_WORKERS)

    results: list[tuple[Path, str]] = []
    done_count = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(convert_file, p): p for p in csv_files}

        for future in as_completed(futures):
            path, status = future.result()
            results.append((path, status))

            with _progress_lock:
                done_count += 1
                if done_count % 50 == 0 or done_count == total:
                    logger.info("进度 %d/%d (%.1f%%)", done_count, total, done_count / total * 100)

    ok_count   = sum(1 for _, s in results if s == "ok")
    skip_count = sum(1 for _, s in results if s.startswith("skip"))
    err_count  = sum(1 for _, s in results if s.startswith("error"))

    print(f"\n{'='*55}")
    print(f"  open_time 转换完成")
    print(f"  成功转换  : {ok_count} 个文件")
    print(f"  跳过      : {skip_count} 个文件（已是字符串格式）")
    print(f"  失败      : {err_count} 个文件")
    print(f"{'='*55}")

    if err_count > 0:
        print("\n失败列表：")
        for p, s in results:
            if s.startswith("error"):
                print(f"  {p.name:<30} {s}")


if __name__ == "__main__":
    main()
