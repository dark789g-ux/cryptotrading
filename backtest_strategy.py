# -*- coding: utf-8 -*-
"""
策略回测脚本

策略说明：
  入场：close > MA60 AND MA30 > MA60 AND MA60 > MA120 AND close > MA240 AND KDJ.J < 10，下一根 K 线开盘价买入
  频率：每小时最多开一个新仓位（每根 1h K 线最多产生一笔 pending buy）
  仓位：2 个仓位，每仓 45%；两仓均阶段止盈后允许开第 3 仓
  止损：近期低价止损 / 第3+周期收盘低于成本 / 第5+周期MACD从未上升 / MACD方向变化浮动止损
  止盈：最高价突破近期高价时卖出一半

输入：cache/1h_klines/*.csv
输出：backtest_results/trades.csv、portfolio.csv、report_data.json；查看：Vue 回测页（python main.py / uvicorn）
"""

from __future__ import annotations

import datetime
import logging
import threading
from pathlib import Path
from typing import Callable

from backtest.config import INITIAL_CAPITAL, KLINES_DIR, OUTPUT_DIR, POSITION_RATIO, ENABLE_PARTIAL_PROFIT, TIMEFRAME
from backtest.config import BacktestConfig, apply_config
from backtest.data import load_all_klines
from backtest.engine import run_backtest
from backtest.report import calc_stats, save_portfolio_csv, save_report_data_json, save_trades_csv, _prepare_report_data

logger = logging.getLogger(__name__)

# 全局回测锁（同一时刻只允许一个回测运行）
_backtest_lock = threading.Lock()


def run(
    cfg: BacktestConfig,
    progress_cb: Callable[[int, int, float, str], None] | None = None,
) -> dict:
    """
    以给定配置执行完整回测，返回报告数据字典。

    Args:
        cfg         : 回测参数配置
        progress_cb : 可选进度回调 fn(current, total, percent, phase)
                      phase 取值："加载数据" | "回测中" | "生成报告"

    Returns:
        报告数据字典（与 report_data.json 结构相同），同时写入 backtest_results/{run_id}/
    """
    if not _backtest_lock.acquire(blocking=False):
        raise RuntimeError("另一个回测正在运行，请稍后再试")

    try:
        return _run_impl(cfg, progress_cb)
    finally:
        _backtest_lock.release()


def _run_impl(
    cfg: BacktestConfig,
    progress_cb: Callable[[int, int, float, str], None] | None,
) -> dict:
    # 1. 将配置注入各模块全局常量
    apply_config(cfg)

    output_dir = Path("backtest_results")
    output_dir.mkdir(parents=True, exist_ok=True)
    run_id  = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    logger.info("════ 策略回测开始 ════  run_id=%s", run_id)
    logger.info(
        "初始资金：%.2f USDT  单仓比例：%.0f%%  时间框架：%s  日期：%s ~ %s",
        cfg.initial_capital, cfg.position_ratio * 100,
        cfg.timeframe, cfg.date_start or "最早", cfg.date_end or "今天",
    )

    # 2. 加载数据
    def _load_cb(cur, tot, pct):
        if progress_cb:
            progress_cb(cur, tot, pct, "加载数据")

    klines_dir = Path(f"cache/{cfg.timeframe}_klines")
    if progress_cb:
        progress_cb(0, 1, 0.0, "加载数据")

    data, backtest_start = load_all_klines(
        klines_dir,
        timeframe=cfg.timeframe,
        date_start=cfg.date_start,
        date_end=cfg.date_end,
    )

    if progress_cb:
        progress_cb(1, 1, 5.0, "加载数据完成")

    # 3. 执行回测
    def _backtest_cb(cur, tot, pct):
        # 将回测进度映射到 5%~90% 区间
        mapped = 5.0 + pct * 0.85
        if progress_cb:
            progress_cb(cur, tot, mapped, "回测中")

    all_trades, portfolio_log, pos_snapshots = run_backtest(
        data, backtest_start, progress_cb=_backtest_cb
    )

    # 4. 计算统计并保存
    if progress_cb:
        progress_cb(0, 1, 90.0, "生成报告")

    stats = calc_stats(all_trades, portfolio_log)

    logger.info("════ 回测完成 ════")
    for k, v in stats.items():
        logger.info("  %-20s %s", k, v)

    save_trades_csv(all_trades, run_dir)
    save_portfolio_csv(portfolio_log, run_dir)
    save_report_data_json(all_trades, portfolio_log, stats, run_dir, pos_snapshots, run_id=run_id)

    logger.info("输出目录：%s", run_dir.resolve())

    report_data = _prepare_report_data(all_trades, portfolio_log, stats, pos_snapshots)
    report_data["run_id"] = run_id

    # 提取 total_return 数值供策略列表展示
    total_return_str = stats.get("总收益率", "0%")
    try:
        last_return = float(total_return_str.replace("%", ""))
    except ValueError:
        last_return = 0.0
    report_data["last_backtest_return"] = last_return

    if progress_cb:
        progress_cb(1, 1, 100.0, "完成")

    return report_data


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    run_id  = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = OUTPUT_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    logger.info("════ 策略回测开始 ════  run_id=%s", run_id)
    logger.info("初始资金：%.2f USDT  单仓比例：%.0f%%  阶段止盈：%s  时间框架：%s",
                INITIAL_CAPITAL, POSITION_RATIO * 100, "启用" if ENABLE_PARTIAL_PROFIT else "禁用", TIMEFRAME)

    data, backtest_start = load_all_klines(KLINES_DIR, timeframe=TIMEFRAME)
    all_trades, portfolio_log, pos_snapshots = run_backtest(data, backtest_start)

    stats = calc_stats(all_trades, portfolio_log)

    logger.info("════ 回测完成 ════")
    for k, v in stats.items():
        logger.info("  %-20s %s", k, v)

    save_trades_csv(all_trades, run_dir)
    save_portfolio_csv(portfolio_log, run_dir)
    save_report_data_json(all_trades, portfolio_log, stats, run_dir, pos_snapshots, run_id=run_id)

    logger.info("输出目录：%s", run_dir.resolve())
    logger.info("查看报告：uvicorn main:app --port 8000 后打开 http://localhost:8000 回测页")


if __name__ == "__main__":
    main()
