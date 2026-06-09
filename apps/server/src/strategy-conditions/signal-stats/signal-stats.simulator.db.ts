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
import { mapWithConcurrency } from './signal-stats.concurrency';
import {
  ExitConfig,
  SimulationOutcome,
  WindowQuote,
  buildHoldingDays,
  findLastIndexLE,
  simulateTradeCore,
} from './signal-stats.simulator';

// ─────────────────────────────────────────────────────────────────────────────
// DB 访问层入参契约
// ─────────────────────────────────────────────────────────────────────────────

/** 批量出场模拟默认组间并发上界（峰值在途连接 ≤ 此值，留余量给 PG pool max=10）。 */
export const DEFAULT_BATCH_CONCURRENCY = 8;

/** trailing_lock MA5 窗口长度（5 个非停牌交易日 qfq_close 均值）。 */
export const MA5_WINDOW = 5;
/** trailing_lock 取数左扩预热交易日数（buy 日 MA5 需 T-3..T+1，至少前推 4 个交易日）。 */
export const MA5_PREHEAT_TRADING_DAYS = 4;

/**
 * 批量出场模拟入参（按 ts_code 分组 + 内存切窗 + 有界并发）。
 *
 * 按 ts_code 分组后一次性预取覆盖区间数据、内存切窗喂给纯函数 simulateTradeCore；
 * 正确性（与历史逐信号路径 zero-drift）已在真实数据上确认（8000 信号 0 漂移）。
 */
export interface BatchSimulateParams {
  /** 待模拟信号（含 ts_code + signalDate）。组内顺序保持与输入一一对应。 */
  signals: Array<{ tsCode: string; signalDate: string }>;
  exit: ExitConfig;
  /** strategy 模式卖出条件；fixed_n 可省略/为空。 */
  exitConditions?: StrategyConditionItem[] | null;
  /** 全局 SSE 日历（升序 cal_date）。 */
  sseCalendar: string[];
  /** date_end（YYYYMMDD）。 */
  dateEnd: string;
  /** 组间并发上界，默认 DEFAULT_BATCH_CONCURRENCY。 */
  concurrency?: number;
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
   * 批量出场模拟：按 ts_code 分组 → 每组一次性预取覆盖区间的 quote/limit/命中日 →
   * 内存切窗喂纯函数 → 组间有界并发。
   *
   * 返回的 outcomes 组间顺序不保证与全局输入顺序一致（调用方按 trade/filter 累加，与顺序无关）；
   * 组内 outcome 与该组输入信号一一对应。
   */
  async simulateSignalsBatched(params: BatchSimulateParams): Promise<SimulationOutcome[]> {
    const { signals, exit, sseCalendar, dateEnd } = params;
    const exitConditions = params.exitConditions ?? [];
    const concurrency = params.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
    const sseLen = sseCalendar.length;

    // 1. 按 ts_code 分组（保组内原始顺序）。
    const groups = new Map<string, Array<{ tsCode: string; signalDate: string }>>();
    for (const sig of signals) {
      const arr = groups.get(sig.tsCode);
      if (arr) arr.push(sig);
      else groups.set(sig.tsCode, [sig]);
    }
    const tsCodes = Array.from(groups.keys());

    // 2. 一次性预取 symbol 行（缺行 → Map 无 key → get 返回 undefined，语义同“无此标的”）。
    const symbolMap = await this.prefetchSymbolMap(tsCodes);

    // 3. 组间有界并发；每组结果是 SimulationOutcome[]，最后 flat。
    const perTsCode = async (tsCode: string): Promise<SimulationOutcome[]> => {
      const sym = symbolMap.get(tsCode); // 可能 undefined
      const groupSignals = groups.get(tsCode)!;

      // 3a. 逐信号先算 prelim（insufficient_data 三种早退都在查 DB 之前判定，与旧路径逐字一致）。
      interface Prelim {
        signal: { tsCode: string; signalDate: string };
        buyIdx: number;
        windowDates: string[];
      }
      // outcomes 与 groupSignals 一一对应；prelim 仅装“有效”信号（拿到 windowDates）。
      const outcomes: (SimulationOutcome | null)[] = new Array(groupSignals.length).fill(null);
      const prelims: Array<{ index: number; prelim: Prelim }> = [];
      for (let i = 0; i < groupSignals.length; i++) {
        const sig = groupSignals[i];
        const sigIdx = sseCalendar.indexOf(sig.signalDate);
        if (sigIdx < 0 || sigIdx + 1 >= sseLen) {
          outcomes[i] = { kind: 'filtered', reason: 'insufficient_data' };
          continue;
        }
        const buyIdx = sigIdx + 1;
        const buyDate = sseCalendar[buyIdx];
        if (buyDate > dateEnd) {
          outcomes[i] = { kind: 'filtered', reason: 'insufficient_data' };
          continue;
        }
        const windowDates = sseCalendar.slice(buyIdx).filter((d) => d <= dateEnd);
        if (windowDates.length === 0) {
          outcomes[i] = { kind: 'filtered', reason: 'insufficient_data' };
          continue;
        }
        prelims.push({ index: i, prelim: { signal: sig, buyIdx, windowDates } });
      }

      // 3b. 全组无有效信号 → 直接返回早退 outcomes（不查 DB）。
      if (prelims.length === 0) {
        return outcomes.map((o) => o ?? { kind: 'filtered', reason: 'insufficient_data' });
      }

      // 3c. unionWindow = 各有效信号 windowDates 的并集 = slice(minBuyIdx)（截到 dateEnd）。
      let minBuyIdx = prelims[0].prelim.buyIdx;
      for (const p of prelims) if (p.prelim.buyIdx < minBuyIdx) minBuyIdx = p.prelim.buyIdx;
      const unionWindow = sseCalendar.slice(minBuyIdx).filter((d) => d <= dateEnd);

      // 3c-bis. trailing_lock 须左扩取数：MA5 预热（buy 日 MA5 需 T-3..T+1）+ signalHigh=qfqHigh(T)。
      //   T = buyIdx-1（最早 = minBuyIdx-1），再前推 MA5_PREHEAT_TRADING_DAYS 个交易日做预热。
      //   左扩仅影响 quote/limit 预取与 MA5 滚动，**不**改各信号 windowDates（buy 日起的持有窗口语义不变）。
      const isBandLock = exit.mode === 'trailing_lock';
      const extStartIdx = isBandLock
        ? Math.max(0, minBuyIdx - 1 - MA5_PREHEAT_TRADING_DAYS)
        : minBuyIdx;
      const fetchWindow = isBandLock
        ? sseCalendar.slice(extStartIdx).filter((d) => d <= dateEnd)
        : unionWindow;

      // 3d. 组内串行 await（勿 Promise.all——连接池峰值约束在组间并发，组内顺序 fetch）。
      const quoteMap = await this.fetchQuotes(tsCode, fetchWindow);
      const limitMap = await this.fetchLimits(tsCode, fetchWindow);
      let downLimitMap: Map<string, number | null> | undefined;
      if (isBandLock) {
        // MA5 在 fetchWindow 的非停牌 qfq_close 序列上滚动现算，写回各 quote 行（仅非停牌日有 ma5）。
        attachMa5(fetchWindow, quoteMap, MA5_WINDOW);
        downLimitMap = await this.fetchDownLimits(tsCode, fetchWindow);
      }
      let hitSet = new Set<string>();
      if (exit.mode === 'strategy') {
        // 对整个 unionWindow 查；buildHoldingDays 的 idx>0 会逐信号排除各自 buyDate，故安全。
        hitSet = await this.fetchExitSignalHits(tsCode, unionWindow, exitConditions);
      }

      // 3e. effListIdx 可按 tsCode 缓存一次；daysSinceList 必须 per-signal（依赖各自 buyIdx）。
      let effListIdx = -1;
      let hasListAnchor = false;
      if (sym?.listDate) {
        hasListAnchor = true;
        const listIdx = sseCalendar.indexOf(sym.listDate);
        effListIdx = listIdx >= 0 ? listIdx : findLastIndexLE(sseCalendar, sym.listDate);
      }
      const delistDate = sym?.delistDate ?? null;

      // 3f. 按原始顺序为有效信号产出 outcome。
      for (const { index, prelim } of prelims) {
        const { signal, buyIdx, windowDates } = prelim;
        let daysSinceList: number | null = null;
        if (hasListAnchor && effListIdx >= 0) daysSinceList = buyIdx - effListIdx;
        const days = buildHoldingDays(
          windowDates,
          quoteMap,
          limitMap,
          hitSet,
          isBandLock ? { downLimitMap } : undefined,
        );
        // trailing_lock：signalHigh = qfq_high(T)，T = buyIdx-1（已在 fetchWindow 内，因左扩覆盖 T）。
        let signalHigh: number | undefined;
        if (isBandLock) {
          const signalDateT = sseCalendar[buyIdx - 1];
          signalHigh = quoteMap.get(signalDateT)?.qfqHigh ?? undefined;
        }
        outcomes[index] = simulateTradeCore({
          tsCode,
          signalDate: signal.signalDate,
          days,
          daysSinceList,
          delistDate,
          signalHigh,
          exit,
        });
      }

      return outcomes.map((o) => o ?? { kind: 'filtered', reason: 'insufficient_data' });
    };

    const grouped = await mapWithConcurrency(tsCodes, concurrency, perTsCode);
    return grouped.flat();
  }

  /**
   * 批量预取 symbol 的 list_date/delist_date。
   *
   * **只用查询返回的行建 Map**：查不到的 ts_code 不放进 Map（get 返回 undefined），
   * 语义等同“无此标的”（sym?.listDate falsy → daysSinceList=null；
   * sym?.delistDate ?? null → null）。**不要给缺行的 ts_code 预填 entry**，否则会把
   * “无此标的”误当“有行但字段 null”，delistDate 语义漂移。
   */
  async prefetchSymbolMap(
    tsCodes: string[],
  ): Promise<Map<string, { listDate: string | null; delistDate: string | null }>> {
    const map = new Map<string, { listDate: string | null; delistDate: string | null }>();
    if (tsCodes.length === 0) return map;
    const rows = await this.dataSource.query<
      Array<{ ts_code: string; list_date: string | null; delist_date: string | null }>
    >(
      `SELECT ts_code, list_date, delist_date
         FROM a_share_symbols
        WHERE ts_code = ANY($1::text[])`,
      [tsCodes],
    );
    for (const r of rows) {
      map.set(r.ts_code, { listDate: r.list_date ?? null, delistDate: r.delist_date ?? null });
    }
    return map;
  }

  /**
   * 批量取某标的若干交易日的 quote 行。停牌日无行（map 不含该 key）。
   * 列已亲验存在（2026-06-09 真 DB information_schema 核对）：
   *   raw.daily_quote 同行有 qfq_open/qfq_high/qfq_low/qfq_close 与 raw open/high/low/close。
   * qfq_high/qfq_low/high(=rawHigh) 供 trailing_lock 用；fixed_n/strategy 不读这些字段（行为零漂移）。
   */
  private async fetchQuotes(tsCode: string, dates: string[]): Promise<Map<string, WindowQuote>> {
    const rows = await this.dataSource.query<
      Array<{
        trade_date: string;
        qfq_open: string | null;
        qfq_high: string | null;
        qfq_low: string | null;
        qfq_close: string | null;
        open: string | null;
        high: string | null;
      }>
    >(
      `SELECT trade_date, qfq_open, qfq_high, qfq_low, qfq_close, open, high
         FROM raw.daily_quote
        WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, WindowQuote>();
    for (const r of rows) {
      map.set(r.trade_date, {
        qfqOpen: toNum(r.qfq_open),
        qfqClose: toNum(r.qfq_close),
        open: toNum(r.open),
        qfqHigh: toNum(r.qfq_high),
        qfqLow: toNum(r.qfq_low),
        high: toNum(r.high),
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
   * 批量取某标的若干交易日的 down_limit（未复权跌停价）。trailing_lock 封死跌停判定用。
   * 列已亲验存在（2026-06-09 真 DB information_schema 核对：raw.stk_limit 有 up_limit/down_limit）。
   */
  private async fetchDownLimits(
    tsCode: string,
    dates: string[],
  ): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<
      Array<{ trade_date: string; down_limit: string | null }>
    >(
      `SELECT trade_date, down_limit
         FROM raw.stk_limit
        WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.down_limit));
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
}

/** numeric 列（pg 返回 string）转 number；null/空 → null。 */
function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 在 fetchWindow 的**非停牌**（quoteMap 有行且 qfqClose 非空）qfq_close 序列上滚动现算 MA5，写回各 quote 行。
 *
 * 口径（spec 01 §六 + 03 §四）：MA5 = 最近 `win` 个**非停牌交易日** qfq_close 的均值（含当日）；
 * 停牌日不进窗口（quoteMap 无 key 或 qfqClose=null → 跳过、不写 ma5）；不足 `win` 个 → ma5 留 null（预热不足）。
 * 与 buildHoldingDays 的 hasQuote 口径一致：只有有 quote 的交易日参与滚动。
 *
 * dates 须升序（fetchWindow 来自 sseCalendar.slice，天然升序）。
 */
export function attachMa5(
  dates: string[],
  quoteMap: Map<string, WindowQuote>,
  win: number,
): void {
  const buf: number[] = []; // 最近 win 个非停牌 qfq_close（升序）
  let sum = 0;
  for (const d of dates) {
    const q = quoteMap.get(d);
    if (!q || q.qfqClose === null) continue; // 停牌日：不进窗口、不写 ma5
    buf.push(q.qfqClose);
    sum += q.qfqClose;
    if (buf.length > win) sum -= buf.shift()!;
    q.ma5 = buf.length === win ? sum / win : null; // 不足 win 个 → 预热不足
  }
}
