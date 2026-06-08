/**
 * signal-stats.simulator.ts
 *
 * 逐笔出场模拟：给定一个买入信号 (ts_code, signalDate=T)，做 T+1 入场 → 出场逐笔模拟，
 * 算出一条 SimulatedTrade 或返回被过滤原因 FilterReason。
 *
 * 设计：把**纯计算逻辑**（入场过滤判定、出场决策、停牌顺延、ret/holdDays 计算）抽成
 * 不依赖 DB 的纯函数 `simulateTradeCore`，DB 访问层 `SignalStatsSimulator` 负责
 * 取「持有窗口数据序列」喂给纯函数。这样单测覆盖纯函数（spec 05 §5.2），
 * DB 拼接留 B4 真机端到端。
 *
 * 口径基准：docs/superpowers/specs/2026-06-07-signal-forward-stats-design/02-simulation-and-semantics.md
 * 列名已落真 DB 核实（2026-06-07）：
 *   raw.daily_quote(qfq_open, qfq_close, open), raw.stk_limit(up_limit),
 *   public.a_share_symbols(list_date, delist_date), raw.trade_cal(SSE / is_open=1)。
 *
 * DB 访问层见 signal-stats.simulator.db.ts（SignalStatsSimulator、SimulateSignalParams）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 输出契约（钉死，B4 消费）—— 字段名不可改
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatedTrade {
  tsCode: string;
  signalDate: string;
  buyDate: string;
  exitDate: string;
  buyPrice: number;
  exitPrice: number;
  ret: number;
  holdDays: number;
  exitReason: 'max_hold' | 'signal' | 'delist';
}

export type FilterReason =
  | 'suspended'
  | 'limit_up'
  | 'new_listing'
  | 'insufficient_data';

/** 纯函数返回：要么一条成交，要么一个过滤原因（判别联合）。 */
export type SimulationOutcome =
  | { kind: 'trade'; trade: SimulatedTrade }
  | { kind: 'filtered'; reason: FilterReason };

// ─────────────────────────────────────────────────────────────────────────────
// 纯计算层输入：一个买入信号的「持有窗口数据序列」（不依赖 DB）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 持有窗口内单个 SSE 交易日的快照。
 *
 * 序列 `days` 必须是 **buy_date 起、按 cal_date 升序** 的连续 SSE 交易日：
 *   days[0] = buy_date(T+1), days[1] = buy_date 的下一交易日, ...
 *
 * 「停牌日」= 该 SSE 交易日 daily_quote 无行 / qfq 价为空 → `hasQuote=false`。
 *   纯函数对停牌日：不占 N/max_hold 额度、不递增 holdDays、跳过取价（口径裁决 Q1）。
 */
export interface HoldingDaySnapshot {
  /** SSE 交易日 cal_date，YYYYMMDD。 */
  calDate: string;
  /** 该日是否有有效 quote（qfq_open/qfq_close 均非空且 daily_quote 有行）。 */
  hasQuote: boolean;
  /** 前复权开盘价；停牌日为 null。仅 buy_date 取此作 buyPrice。 */
  qfqOpen: number | null;
  /** 前复权收盘价；停牌日为 null。出场取此作 exitPrice。 */
  qfqClose: number | null;
  /** 未复权开盘价；用于一字涨停判定（与未复权 up_limit 比，判定计价分离）。停牌日 null。 */
  rawOpen: number | null;
  /** 当日涨停价（未复权）；缺失为 null（缺失则不触发涨停过滤）。 */
  upLimit: number | null;
  /**
   * strategy 出场模式下，该日该 ts_code 是否命中**卖出条件**。
   * fixed_n 模式此字段无意义（纯函数不读）；strategy 模式由 DB 层逐日锚定 buildAShareQuery 填充。
   */
  exitSignalHit: boolean;
}

/** 纯函数入参：一个待模拟的买入信号 + 其持有窗口数据。 */
export interface SimulationInput {
  tsCode: string;
  /** 信号日 T（YYYYMMDD）。 */
  signalDate: string;
  /**
   * 持有窗口序列：buy_date(T+1) 起按 SSE 日历升序的连续交易日快照。
   * days[0] 即 buy_date。空数组 → buy_date 越界/未收录 → insufficient_data。
   */
  days: HoldingDaySnapshot[];
  /**
   * 次新过滤：buy_date 在**全局 SSE 日历**升序中的索引，减去 list_date 在同一日历中的索引。
   * 即「buy_date 距 list_date 的 SSE 交易日数」。
   * list_date 缺失/不在日历 → null（保留，不按次新剔除）。
   */
  daysSinceList: number | null;
  /**
   * 退市日（YYYYMMDD），来自 a_share_symbols.delist_date；为空（未退市）→ null（永不触发退市强平）。
   */
  delistDate: string | null;
  /** 出场配置。 */
  exit: ExitConfig;
}

export type ExitConfig =
  | { mode: 'fixed_n'; horizonN: number }
  | { mode: 'strategy'; maxHold: number };

/** 次新过滤阈值：buy_date 距 list_date < 60 个 SSE 交易日 → 剔除。 */
export const NEW_LISTING_MIN_TRADING_DAYS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// 纯计算核心（不依赖 DB，单测主战场）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对一个买入信号做逐笔出场模拟（纯函数）。
 *
 * 流程：入场过滤 → 入场取价 → 出场推进 → 算 ret/holdDays。
 * 任一过滤命中 → { kind:'filtered', reason }；成功 → { kind:'trade', trade }。
 *
 * @param input 信号 + 持有窗口数据序列（buy_date 起升序）
 */
export function simulateTradeCore(input: SimulationInput): SimulationOutcome {
  const { tsCode, signalDate, days, daysSinceList, delistDate, exit } = input;

  // ── 1. 入场：buy_date = days[0]。窗口为空 → buy_date 越界/未收录 → insufficient_data。
  if (days.length === 0) {
    return { kind: 'filtered', reason: 'insufficient_data' };
  }
  const buyDay = days[0];
  const buyDate = buyDay.calDate;

  // ── 2. 入场过滤（顺序：停牌 → 一字涨停 → 次新）。
  //    停牌(隐式)：buy_date 无 quote / qfq_open 空 → suspended。
  if (!buyDay.hasQuote || buyDay.qfqOpen === null) {
    return { kind: 'filtered', reason: 'suspended' };
  }
  //    一字涨停：未复权 open >= 未复权 up_limit（开盘即顶格买不进）。upLimit 缺失则不判。
  if (
    buyDay.rawOpen !== null &&
    buyDay.upLimit !== null &&
    buyDay.rawOpen >= buyDay.upLimit
  ) {
    return { kind: 'filtered', reason: 'limit_up' };
  }
  //    次新：buy_date 距 list_date < 60 个 SSE 交易日 → 剔除。list_date 缺失(null) → 保留。
  if (
    daysSinceList !== null &&
    daysSinceList < NEW_LISTING_MIN_TRADING_DAYS
  ) {
    return { kind: 'filtered', reason: 'new_listing' };
  }

  const buyPrice = buyDay.qfqOpen;

  // ── 3. 出场推进。
  const decision =
    exit.mode === 'fixed_n'
      ? decideFixedN(days, exit.horizonN, delistDate)
      : decideStrategy(days, exit.maxHold, delistDate);

  if (decision === null) {
    // 数据不足以走到出场（窗口在凑满 N / max_hold 前耗尽，且未触发退市）。
    return { kind: 'filtered', reason: 'insufficient_data' };
  }

  const { exitDay, exitReason, holdDays } = decision;
  const exitPrice = exitDay.qfqClose;
  if (exitPrice === null) {
    // 兜底：出场日竟无 qfq_close（理论上 decide* 只会选 hasQuote 日）→ 数据不足。
    return { kind: 'filtered', reason: 'insufficient_data' };
  }

  const ret = exitPrice / buyPrice - 1;

  return {
    kind: 'trade',
    trade: {
      tsCode,
      signalDate,
      buyDate,
      exitDate: exitDay.calDate,
      buyPrice,
      exitPrice,
      ret,
      holdDays,
      exitReason,
    },
  };
}

interface ExitDecision {
  exitDay: HoldingDaySnapshot;
  exitReason: 'max_hold' | 'signal' | 'delist';
  /**
   * 持有期内**实际可交易日**步数（buy_date 记第 0 天；停牌日不递增）。
   *
   * 口径（spec 02 §持有期计数 Q1/Q2）：停牌日「不递增 hold_days」，故 `holdDays` 数的是
   * buy_date 之后已走过的**有 quote 交易日**个数 = 上面 `tradableCount`。
   * 由此 `fixed_n` 模式 holdDays 恒 == N（与 spec「fixed_n 恒等于 N」一致）；
   * 退市强平时 = 退市前已走过的可交易日数。
   *
   * 注：spec 64 行另一句「= buy_date 到 exit_date 的 SSE 交易日步数（含停牌日历步）」与
   * 「不递增 hold_days / fixed_n 恒等于 N」在窗口含停牌日时互斥——取后者（裁决主旨更强），
   * 即 holdDays 只数可交易日，停牌日不计。
   */
  holdDays: number;
}

/**
 * fixed_n 出场：持有到 buy_date 后第 N 个**实际可交易日**（停牌日跳过、不计额度），
 * exit_price = 该日 qfq_close, exit_reason='max_hold'。
 *
 * 计数：days[0]=buy_date 是第 0 个可交易日（已确认有 quote）；从 days[1] 起遇可交易日 +1，
 * 数到第 N 个即出场。holdDays = 已走过可交易日数（= tradableCount），fixed_n 恒 == N。
 *
 * 退市优先：推进中先触发退市则按退市强平。
 * 窗口耗尽仍未凑满 N → null（insufficient_data）。
 */
export function decideFixedN(
  days: HoldingDaySnapshot[],
  horizonN: number,
  delistDate: string | null,
): ExitDecision | null {
  // days[0] = buy_date（调用方已保证 hasQuote）。
  let tradableCount = 0; // 已数到的「可交易持有日」个数（不含 buy_date 第 0 天）
  let lastQuoteIdx = 0;
  let lastQuoteTradable = 0; // lastQuoteIdx 对应的 tradableCount（退市强平时取此作 holdDays）
  for (let i = 1; i < days.length; i++) {
    // 退市先于本日生效？
    if (delistDate !== null && days[i].calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) return null;
      return {
        exitDay: days[lastQuoteIdx],
        exitReason: 'delist',
        holdDays: lastQuoteTradable,
      };
    }
    if (!days[i].hasQuote) continue; // 停牌日：跳过，不占额度、不计 holdDays
    tradableCount++;
    lastQuoteIdx = i;
    lastQuoteTradable = tradableCount;
    if (tradableCount === horizonN) {
      return { exitDay: days[i], exitReason: 'max_hold', holdDays: tradableCount };
    }
  }
  return null; // 窗口不足以凑满 N 且未退市
}

/**
 * strategy 出场：buy_date 之后逐 SSE 交易日 d（从 days[1] 起，buy_date 当天不判）
 * 看 d 是否命中卖出条件（exitSignalHit）。
 *   首次命中 → qfq_close[d], 'signal'。
 *   满 max_hold 个**可交易持有日**仍未命中 → 第 max_hold 个可交易日 qfq_close 强平, 'max_hold'。
 *   退市优先：推进中先触发退市则退市强平。
 * 停牌日跳过（不判卖出、不占 max_hold 额度、不计 holdDays）。
 * 窗口耗尽（既未命中、又没凑满 max_hold、也没退市）→ null（insufficient_data）。
 */
export function decideStrategy(
  days: HoldingDaySnapshot[],
  maxHold: number,
  delistDate: string | null,
): ExitDecision | null {
  let tradableCount = 0;
  let lastQuoteIdx = 0;
  let lastQuoteTradable = 0; // lastQuoteIdx 对应的 tradableCount（退市强平时取此作 holdDays）
  for (let i = 1; i < days.length; i++) {
    if (delistDate !== null && days[i].calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) return null;
      return {
        exitDay: days[lastQuoteIdx],
        exitReason: 'delist',
        holdDays: lastQuoteTradable,
      };
    }
    if (!days[i].hasQuote) continue; // 停牌日：跳过
    tradableCount++;
    lastQuoteIdx = i;
    lastQuoteTradable = tradableCount;
    if (days[i].exitSignalHit) {
      return { exitDay: days[i], exitReason: 'signal', holdDays: tradableCount };
    }
    if (tradableCount === maxHold) {
      return { exitDay: days[i], exitReason: 'max_hold', holdDays: tradableCount };
    }
  }
  return null; // 窗口不足以凑满 max_hold、未命中、未退市
}

// ─────────────────────────────────────────────────────────────────────────────
// 持有窗口构造：共享纯函数（供 DB 层与批量化路径复用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * quoteMap 的值类型：DB 层与批量化路径共用的 quote 行形状。
 * 字段名与 raw.daily_quote 列名对应（camelCase）。
 */
export interface WindowQuote {
  qfqOpen: number | null;
  qfqClose: number | null;
  open: number | null;
}

/**
 * 由「持有窗口日期序列 + quote/limit/exitHit 预取结果」组装 HoldingDaySnapshot[]。
 *
 * 与 simulator.db.ts 内联循环**语义等价**，唯一差异在 exitSignalHit 的判定：
 *   内联版：exitHitDates 来自 windowDates.slice(1) 的查询（buyDate 不在集合），故 days[0] 恒 false。
 *   本函数：hitSet 可能覆盖更大区间（含 buyDate），因此用 `idx > 0` 显式排除 days[0]，
 *   复刻原语义、保证 days[] byte-identical（zero-drift 核心不变量）。
 *
 * @param windowDates  持有窗口的 SSE 交易日数组（buyDate 起升序）
 * @param quoteMap     预取的 quote 行（key=cal_date；停牌日无 key）
 * @param limitMap     预取的涨停价行（key=cal_date；缺失时 upLimit=null）
 * @param hitSet       命中卖出条件的交易日集合（可包含 buyDate，函数内部排除）
 */
export function buildHoldingDays(
  windowDates: string[],
  quoteMap: Map<string, WindowQuote>,
  limitMap: Map<string, number | null>,
  hitSet: Set<string>,
): HoldingDaySnapshot[] {
  return windowDates.map((calDate, idx) => {
    const q = quoteMap.get(calDate);
    const hasQuote = !!q && q.qfqOpen !== null && q.qfqClose !== null;
    return {
      calDate,
      hasQuote,
      qfqOpen: q?.qfqOpen ?? null,
      qfqClose: q?.qfqClose ?? null,
      rawOpen: q?.open ?? null,
      upLimit: limitMap.get(calDate) ?? null,
      exitSignalHit: idx > 0 && hitSet.has(calDate), // idx>0：排除 buyDate（zero-drift 核心不变量）
    };
  });
}

/** 升序数组中 <= target 的最大元素下标（找不到返回 -1）。 */
export function findLastIndexLE(sortedAsc: string[], target: string): number {
  let lo = 0;
  let hi = sortedAsc.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
