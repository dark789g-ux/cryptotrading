/**
 * signal-stats.enumerator.ts
 *
 * 信号枚举：给定买入条件 + 历史区间 + 标的池，遍历区间内每个 SSE 交易日 T，
 * 复用 buildAShareQuery(buyConditions) 锚定 `i.trade_date = :T` 枚举触发的 (T, ts_code)。
 *
 * 与 runner 的差异：runner 硬编码锚定最新天 `i.trade_date=(SELECT MAX...)`；
 * 这里把锚定日**参数化为任意交易日 T**，并支持跨整段区间枚举。
 *
 * 口径基准：docs/superpowers/specs/2026-06-07-signal-forward-stats-design/02-simulation-and-semantics.md
 * 列名已落真 DB 核实（2026-06-07）。
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { SignalTestUniverse } from '../../entities/strategy/signal-test.entity';
import { StrategyConditionsQueryBuilder } from '../strategy-conditions.query-builder';

/** 一个买入信号：交易日 T 上某标的命中买入条件。 */
export interface BuySignal {
  signalDate: string; // T，YYYYMMDD
  tsCode: string;
}

@Injectable()
export class SignalStatsEnumerator {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  /**
   * 取区间内全部 SSE 交易日（升序）。
   * 口径：`raw.trade_cal WHERE exchange='SSE' AND is_open=1 AND cal_date BETWEEN :start AND :end`。
   */
  async listSseTradingDays(dateStart: string, dateEnd: string): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ calDate: string }>>(
      `SELECT cal_date AS "calDate"
         FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1
          AND cal_date BETWEEN $1 AND $2
        ORDER BY cal_date`,
      [dateStart, dateEnd],
    );
    return rows.map((r) => r.calDate);
  }

  /**
   * 取**全局** SSE 交易日历（升序、不限区间）。
   * 用于次新过滤的「buy_date 距 list_date 的 SSE 交易日数」（bug3 修复：必须用全局日历而非窗口局部日历）
   * 及 simulator 持有窗口推进 / buy_date(T+1) 定位。
   */
  async listAllSseTradingDays(): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ calDate: string }>>(
      `SELECT cal_date AS "calDate"
         FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1
        ORDER BY cal_date`,
    );
    return rows.map((r) => r.calDate);
  }

  /**
   * 枚举单个交易日 T 上命中买入条件的标的。
   *
   * 复用 buildAShareQuery(buyConditions) 生成 WHERE 片段，锚定 `i.trade_date = :T`；
   * universe.type='list' 时追加 `AND i.ts_code = ANY(:tsCodes)`。
   *
   * @returns 该 T 命中的 ts_code 列表（每个即一个 (T, ts_code) 买入信号）。
   */
  async enumerateSignalsOnDay(
    tradeDate: string,
    buyConditions: StrategyConditionItem[],
    universe: SignalTestUniverse,
  ): Promise<string[]> {
    if (buyConditions.length === 0) return [];

    const where = this.queryBuilder.buildAShareQuery(buyConditions);
    const { sql, params } = buildEnumerateQuery(where, tradeDate, universe);
    const rows = await this.dataSource.query<Array<{ tsCode: string }>>(sql, params);
    return rows.map((r) => r.tsCode);
  }

  /**
   * 枚举整段区间内全部买入信号（逐交易日循环，首版朴素实现，性能"先慢后优化"）。
   *
   * @param onProgress 可选进度回调（已扫描交易日数 / 总数），供 runner 推 SSE 进度。
   */
  async enumerateSignals(
    buyConditions: StrategyConditionItem[],
    dateStart: string,
    dateEnd: string,
    universe: SignalTestUniverse,
    onProgress?: (scannedDays: number, totalDays: number) => void | Promise<void>,
  ): Promise<BuySignal[]> {
    const tradingDays = await this.listSseTradingDays(dateStart, dateEnd);
    const total = tradingDays.length;
    const signals: BuySignal[] = [];

    for (let idx = 0; idx < total; idx++) {
      const T = tradingDays[idx];
      const tsCodes = await this.enumerateSignalsOnDay(T, buyConditions, universe);
      for (const tsCode of tsCodes) {
        signals.push({ signalDate: T, tsCode });
      }
      if (onProgress) await onProgress(idx + 1, total);
    }

    return signals;
  }
}

/**
 * 纯函数：把买入条件的 WHERE 片段 + 锚定日 T + 标的池 拼成枚举 SQL（参数化）。
 * 抽出便于单测验证「锚定到指定交易日的 WHERE 生成正确、cross 子查询复用正确、list 池追加正确」。
 *
 * 表结构与 runner.scanBatch 一致：daily_indicator i 主锚 + daily_quote/daily_basic/stock_amv_daily 左连。
 */
export function buildEnumerateQuery(
  where: { sql: string; params: unknown[] },
  tradeDate: string,
  universe: SignalTestUniverse,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [...where.params];

  const datePh = `$${params.length + 1}`;
  params.push(tradeDate);

  let universeClause = '';
  if (universe.type === 'list') {
    const codes = universe.tsCodes ?? [];
    const codesPh = `$${params.length + 1}`;
    params.push(codes);
    universeClause = `\n         AND i.ts_code = ANY(${codesPh}::text[])`;
  }

  const sql = `
    SELECT i.ts_code AS "tsCode"
      FROM raw.daily_indicator i
      LEFT JOIN raw.daily_quote q
        ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
      LEFT JOIN raw.daily_basic m
        ON m.ts_code = i.ts_code AND m.trade_date = i.trade_date
      LEFT JOIN stock_amv_daily sa
        ON sa.ts_code = i.ts_code AND sa.trade_date = i.trade_date
      LEFT JOIN signal_rolling_indicator d
        ON d.ts_code = i.ts_code AND d.trade_date = i.trade_date
     WHERE i.trade_date = ${datePh}${universeClause}
       AND ${where.sql}
     ORDER BY i.ts_code
  `;

  return { sql, params };
}
