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
输出：backtest_results/trades.csv、portfolio.csv、report_data.json；前端：report.html（根目录）
"""

from __future__ import annotations

import datetime
import logging

from backtest.config import INITIAL_CAPITAL, KLINES_DIR, OUTPUT_DIR, POSITION_RATIO, ENABLE_PARTIAL_PROFIT, TIMEFRAME
from backtest.data import load_all_klines
from backtest.engine import run_backtest
from backtest.report import calc_stats, save_portfolio_csv, save_report_data_json, save_trades_csv

logger = logging.getLogger(__name__)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    run_id  = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = OUTPUT_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    logger.info("════ 策略回测开始 ════  run_id=%s", run_id)
    logger.info("初始资金：%.2f USDT  单仓比例：%.0f%%  阶段止盈：%s  时间框架：%s",
                INITIAL_CAPITAL, POSITION_RATIO * 100, "启用" if ENABLE_PARTIAL_PROFIT else "禁用", TIMEFRAME)

    data, backtest_start = load_all_klines(KLINES_DIR)
    all_trades, portfolio_log, pos_snapshots = run_backtest(data, backtest_start)

    stats = calc_stats(all_trades, portfolio_log)

    logger.info("════ 回测完成 ════")
    for k, v in stats.items():
        logger.info("  %-20s %s", k, v)

    save_trades_csv(all_trades, run_dir)
    save_portfolio_csv(portfolio_log, run_dir)
    save_report_data_json(all_trades, portfolio_log, stats, run_dir, pos_snapshots, run_id=run_id)

    logger.info("输出目录：%s", run_dir.resolve())
    logger.info("查看报告：python serve_report.py")


if __name__ == "__main__":
    main()
