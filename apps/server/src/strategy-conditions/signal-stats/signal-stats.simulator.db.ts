/**
 * signal-stats.simulator.db.ts
 *
 * DB 访问层：取「持有窗口数据序列」喂给纯函数 simulateTradeCore（B4 真机端到端验证）。
 *
 * 纯计算逻辑、接口契约见 signal-stats.simulator.ts。
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { StrategyConditionsQueryBuilder } from '../strategy-conditions.query-builder';
import {
  ExitConfig,
  HoldingDaySnapshot,
  SimulationOutcome,
  findLastIndexLE,
  simulateTradeCore,
} from './signal-stats.simulator';

// ─────────────────────────────────────────────────────────────────────────────
// DB 访问层入参契约（B4 消费）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulateSignalParams {
  tsCode: string;
  signalDate: string;
  exit: ExitConfig;
  /**
   * strategy 模式的卖出条件；fixed_n 模式可省略。
   * DB 层据此逐日锚定 buildAShareQuery 填充 exitSignalHit。
   */
  exitConditions?: StrategyConditionItem[] | null;
  /** 全局 SSE 日历（升序 cal_date 数组），由 enumerator 一次性预取后复用（避免每信号重查）。 */
  sseCalendar: string[];
  /** date_end（YYYYMMDD），出场日超出此 → insufficient_data。 */
  dateEnd: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB 访问层：SignalStatsSimulator
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SignalStatsSimulator {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  /**
   * 模拟单个买入信号 → SimulatedTrade 或 FilterReason。
   *
   * 步骤：
   * 1. 定位 buy_date = signalDate 在 sseCalendar 中之后的下一交易日；越界/超 dateEnd → insufficient_data。
   * 2. 取持有窗口候选交易日（buy_date 起、升序、截到 dateEnd）。
   * 3. 批量预取这些日的 daily_quote(qfq_open/qfq_close/open) + stk_limit(up_limit)，组装 HoldingDaySnapshot。
   * 4. strategy 模式：对每个候选交易日锚定 buildAShareQuery(exitConditions) 判 exitSignalHit。
   * 5. 取 list_date/delist_date，算 daysSinceList。
   * 6. 调 simulateTradeCore 得结果。
   */
  async simulateSignal(params: SimulateSignalParams): Promise<SimulationOutcome> {
    const { tsCode, signalDate, exit, sseCalendar, dateEnd } = params;

    // 1. buy_date：signalDate 在日历中的位置 + 1。
    const sigIdx = sseCalendar.indexOf(signalDate);
    if (sigIdx < 0 || sigIdx + 1 >= sseCalendar.length) {
      return { kind: 'filtered', reason: 'insufficient_data' };
    }
    const buyIdx = sigIdx + 1;
    const buyDate = sseCalendar[buyIdx];
    if (buyDate > dateEnd) {
      return { kind: 'filtered', reason: 'insufficient_data' };
    }

    // 2. 持有窗口候选交易日：buy_date 起、升序、截到 dateEnd。
    //    取足够长度（horizonN/maxHold 之外再留余量给停牌顺延 + 退市判定）。需求天数无上限保证，
    //    但实际可交易日有限——这里取到 dateEnd 为止的全部 SSE 日（窗口候选），纯函数自行截断。
    const windowDates = sseCalendar.slice(buyIdx).filter((d) => d <= dateEnd);
    if (windowDates.length === 0) {
      return { kind: 'filtered', reason: 'insufficient_data' };
    }

    // 3. 批量预取 quote + limit。
    const quoteMap = await this.fetchQuotes(tsCode, windowDates);
    const limitMap = await this.fetchLimits(tsCode, windowDates);

    // 4. strategy 模式：逐日判 exitSignalHit（仅对 buy_date 之后的日有意义，但全填充无害）。
    let exitHitDates = new Set<string>();
    if (exit.mode === 'strategy') {
      const exitConditions = params.exitConditions ?? [];
      exitHitDates = await this.fetchExitSignalHits(tsCode, windowDates.slice(1), exitConditions);
    }

    // 5. list_date / delist_date / daysSinceList。
    const sym = await this.fetchSymbol(tsCode);
    let daysSinceList: number | null = null;
    if (sym?.listDate) {
      const listIdx = sseCalendar.indexOf(sym.listDate);
      // list_date 不在日历（停牌首日非 SSE 交易日等边界）→ 取 <= list_date 的最近交易日索引。
      const effListIdx = listIdx >= 0 ? listIdx : findLastIndexLE(sseCalendar, sym.listDate);
      if (effListIdx >= 0) daysSinceList = buyIdx - effListIdx;
    }

    // 6. 组装持有窗口序列。
    const daysSnap: HoldingDaySnapshot[] = windowDates.map((calDate) => {
      const q = quoteMap.get(calDate);
      const hasQuote = !!q && q.qfqOpen !== null && q.qfqClose !== null;
      return {
        calDate,
        hasQuote,
        qfqOpen: q?.qfqOpen ?? null,
        qfqClose: q?.qfqClose ?? null,
        rawOpen: q?.open ?? null,
        upLimit: limitMap.get(calDate) ?? null,
        exitSignalHit: exitHitDates.has(calDate),
      };
    });

    return simulateTradeCore({
      tsCode,
      signalDate,
      days: daysSnap,
      daysSinceList,
      delistDate: sym?.delistDate ?? null,
      exit,
    });
  }

  /** 批量取某标的若干交易日的 qfq_open/qfq_close/open。停牌日无行（map 不含该 key）。 */
  private async fetchQuotes(
    tsCode: string,
    dates: string[],
  ): Promise<Map<string, { qfqOpen: number | null; qfqClose: number | null; open: number | null }>> {
    const rows = await this.dataSource.query<
      Array<{ trade_date: string; qfq_open: string | null; qfq_close: string | null; open: string | null }>
    >(
      `SELECT trade_date, qfq_open, qfq_close, open
         FROM raw.daily_quote
        WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, { qfqOpen: number | null; qfqClose: number | null; open: number | null }>();
    for (const r of rows) {
      map.set(r.trade_date, {
        qfqOpen: toNum(r.qfq_open),
        qfqClose: toNum(r.qfq_close),
        open: toNum(r.open),
      });
    }
    return map;
  }

  /** 批量取某标的若干交易日的 up_limit（未复权涨停价）。 */
  private async fetchLimits(tsCode: string, dates: string[]): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<Array<{ trade_date: string; up_limit: string | null }>>(
      `SELECT trade_date, up_limit
         FROM raw.stk_limit
        WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.up_limit));
    return map;
  }

  /**
   * strategy 模式：取窗口内（buy_date 之后）该标的命中卖出条件的交易日集合。
   * 复用 buildAShareQuery 锚定每日——首版逐日 OR 跨日单查：这里用单条 SQL 跨日枚举
   * （`i.trade_date = ANY(:dates)` + WHERE 片段），避免逐日往返。
   */
  private async fetchExitSignalHits(
    tsCode: string,
    dates: string[],
    exitConditions: StrategyConditionItem[],
  ): Promise<Set<string>> {
    if (dates.length === 0 || exitConditions.length === 0) return new Set();
    const where = this.queryBuilder.buildAShareQuery(exitConditions);
    const params: unknown[] = [...where.params];
    const tsPh = `$${params.length + 1}`;
    const datesPh = `$${params.length + 2}`;
    params.push(tsCode, dates);
    const sql = `
      SELECT i.trade_date AS "tradeDate"
        FROM raw.daily_indicator i
        LEFT JOIN raw.daily_quote q
          ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN raw.daily_basic m
          ON m.ts_code = i.ts_code AND m.trade_date = i.trade_date
        LEFT JOIN stock_amv_daily sa
          ON sa.ts_code = i.ts_code AND sa.trade_date = i.trade_date
       WHERE i.ts_code = ${tsPh}
         AND i.trade_date = ANY(${datesPh}::text[])
         AND ${where.sql}
    `;
    const rows = await this.dataSource.query<Array<{ tradeDate: string }>>(sql, params);
    return new Set(rows.map((r) => r.tradeDate));
  }

  /** 取标的 list_date/delist_date。 */
  private async fetchSymbol(
    tsCode: string,
  ): Promise<{ listDate: string | null; delistDate: string | null } | null> {
    const rows = await this.dataSource.query<
      Array<{ list_date: string | null; delist_date: string | null }>
    >(
      `SELECT list_date, delist_date FROM a_share_symbols WHERE ts_code = $1`,
      [tsCode],
    );
    if (rows.length === 0) return null;
    return { listDate: rows[0].list_date ?? null, delistDate: rows[0].delist_date ?? null };
  }
}

/** numeric 列（pg 返回 string）转 number；null/空 → null。 */
function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
