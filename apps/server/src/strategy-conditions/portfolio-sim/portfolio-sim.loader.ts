/**
 * portfolio-sim.loader.ts
 *
 * 组合级模拟器 DB 装载层：把既有 A 股回测 run 的逐笔交易 + 多因子值 + qfq 行情 + SSE 日历
 * 准备成引擎 EngineInput（引擎不查库）。
 *
 * 设计照搬 signal-stats.simulator.db：按 tsCode 分组预取行情 + 有界并发。
 * 因子装载注册表驱动（spec 06）：前端只送因子 KEY，SQL 的表/列全来自 RANK_FACTOR_REGISTRY 常量，
 * 绝不拼前端字符串（见 portfolio-sim.loader-sql.ts）。
 *
 * 表/列已落真 DB 核实：
 *   - signal_test_trade(run_id, ts_code, signal_date, buy_date, exit_date, ret, hold_days)
 *   - signal_rolling_indicator(ts_code, trade_date, pos_120/pos_60/close_ma60_ratio/vol_ratio_60/vol_ratio_120) —— public schema
 *   - raw.daily_basic(ts_code, trade_date, circ_mv)
 *   - raw.daily_indicator(ts_code, trade_date, ma60/atr_14/risk_reward_ratio)  —— momentum/risk_reward 源（2026-06-14 核）
 *   - raw.daily_quote(ts_code, trade_date, qfq_open, qfq_close)     —— 已有前复权列，直接用（引擎只用比率）
 *   - ml.scores_daily(trade_date, ts_code, model_version, score, rank_in_day) —— 跨 model_version 不唯一，JOIN 走 DISTINCT ON 去重
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
  PortfolioSimSource,
  RankFactorKey,
} from './portfolio-sim.types';
import {
  extendCalendarTail,
  parseNumericString,
  qfqRatioBar,
  windowUnionByTsCode,
} from './portfolio-sim.loader-helpers';
import { resolveRankSpec } from './portfolio-sim.factor-registry';
import {
  buildFactorValues,
  buildSourceTradesSql,
} from './portfolio-sim.loader-sql';

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
      const srcTrades = await this.loadSourceTrades(s, source.runId, source);
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
   * 装载某源全部 trades，按 rankSpec 注册表驱动多因子回 JOIN，组装每行 factorValues。
   *
   * 流程（spec 06-loader-multifactor.md）：
   *   1. factors = resolveRankSpec(source) → keys（因子 KEY 集；legacy 单字段 / none 也经此适配）。
   *   2. 注册表把 keys 翻译成需 JOIN 的表 + 需 SELECT 的列（全是注册表常量，绝不拼前端字符串）；
   *      同张表只 LEFT JOIN 一次，按 (ts_code, signal_date)；ml.scores_daily 走 DISTINCT ON 去重子查询。
   *      未命中注册表的 KEY → logger.warn + 跳过（service 已 400 拦，loader 再 defensive 双保险）。
   *   3. JS 侧 buildFactorValues：column 直取过 parseNumericString，computed 调注册表 compute。
   *
   * rankValue 统一置 null：综合排序分由引擎 rankAndScore 计算（见 spec 01/03），loader 不再预排。
   * 任一因子缺值（LEFT JOIN 未命中 / 列 NULL / momentum 分母 0）→ 该因子 null（引擎排序按 null 殿后）。
   */
  async loadSourceTrades(
    sourceIdx: number,
    runId: string,
    source: PortfolioSimSource,
  ): Promise<EngineTrade[]> {
    const factors = resolveRankSpec(source);
    const keys: RankFactorKey[] = factors.map((f) => f.factor);

    const { sql } = buildSourceTradesSql(keys, (key) => {
      // service 已 400 拦未命中 KEY；这里二次防御：warn + 跳过（符合「未命中映射 warn+跳过」规范）。
      this.logger.warn(
        `PortfolioSimLoader: 信号源 #${sourceIdx}（runId=${runId}）排序因子 KEY="${key}" ` +
          `未命中 RANK_FACTOR_REGISTRY，已跳过该因子的 JOIN（factorValues 不含此键）。`,
      );
    });

    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      sql,
      [runId],
    );

    return rows.map((r) => {
      const ret = parseNumericString(
        typeof r.ret === 'string' ? r.ret : String(r.ret),
      );
      const holdDaysRaw = r.holdDays;
      return {
        sourceIdx,
        tsCode: r.tsCode as string,
        signalDate: r.signalDate as string,
        buyDate: r.buyDate as string,
        exitDate: r.exitDate as string,
        ret: ret ?? 0,
        holdDays:
          typeof holdDaysRaw === 'number'
            ? holdDaysRaw
            : parseInt(String(holdDaysRaw), 10),
        // 综合排序分在引擎算；loader 统一写 null（spec 06 §factorValues 组装与 null）。
        rankValue: null,
        factorValues: buildFactorValues(keys, r),
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
