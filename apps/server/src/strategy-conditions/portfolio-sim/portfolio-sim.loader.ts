/**
 * portfolio-sim.loader.ts
 *
 * 组合级模拟器 DB 装载层：把既有 A 股回测 run 的逐笔交易 + rank 值 + qfq 行情 + SSE 日历
 * 准备成引擎 EngineInput（引擎不查库）。
 *
 * 设计照搬 signal-stats.simulator.db：按 tsCode 分组预取行情 + 有界并发。
 *
 * 表/列已落真 DB 核实（2026-06-11）：
 *   - signal_test_trade(run_id, ts_code, signal_date, buy_date, exit_date, ret, hold_days)
 *   - signal_rolling_indicator(ts_code, trade_date, pos_120)        —— public schema，无 raw. 前缀
 *   - raw.daily_basic(ts_code, trade_date, circ_mv)
 *   - raw.daily_quote(ts_code, trade_date, qfq_open, qfq_close)     —— 已有前复权列，直接用（引擎只用比率）
 *   - raw.trade_cal(exchange, cal_date, is_open)                    —— SSE 升序、is_open=1
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { mapWithConcurrency } from '../signal-stats/signal-stats.concurrency';
import {
  EngineInput,
  EngineQuoteBar,
  EngineTrade,
  PortfolioSimConfig,
} from './portfolio-sim.types';
import {
  extendCalendarTail,
  parseNumericString,
  qfqRatioBar,
  windowUnionByTsCode,
} from './portfolio-sim.loader-helpers';

/** qfq 行情预取的组间并发上界（与 signal-stats 一致，留余量给 PG pool max=10）。 */
export const LOADER_QUOTE_CONCURRENCY = 8;

/** 装载结果：引擎输入 + 装载阶段元信息（供 runner 上报进度 / warn）。 */
export interface LoadResult {
  input: EngineInput;
  /** 涉及的 tsCode 组数（loading 阶段进度分母）。 */
  groupTotal: number;
  /** 日历补尾时实际补入的日期（升序）；未补则空。 */
  appendedCalendarDates: string[];
}

@Injectable()
export class PortfolioSimLoader {
  private readonly logger = new Logger(PortfolioSimLoader.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 装载引擎输入。
   *
   * @param config       组合配置（sources/费率/锚点）
   * @param onGroupDone  每个 tsCode 行情组预取完成回调（参数=完成组序号占位 1），供 loading 阶段进度。
   */
  async load(
    config: PortfolioSimConfig,
    onGroupDone?: (done: number) => void,
  ): Promise<LoadResult> {
    // ── 1. 逐源装载 trades + rank 值 → 拼成全局 EngineTrade[]（带 sourceIdx）。
    const trades: EngineTrade[] = [];
    for (let s = 0; s < config.sources.length; s++) {
      const source = config.sources[s];
      const srcTrades = await this.loadSourceTrades(s, source.runId, source.rankField);
      if (srcTrades.length === 0) {
        throw new Error(
          `信号源 #${s}（label=${source.label}, runId=${source.runId}）查无逐笔交易；` +
            `无法装载组合模拟。请确认该 run 已成功且 trades > 0。`,
        );
      }
      for (const t of srcTrades) trades.push(t);
    }

    // ── 2. qfq 行情预取（按 tsCode 分组 + 有界并发）。
    const windows = windowUnionByTsCode(trades);
    const tsCodes = Array.from(windows.keys());
    const quotes = new Map<string, Map<string, EngineQuoteBar>>();

    let done = 0;
    const fetchOne = async (tsCode: string): Promise<void> => {
      const win = windows.get(tsCode)!;
      const bars = await this.fetchQfqQuotes(tsCode, win.minBuy, win.maxExit);
      if (bars.size === 0) {
        // 整窗缺失 → 空 Map（引擎停牌沿价兜底）+ warn（禁 .catch(()=>[]) 静默吞）。
        this.logger.warn(
          `PortfolioSimLoader: tsCode=${tsCode} 在 [${win.minBuy}, ${win.maxExit}] ` +
            `整窗无 qfq 行情，引擎将走停牌沿价兜底。`,
        );
      }
      quotes.set(tsCode, bars);
      done += 1;
      onGroupDone?.(done);
    };
    await mapWithConcurrency(tsCodes, LOADER_QUOTE_CONCURRENCY, fetchOne);

    // ── 3. SSE 日历（覆盖 [全源 min(buyDate), max(exitDate)]）+ 必要时补尾。
    let minBuy = trades[0].buyDate;
    let maxExit = trades[0].exitDate;
    for (const t of trades) {
      if (t.buyDate < minBuy) minBuy = t.buyDate;
      if (t.exitDate > maxExit) maxExit = t.exitDate;
    }
    const rawCalendar = await this.fetchSseCalendar(minBuy, maxExit);
    const { calendar, appendedDates } = extendCalendarTail(rawCalendar, trades);
    if (appendedDates.length > 0) {
      this.logger.warn(
        `PortfolioSimLoader: SSE 日历末端落后于 trades 最大日期 ${maxExit}，` +
          `已用 trades buy/exit 日期补尾 ${appendedDates.length} 日：` +
          `[${appendedDates[0]} .. ${appendedDates[appendedDates.length - 1]}]`,
      );
    }

    return {
      input: { config, trades, quotes, calendar },
      groupTotal: tsCodes.length,
      appendedCalendarDates: appendedDates,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 单源 trades + rank 值
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 装载某源全部 trades，并按 rankField 回 JOIN rank 值。
   *
   * rankField:
   *   - 'pos_120' → LEFT JOIN signal_rolling_indicator d ON (ts_code, trade_date=signal_date) 取 d.pos_120
   *   - 'circ_mv' → LEFT JOIN raw.daily_basic m       ON (ts_code, trade_date=signal_date) 取 m.circ_mv
   *   - 'none'    → 跳过 JOIN，rankValue 全 null
   * 查不到（LEFT JOIN 未命中或值 NULL）→ rankValue=null（引擎自会置后）。
   */
  async loadSourceTrades(
    sourceIdx: number,
    runId: string,
    rankField: 'pos_120' | 'circ_mv' | 'none',
  ): Promise<EngineTrade[]> {
    let sql: string;
    if (rankField === 'pos_120') {
      sql = `
        SELECT t.ts_code AS "tsCode",
               t.signal_date AS "signalDate",
               t.buy_date AS "buyDate",
               t.exit_date AS "exitDate",
               t.ret AS "ret",
               t.hold_days AS "holdDays",
               d.pos_120 AS "rankRaw"
          FROM signal_test_trade t
          LEFT JOIN signal_rolling_indicator d
            ON d.ts_code = t.ts_code AND d.trade_date = t.signal_date
         WHERE t.run_id = $1`;
    } else if (rankField === 'circ_mv') {
      sql = `
        SELECT t.ts_code AS "tsCode",
               t.signal_date AS "signalDate",
               t.buy_date AS "buyDate",
               t.exit_date AS "exitDate",
               t.ret AS "ret",
               t.hold_days AS "holdDays",
               m.circ_mv AS "rankRaw"
          FROM signal_test_trade t
          LEFT JOIN raw.daily_basic m
            ON m.ts_code = t.ts_code AND m.trade_date = t.signal_date
         WHERE t.run_id = $1`;
    } else {
      sql = `
        SELECT t.ts_code AS "tsCode",
               t.signal_date AS "signalDate",
               t.buy_date AS "buyDate",
               t.exit_date AS "exitDate",
               t.ret AS "ret",
               t.hold_days AS "holdDays",
               NULL AS "rankRaw"
          FROM signal_test_trade t
         WHERE t.run_id = $1`;
    }

    const rows = await this.dataSource.query<
      Array<{
        tsCode: string;
        signalDate: string;
        buyDate: string;
        exitDate: string;
        ret: string;
        holdDays: number;
        rankRaw: string | number | null;
      }>
    >(sql, [runId]);

    return rows.map((r) => {
      const ret = parseNumericString(typeof r.ret === 'string' ? r.ret : String(r.ret));
      // pos_120 是 double precision（pg 可能返回 number）；circ_mv 是 numeric（string）。统一 parseFloat。
      const rankValue =
        r.rankRaw === null || r.rankRaw === undefined
          ? null
          : parseNumericString(typeof r.rankRaw === 'string' ? r.rankRaw : String(r.rankRaw));
      return {
        sourceIdx,
        tsCode: r.tsCode,
        signalDate: r.signalDate,
        buyDate: r.buyDate,
        exitDate: r.exitDate,
        ret: ret ?? 0,
        holdDays: typeof r.holdDays === 'number' ? r.holdDays : parseInt(String(r.holdDays), 10),
        rankValue,
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // qfq 行情
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 取某标的 [start, end]（含端点）的 qfq 行情，输出 Map<tradeDate, {open, close}>。
   * 停牌日 / qfq 价缺失 → 不进 Map（引擎视同停牌）。
   */
  async fetchQfqQuotes(
    tsCode: string,
    start: string,
    end: string,
  ): Promise<Map<string, EngineQuoteBar>> {
    const rows = await this.dataSource.query<
      Array<{ trade_date: string; qfq_open: string | null; qfq_close: string | null }>
    >(
      `SELECT trade_date, qfq_open, qfq_close
         FROM raw.daily_quote
        WHERE ts_code = $1 AND trade_date BETWEEN $2 AND $3`,
      [tsCode, start, end],
    );
    const map = new Map<string, EngineQuoteBar>();
    for (const r of rows) {
      const bar = qfqRatioBar(r.qfq_open, r.qfq_close);
      if (bar) map.set(r.trade_date, bar);
    }
    return map;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SSE 日历
  // ──────────────────────────────────────────────────────────────────────────

  /** 取 [start, end]（含端点）的 SSE 开市日，升序。 */
  async fetchSseCalendar(start: string, end: string): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ calDate: string }>>(
      `SELECT cal_date AS "calDate"
         FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1
          AND cal_date BETWEEN $1 AND $2
        ORDER BY cal_date`,
      [start, end],
    );
    // cal_date 为 char(8)，恰好 8 字符无 padding（真 DB 已核），仍 trim 防御。
    return rows.map((r) => r.calDate.trim());
  }
}
