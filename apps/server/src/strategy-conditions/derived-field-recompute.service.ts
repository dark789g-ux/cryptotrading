/**
 * derived-field-recompute.service.ts
 *
 * 通用现算取数服务:从 raw.daily_quote 批量读 qfq OHLC 序列,
 * 供 MaFieldRecomputer / KdjFieldRecomputer 等共用。
 *
 * 借鉴 kdj-recompute.service.ts 的 ROW_NUMBER 窗口取前 N 根做法。
 * 取数 SQL 形态(按 ts_code 分组,每组取 trade_date <= asOfDate 的最近 N 根):
 *   SELECT ts_code, trade_date, qfq_open, qfq_high, qfq_low, qfq_close, vol, amount
 *   FROM (
 *     SELECT *, ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
 *     FROM raw.daily_quote
 *     WHERE ts_code = ANY($1) AND trade_date <= $2
 *   ) t WHERE rn <= $3
 *   ORDER BY ts_code, trade_date ASC
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface DerivedQuoteBar {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  amount: number;
}

interface QuoteRow {
  ts_code: string;
  trade_date: string;
  qfq_open: string;
  qfq_high: string;
  qfq_low: string;
  qfq_close: string;
  vol: string;
  amount: string;
}

@Injectable()
export class DerivedFieldRecomputeService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 批量读取多只票的 qfq OHLC 序列(warmup 用)。
   *
   * @param tsCodes 标的列表
   * @param asOfDate 截止日(YYYYMMDD,含)
   * @param bars 需要的根数(含当日,例如 MA20 需 20 根,KDJ 需 250 根 warmup)
   * @returns Map<tsCode, DerivedQuoteBar[]>(按 trade_date ASC)
   *
   * 无数据的标的(key 缺失)不在结果 Map 中——调用方视为不命中(fail-closed)。
   */
  async loadQfqBars(
    tsCodes: string[],
    asOfDate: string,
    bars: number,
  ): Promise<Map<string, DerivedQuoteBar[]>> {
    const result = new Map<string, DerivedQuoteBar[]>();
    if (tsCodes.length === 0) return result;

    // 与 kdj-recompute.service.ts 口径一致:前复权 qfq_* + IS NOT NULL。
    // 窗口函数按 ts_code 分区、trade_date 倒序取最近 bars 根,再升序输出。
    const rows = await this.dataSource.query<QuoteRow[]>(
      `
      SELECT ts_code, trade_date, qfq_open, qfq_high, qfq_low, qfq_close, vol, amount FROM (
        SELECT ts_code, trade_date, qfq_open, qfq_high, qfq_low, qfq_close, vol, amount,
               ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
        FROM raw.daily_quote
        WHERE ts_code = ANY($1::text[])
          AND qfq_high IS NOT NULL AND qfq_low IS NOT NULL AND qfq_close IS NOT NULL
          AND trade_date <= $2
      ) t WHERE rn <= $3 ORDER BY ts_code, trade_date ASC
      `,
      [tsCodes, asOfDate, bars],
    );

    // 按 ts_code 分组(结果已按 ts_code, trade_date ASC 排序)。
    for (const row of rows) {
      let bars = result.get(row.ts_code);
      if (!bars) {
        bars = [];
        result.set(row.ts_code, bars);
      }
      bars.push({
        tradeDate: row.trade_date,
        open: Number(row.qfq_open),
        high: Number(row.qfq_high),
        low: Number(row.qfq_low),
        close: Number(row.qfq_close),
        vol: Number(row.vol),
        amount: Number(row.amount),
      });
    }

    return result;
  }
}
