import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KdjBar, KdjParams, lastTwoKdj } from './kdj-params';

interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

/** 单个标的的 as-of 重算结果。 */
export interface KdjRecomputeResult {
  curr: KdjPoint;
  prev: KdjPoint | null;
}

/** 每个标的取 as-of 前最多多少根做 warmup（KDJ 在百根后收敛，种子影响可忽略）。 */
const WARMUP_BARS = 250;

interface QuoteRow {
  ts_code: string;
  trade_date: string;
  qfq_high: string;
  qfq_low: string;
  qfq_close: string;
}

/**
 * KDJ 实时重算服务（带 DB 取数）。
 *
 * 当策略条件带自定义 KDJ 参数（N/M1/M2 ≠ 9/3/3）时，从 `raw.daily_quote` 读前复权
 * OHLC（qfq_high/qfq_low/qfq_close，与 A 股指标预算口径一致），按这组参数实时重算
 * KDJ，返回每个标的的最后一根 / 倒数第二根。供策略条件 runner 调用。
 */
@Injectable()
export class KdjRecomputeService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 重算一批标的在 asOfDate 当日（及之前最近 WARMUP_BARS 根）的 KDJ。
   *
   * @param tsCodes  A 股 ts_code 列表（varchar）
   * @param asOfDate trade_date 字符串，格式 'YYYYMMDD'（禁止 new Date()）
   * @param params   KDJ 参数 n/m1/m2
   * @returns Map<tsCode, { curr, prev }>；数据不足的标的不放进 Map（调用方据缺失视为不命中）
   */
  async recomputeLatest(
    tsCodes: string[],
    asOfDate: string,
    params: KdjParams,
  ): Promise<Map<string, KdjRecomputeResult>> {
    const result = new Map<string, KdjRecomputeResult>();
    if (tsCodes.length === 0) return result;

    // 与 a-shares-indicator.service.ts loadQuoteRows 口径一致：前复权 qfq_* + IS NOT NULL。
    // 窗口函数按 ts_code 分区、trade_date 倒序取最近 WARMUP_BARS 根，再升序输出。
    const rows = await this.dataSource.query<QuoteRow[]>(
      `
      SELECT ts_code, trade_date, qfq_high, qfq_low, qfq_close FROM (
        SELECT ts_code, trade_date, qfq_high, qfq_low, qfq_close,
               ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
        FROM raw.daily_quote
        WHERE ts_code = ANY($1::text[])
          AND qfq_high IS NOT NULL AND qfq_low IS NOT NULL AND qfq_close IS NOT NULL
          AND trade_date <= $2
      ) t WHERE rn <= $3 ORDER BY ts_code, trade_date ASC
      `,
      [tsCodes, asOfDate, WARMUP_BARS],
    );

    // 按 ts_code 分组（结果已按 ts_code, trade_date ASC 排序）。
    const grouped = new Map<string, KdjBar[]>();
    for (const row of rows) {
      let bars = grouped.get(row.ts_code);
      if (!bars) {
        bars = [];
        grouped.set(row.ts_code, bars);
      }
      bars.push({
        high: Number(row.qfq_high),
        low: Number(row.qfq_low),
        close: Number(row.qfq_close),
      });
    }

    for (const [tsCode, bars] of grouped) {
      if (bars.length === 0) continue;
      result.set(tsCode, lastTwoKdj(bars, params.n, params.m1, params.m2));
    }

    return result;
  }
}
