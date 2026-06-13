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
 * DB 访问层见 signal-stats.simulator.db.ts（SignalStatsSimulator、BatchSimulateParams）。
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
  exitReason:
    | 'max_hold'
    | 'signal'
    | 'delist'
    | 'stop'
    | 'ma5_exit'
    | 'phase_lock_stop'
    | 'phase_lock_ma5';
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
  /** 前复权最高价；停牌日为 null。trailing_lock 暂不直接用（信号日 high 走 SimulationInput.signalHigh）。 */
  qfqHigh: number | null;
  /** 前复权最低价；停牌日为 null。trailing_lock 跟踪止损 / 锁定判定基准。 */
  qfqLow: number | null;
  /** 未复权开盘价；用于一字涨停判定（与未复权 up_limit 比，判定计价分离）。停牌日 null。 */
  rawOpen: number | null;
  /** 未复权最高价；用于封死跌停判定（与未复权 down_limit 比）。停牌日 null。 */
  rawHigh: number | null;
  /** 当日涨停价（未复权）；缺失为 null（缺失则不触发涨停过滤）。 */
  upLimit: number | null;
  /** 当日跌停价（未复权）；缺失为 null（缺失则封死跌停约束不生效）。 */
  downLimit: number | null;
  /**
   * 5 个**非停牌交易日**前复权收盘价的均值（含当日）；预热不足（窗口左扩不够 / 早期停牌）为 null。
   * trailing_lock 锁定后 MA5 收盘离场判定基准；fixed_n / strategy 模式不读。
   */
  ma5: number | null;
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
  /**
   * 信号 K 线 T 的前复权最高价 qfq_high(T)。trailing_lock 锁定判定基准（adj_low > signalHigh → 锁定）。
   * 仅 trailing_lock 模式读取；fixed_n / strategy 模式不读（可省略）。
   */
  signalHigh?: number;
  /**
   * phase_lock 初始止损回看序列：含 T+1 的最近 lookback 个**非停牌**复权 low（升序，由数据层切好）。
   * 仅 phase_lock 模式读取；其它模式不读（可省略）。缺失（undefined）按空序列处理 → 无初始止损（核不报错）。
   */
  recentLows?: number[];
  /**
   * 跳过次新硬过滤（NEW_LISTING_MIN_TRADING_DAYS）：buyConditions 显式含 list_days（上市时长）
   * 条件时为 true——以用户条件为准，不再按"上市不足 60 个 SSE 交易日"剔除。默认 false（行为不变）。
   */
  skipNewListingFilter?: boolean;
  /** 出场配置。 */
  exit: ExitConfig;
}

export type ExitConfig =
  | { mode: 'fixed_n'; horizonN: number }
  | { mode: 'strategy'; maxHold: number }
  | {
      mode: 'trailing_lock';
      maxHold?: number;
      /** 止损缓冲系数（基准价向下留缓冲），默认 0.999；覆盖 4 处止损基准 × 系数。 */
      stopRatio?: number;
      /** 成本地板系数（floorPrice = floor2(cost × floorRatio)），默认 0.999；>1 从「保本」变「锁盈」。 */
      floorRatio?: number;
      /** 是否启用方案二成本地板，默认 true；false 时三处地板逻辑全部短路。 */
      floorEnabled?: boolean;
      /** 锁定后 MA5 离场是否要求均线下行（ma5 < prevMa5），默认 true；false 时只要收盘跌破 MA5 即离场。 */
      ma5RequireDown?: boolean;
    }
  | {
      mode: 'phase_lock';
      /** 初始止损系数（× min(recentLows)）；已量化的网格点（核不再量化）。 */
      initFactor: number;
      /** 锁定止损系数（× max(cost, 当日 low)）；已量化的网格点。initFactor / lockFactor 互不串用。 */
      lockFactor: number;
      /** 初始止损回看根数（recentLows 的目标长度，由数据层切好；核只对收到的 recentLows 取 min）。 */
      lookback: number;
    };

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
  //    skipNewListingFilter（买入条件显式含 list_days）→ 整条跳过，以用户条件为准。
  if (
    !input.skipNewListingFilter &&
    daysSinceList !== null &&
    daysSinceList < NEW_LISTING_MIN_TRADING_DAYS
  ) {
    return { kind: 'filtered', reason: 'new_listing' };
  }

  const buyPrice = buyDay.qfqOpen;

  // ── 3. 出场推进。
  let decision: ExitDecision | null;
  if (exit.mode === 'fixed_n') {
    decision = decideFixedN(days, exit.horizonN, delistDate);
  } else if (exit.mode === 'strategy') {
    decision = decideStrategy(days, exit.maxHold, delistDate);
  } else if (exit.mode === 'trailing_lock') {
    // trailing_lock：signalHigh 缺失视为无效输入 → 数据不足（不静默当 0/Infinity 处理）。
    if (input.signalHigh === undefined) {
      return { kind: 'filtered', reason: 'insufficient_data' };
    }
    decision = decideBandLock(days, {
      signalHigh: input.signalHigh,
      maxHold: exit.maxHold,
      delistDate,
      stopRatio: exit.stopRatio,
      floorRatio: exit.floorRatio,
      floorEnabled: exit.floorEnabled,
      ma5RequireDown: exit.ma5RequireDown,
    });
  } else {
    // phase_lock：recentLows 由数据层切好（含 T+1 的最近 lookback 个非停牌复权 low，升序）。
    //   缺失（undefined）→ 空序列 → 核视为无初始止损（不报错，与 Python core 一致）。
    //   decidePhaseLock 返回 Outcome（与 Python 同构）；这里翻译为 ExitDecision/filtered。
    //   退市分支与 band_lock 同口径，由 decidePhaseLock 内部接管。
    const outcome = decidePhaseLock(days, input.recentLows ?? [], {
      initFactor: exit.initFactor,
      lockFactor: exit.lockFactor,
      lookback: exit.lookback,
      delistDate,
    });
    if (outcome.kind === 'no_entry') {
      // 入场端理论上已被 simulateTradeCore 前置过滤挡住；冗余防御：suspended→suspended，limit_up→limit_up。
      return { kind: 'filtered', reason: outcome.reason === 'limit_up' ? 'limit_up' : 'suspended' };
    }
    if (outcome.kind === 'no_exit') {
      decision = null; // 窗口耗尽未出场 → insufficient_data。
    } else {
      decision = {
        exitDay: days[outcome.exitIndex!],
        exitReason: outcome.reason as ExitDecision['exitReason'],
        exitPrice: outcome.exitPrice ?? undefined,
        holdDays: outcome.holdDays,
      };
    }
  }

  if (decision === null) {
    // 数据不足以走到出场（窗口在凑满 N / max_hold 前耗尽，且未触发退市/止损/MA5）。
    return { kind: 'filtered', reason: 'insufficient_data' };
  }

  const { exitDay, exitReason, holdDays } = decision;
  // trailing_lock 的止损成交价≠qfq_close（跳空低开取 open），由 decision 显式给出 exitPrice；
  // fixed_n / strategy / delist 不给（undefined）→ 沿用历史口径取 exit_day 的 qfq_close。
  const exitPrice = decision.exitPrice ?? exitDay.qfqClose;
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
  exitReason: 'max_hold' | 'signal' | 'delist' | 'stop' | 'ma5_exit';
  /**
   * 显式出场成交价（前复权）。trailing_lock 止损成交价≠qfq_close（跳空低开取 open，故 min(stop,open)），
   * 由 decideBandLock 给出；其余 decide*（fixed_n/strategy/delist）不给 → simulateTradeCore 回退取 exitDay.qfqClose。
   */
  exitPrice?: number;
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
// 波段跟踪止损 trailing_lock —— 与 Python 共享核 band_lock_exit.py 同构（单一真值）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 向下截断到 0.01（跨语言逐位一致，与 Python `math.floor(x*100)/100` 给出相同结果）。
 *
 * 统一先 `x*100`、`Math.floor`、再 `/100`；**不要**用字符串截断。
 * 例：floor2(9.99)=9.99；floor2(10.4895)=10.48；floor2(10.567×0.999)=10.55。
 */
export function floor2(x: number): number {
  return Math.floor(x * 100) / 100;
}

/** decideBandLock 选项。 */
export interface BandLockOptions {
  /** 信号 K 线 T 的前复权最高价 qfq_high(T)。锁定判定基准。 */
  signalHigh: number;
  /** 可选硬上限（已走过可交易持有日数）；undefined = 不封顶。 */
  maxHold?: number;
  /** 退市日（YYYYMMDD）；null=未退市，永不触发退市强平。 */
  delistDate: string | null;
  /** 止损缓冲系数（基准价向下留缓冲），undefined → 默认 0.999；覆盖 4 处止损基准 × 系数。 */
  stopRatio?: number;
  /** 成本地板系数（floorPrice = floor2(cost × floorRatio)），undefined → 默认 0.999；>1 从「保本」变「锁盈」。仅 floorEnabled=true 时生效。 */
  floorRatio?: number;
  /** 是否启用方案二成本地板，undefined → 默认 true；false 时三处地板逻辑全部短路。 */
  floorEnabled?: boolean;
  /** 锁定后 MA5 离场是否要求均线下行（ma5 < prevMa5），undefined → 默认 true；false 时只要收盘跌破 MA5 即离场。prevMa5 仍照常维护。 */
  ma5RequireDown?: boolean;
}

/**
 * 封死跌停（卖不出）：raw_high ≤ down_limit。
 * down_limit 缺失（null）→ 该端约束不生效，视为可卖（非封死）。
 * raw_high 缺失（null）→ 无从判定封板，保守视为可卖（不因缺数据误顺延）。
 */
function isDeadLimitDown(day: HoldingDaySnapshot): boolean {
  if (day.downLimit === null || day.rawHigh === null) return false;
  return day.rawHigh <= day.downLimit;
}

/**
 * trailing_lock 出场：波段跟踪止损 + 锁定 + 锁定后 MA5 收盘离场 + 封死跌停顺延（同构 Python 共享核）。
 *
 * 与 Python `simulate_band_lock` 逐行对应（规范见 01-rule-semantics.md §三）：
 * - 入场端（停牌 / 一字涨停 / 次新）由 simulateTradeCore 先行过滤，本函数只接管 buyPrice 之后的出场推进。
 * - days[0] = buy_date(T+1)；从 days[1] 起逐日推进；停牌日（hasQuote=false）跳过（不计 hold/不触发/不更新/不动 prev_ma5）。
 * - 止损成交价（stop）≠ qfq_close（跳空低开取 open，故 min(stop_eff, open)），由返回的 exitPrice 显式给出。
 * - 核函数不处理退市：signal-stats 在此**额外**接 delistDate 分支（沿用 decideFixedN/decideStrategy 口径，
 *   reason='delist'、用退市前最后一个有 quote 日 qfq_close 强平），与现有两模式一致。
 * - 窗口耗尽未出场（含顺延未解）→ null（insufficient_data），与现有口径一致。
 */
export function decideBandLock(
  days: HoldingDaySnapshot[],
  opts: BandLockOptions,
): ExitDecision | null {
  const { signalHigh, maxHold, delistDate } = opts;
  // 参数旋钮：undefined 落默认（与现状逐字等价；核接收已量化的网格点 ratio，不做 ratio 量化）。
  const stopRatio = opts.stopRatio ?? 0.999;
  const floorRatio = opts.floorRatio ?? 0.999;
  const floorEnabled = opts.floorEnabled ?? true;
  const ma5RequireDown = opts.ma5RequireDown ?? true;
  if (days.length === 0) return null;
  const entry = days[0]; // 调用方已保证 hasQuote 且 qfqOpen 非空

  const cost = entry.qfqOpen!;
  // 方案 1：持仓首日 close > open；否则方案 2。
  const scheme =
    entry.qfqClose !== null && entry.qfqClose > entry.qfqOpen! ? 1 : 2;

  // 持仓首日“收盘后”设定、T+2 生效的初始止损。
  let stopNext: number | null;
  if (scheme === 1) {
    stopNext = floor2(entry.qfqOpen! * stopRatio);
  } else {
    // 方案二初始止损用 qfq_low；缺失则退回 qfq_open（防御，正常数据不缺）。
    const baseLow = entry.qfqLow !== null ? entry.qfqLow : entry.qfqOpen!;
    stopNext = floor2(baseLow * stopRatio);
  }

  let locked = false;
  let floorActive = false;
  let pending: 'stop' | 'ma5_exit' | null = null;
  let hold = 0;
  let prevMa5 = entry.ma5;
  const floorPrice = floor2(cost * floorRatio); // 方案二保本地板价（常量；floorEnabled=false 时不参与）

  // 退市强平兜底：记录退市前最后一个有 quote 日（与 decideFixedN/decideStrategy 同口径）。
  let lastQuoteIdx = 0;
  let lastQuoteHold = 0;

  for (let i = 1; i < days.length; i++) {
    const bar = days[i];

    // 退市先于本日生效？沿用现有口径：用退市前最后一个有 quote 日 qfq_close 强平。
    if (delistDate !== null && bar.calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) return null;
      return {
        exitDay: days[lastQuoteIdx],
        exitReason: 'delist',
        holdDays: lastQuoteHold,
      };
    }

    // 先判停牌：不计 hold / 不触发 / 不更新止损 / 不动 prevMa5。
    if (!bar.hasQuote) continue;

    hold += 1;
    lastQuoteIdx = i;
    lastQuoteHold = hold;
    const stopEff = stopNext; // 今日生效 = 昨日收盘设定的。
    const deadLimitDown = isDeadLimitDown(bar);

    // (0) 顺延中（pending ≠ null）
    if (pending !== null) {
      if (!deadLimitDown) {
        // 非封死跌停 → 出场 @qfq_open，reason 保留（非停牌日 hasQuote 保证 qfqOpen 非空）。
        return {
          exitDay: bar,
          exitReason: pending,
          exitPrice: bar.qfqOpen ?? undefined,
          holdDays: hold,
        };
      }
      // 仍封死 → 继续顺延。
      continue;
    }

    // (1) 日内止损
    if (stopEff !== null && bar.qfqLow !== null && bar.qfqLow <= stopEff) {
      if (deadLimitDown) {
        // 封死跌停卖不出 → 置 pending，顺延。
        pending = 'stop';
        continue;
      }
      // 跳空低开（open < stop）按开盘价成交 → 取 min(stop_eff, qfq_open)。
      const fill = bar.qfqOpen !== null ? Math.min(stopEff, bar.qfqOpen) : stopEff;
      return { exitDay: bar, exitReason: 'stop', exitPrice: fill, holdDays: hold };
    }

    // (2) 收盘处理（未被止损）
    // (2-pre) 方案二保本地板激活（每个交易日都评估，含锁定当日；sticky）。
    if (floorEnabled && scheme === 2 && bar.qfqClose !== null && bar.qfqClose > cost) {
      floorActive = true;
    }

    // (2a) 未锁定 且 qfq_low > signalHigh → 锁定。
    if (!locked && bar.qfqLow !== null && bar.qfqLow > signalHigh) {
      stopNext = floor2(bar.qfqLow * stopRatio);
      if (floorEnabled && scheme === 2 && floorActive) {
        stopNext = Math.max(stopNext, floorPrice);
      }
      locked = true; // 从此冻结，stopNext 不再更新。
    }

    if (locked) {
      // (2b) 已锁定（含本日刚锁定）→ MA5 收盘离场。
      //   恒判 close<ma5；ma5<prevMa5（均线下行）一项由 ma5RequireDown 门控。
      let ma5ExitHit =
        bar.ma5 !== null && bar.qfqClose !== null && bar.qfqClose < bar.ma5;
      if (ma5RequireDown) {
        ma5ExitHit = ma5ExitHit && prevMa5 !== null && bar.ma5! < prevMa5;
      }
      if (ma5ExitHit) {
        if (deadLimitDown) {
          // 封死跌停 → 置 pending，顺延（本日不再评估 max_hold）。
          pending = 'ma5_exit';
          prevMa5 = bar.ma5;
          continue;
        }
        return {
          exitDay: bar,
          exitReason: 'ma5_exit',
          exitPrice: bar.qfqClose,
          holdDays: hold,
        };
      }
    } else {
      // (2c) 未锁定 → 更新次日止损 stopNext。
      if (bar.qfqLow !== null) {
        const lowStop = floor2(bar.qfqLow * stopRatio);
        if (floorEnabled && scheme === 2 && floorActive) {
          stopNext = Math.max(lowStop, floorPrice);
        } else {
          stopNext = lowStop;
        }
      }
      // qfq_low 缺失（停牌已被上面跳过，这里基本不会发生）→ 保持 stopNext 不变。
    }

    // (2d) max_hold 兜底。
    if (maxHold !== undefined && hold >= maxHold) {
      return {
        exitDay: bar,
        exitReason: 'max_hold',
        exitPrice: bar.qfqClose ?? undefined,
        holdDays: hold,
      };
    }

    prevMa5 = bar.ma5;
  }

  // 窗口耗尽未出场（含顺延未解）→ null（insufficient_data，由 simulateTradeCore 收口）。
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段锁定 phase_lock —— 与 Python 共享核 phase_lock_exit.py 同构（单一真值）
// ─────────────────────────────────────────────────────────────────────────────

/** decidePhaseLock 选项（含 delistDate；ExitConfig variant 只携带前三个 factor/lookback）。 */
export interface PhaseLockOptions {
  /** 初始止损系数（× min(recentLows)）；已量化的网格点，核不再量化。 */
  initFactor: number;
  /** 锁定止损系数（× max(cost, 当日 low)）；已量化的网格点。initFactor / lockFactor 互不串用。 */
  lockFactor: number;
  /** 初始止损回看根数（recentLows 的目标长度）；核只对收到的 recentLows 取 min，不自己切片。 */
  lookback: number;
  /** 退市日（YYYYMMDD）；null=未退市，永不触发退市强平。 */
  delistDate: string | null;
}

/**
 * decidePhaseLock 返回（与 Python `PhaseLockOutcome` 同构，逐字段镜像 test_phase_lock_exit.py 期望）。
 *
 * no_entry / no_exit 路径也带 `locked` / `holdDays`，与 D1 数值权威源逐位对齐。
 * `exitIndex` = 命中出场那根在 days 中的下标（kind='exit' 时非空）。
 */
export interface PhaseLockOutcome {
  kind: 'no_entry' | 'exit' | 'no_exit';
  /** no_entry: 'suspended'|'limit_up'；exit: 'phase_lock_stop'|'phase_lock_ma5'|'delist'。 */
  reason: 'suspended' | 'limit_up' | 'phase_lock_stop' | 'phase_lock_ma5' | 'delist' | null;
  /** 命中出场那根的 days 下标（kind='exit' 非空）。 */
  exitIndex: number | null;
  /** 出场成交价（前复权）；止损跳空低开取 min(stop, open)；ma5/delist 取 qfq_close（由调用方回退）。 */
  exitPrice: number | null;
  /** 已走过可交易持有日数（持仓首日不计；停牌不计）。 */
  holdDays: number;
  /** 是否曾进入阶段 B（调试/统计用，与 Python locked 对齐）。 */
  locked: boolean;
}

/**
 * phase_lock 出场：两阶段锁定止损（初始止损固定 → 收盘站上 MA5↑ 锁定上移 → 阶段 B 收盘破 MA5↓ 清仓 + 跌停顺延）。
 *
 * 与 Python `simulate_phase_lock` **逐行对应**（规范见 01-algorithm.md），数值权威源为
 * test_phase_lock_exit.py（S1~S15）。返回 PhaseLockOutcome（与 Python 同构，含 no_entry/no_exit 的
 * locked/holdDays），由 simulateTradeCore 翻译为 ExitDecision/filtered。映射约定：
 *   adj_open→qfqOpen, adj_high→qfqHigh, adj_low→qfqLow, adj_close→qfqClose, ma5→ma5,
 *   raw_open→rawOpen, raw_high→rawHigh, up_limit→upLimit, down_limit→downLimit；
 *   停牌（_is_suspended）→ hasQuote=false（与 buildHoldingDays 口径一致）。
 *
 * - days[0] = buy_date(T+1)；从 days[1] 起逐日推进；停牌日（hasQuote=false）跳过。
 * - 与 band_lock 核心差异：阶段 A 初始止损**固定不上移**（band_lock 逐日用当日 low 抬升）。
 * - 止损成交价（stop）≠ qfq_close（跳空低开取 open，故 min(stop_eff, open)），由 exitPrice 显式给出。
 * - recentLows 由数据层切好（含 T+1 的最近 lookback 个非停牌复权 low，升序）；空 → 无初始止损。
 * - 核函数不处理退市：signal-stats 在此**额外**接 delistDate 分支（沿用 decideBandLock 口径，
 *   reason='delist'、用退市前最后一个有 quote 日 qfq_close 强平）。
 * - 入场端（停牌 / 一字涨停）也复刻 Python 的 no_entry（便于 spec 逐数值对拍）；
 *   生产路径上 simulateTradeCore 已前置过滤，no_entry 仅作冗余防御。
 */
export function decidePhaseLock(
  days: HoldingDaySnapshot[],
  recentLows: number[],
  opts: PhaseLockOptions,
): PhaseLockOutcome {
  const { initFactor, lockFactor, delistDate } = opts;
  if (days.length === 0) {
    return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }

  const entry = days[0];

  // ---- 入场（bars[0] = 持仓首日 T+1），与 Python 同构 ----
  // 停牌 / 无 quote → 信号不成立。
  if (!entry.hasQuote || entry.qfqOpen === null) {
    return { kind: 'no_entry', reason: 'suspended', exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }
  // 涨停开盘不入场 = raw_open ≥ up_limit（仅入场端；两者非空才生效）。
  if (entry.upLimit !== null && entry.rawOpen !== null && entry.rawOpen >= entry.upLimit) {
    return { kind: 'no_entry', reason: 'limit_up', exitIndex: null, exitPrice: null, holdDays: 0, locked: false };
  }

  const cost = entry.qfqOpen;

  // 阶段 A 初始止损（固定，不上移）：min(recentLows) × init_factor。
  // recentLows 已由数据层切好；空 → 无初始止损（null）。
  const initStop: number | null =
    recentLows.length === 0 ? null : floor2(Math.min(...recentLows) * initFactor);

  let stopNext: number | null = initStop; // T+2 起盘中生效（持仓首日 T+1 不出场）
  let locked = false;
  let pending: 'phase_lock_stop' | 'phase_lock_ma5' | null = null;
  let hold = 0;
  let prevMa5 = entry.ma5;

  // 退市强平兜底：记录退市前最后一个有 quote 日（与 decideBandLock 同口径）。
  let lastQuoteIdx = 0;
  let lastQuoteHold = 0;

  for (let i = 1; i < days.length; i++) {
    const bar = days[i];

    // 退市先于本日生效？沿用现有口径：用退市前最后一个有 quote 日 qfq_close 强平。
    if (delistDate !== null && bar.calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) {
        return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: hold, locked };
      }
      return {
        kind: 'exit',
        reason: 'delist',
        exitIndex: lastQuoteIdx,
        exitPrice: null, // delist 不给成交价 → simulateTradeCore 回退取 exitDay.qfqClose。
        holdDays: lastQuoteHold,
        locked,
      };
    }

    // 先判停牌：不计 hold / 不触发 / 不更新止损 / 不动 prevMa5。
    if (!bar.hasQuote) continue;

    hold += 1;
    lastQuoteIdx = i;
    lastQuoteHold = hold;
    const stopEff = stopNext; // 今日生效 = 昨日收盘设定的（阶段切换当日设的新止损次日才进这里）。
    const deadLimitDown = isDeadLimitDown(bar);

    // (0) 顺延中（上日封死跌停未能出场）
    if (pending !== null) {
      if (!deadLimitDown) {
        // 非封死跌停 → 出场 @qfq_open，reason 保留（非停牌日 hasQuote 保证 qfqOpen 非空）。
        return {
          kind: 'exit',
          reason: pending,
          exitIndex: i,
          exitPrice: bar.qfqOpen,
          holdDays: hold,
          locked,
        };
      }
      // 仍封死 → 继续顺延。
      continue;
    }

    // (1) 盘中止损 [最高优先]
    if (stopEff !== null && bar.qfqLow !== null && bar.qfqLow <= stopEff) {
      if (deadLimitDown) {
        // 封死跌停卖不出 → 置 pending，顺延。
        pending = 'phase_lock_stop';
        continue;
      }
      // 跳空低开（open < stop）按开盘价成交 → 取 min(stop_eff, qfq_open)。
      const fill = bar.qfqOpen !== null ? Math.min(stopEff, bar.qfqOpen) : stopEff;
      return {
        kind: 'exit',
        reason: 'phase_lock_stop',
        exitIndex: i,
        exitPrice: fill,
        holdDays: hold,
        locked,
      };
    }

    // (2) 收盘判断（当日未触止损）
    if (!locked) {
      // 阶段切换：close > MA5 且 MA5 > prevMa5（ma5_require_up 钉死 true），仅一次。
      // 切换当日设的新止损**次日生效**（当日已过盘中止损检查）；切换日不评估清仓。
      if (
        bar.ma5 !== null &&
        prevMa5 !== null &&
        bar.qfqClose !== null &&
        bar.qfqClose > bar.ma5 &&
        bar.ma5 > prevMa5
      ) {
        // max(cost, 当日 low)；adj_low 缺失（停牌已跳过，正常不发生）退回 cost。
        const base = bar.qfqLow !== null ? Math.max(cost, bar.qfqLow) : cost;
        stopNext = floor2(base * lockFactor); // 上移并冻结
        locked = true;
      }
      // 否则：stopNext 保持初始值不变（阶段 A 固定——与 band_lock 逐日上移的关键差异！）
    } else {
      // 阶段 B：清仓 close < MA5 且 MA5 < prevMa5（ma5_require_down 钉死 true）
      if (
        bar.ma5 !== null &&
        bar.qfqClose !== null &&
        bar.qfqClose < bar.ma5 &&
        prevMa5 !== null &&
        bar.ma5 < prevMa5
      ) {
        if (deadLimitDown) {
          // 封死跌停卖不出 → 置 pending，顺延（prevMa5 仍照常推进）。
          pending = 'phase_lock_ma5';
          prevMa5 = bar.ma5;
          continue;
        }
        return {
          kind: 'exit',
          reason: 'phase_lock_ma5',
          exitIndex: i,
          exitPrice: bar.qfqClose,
          holdDays: hold,
          locked,
        };
      }
      // 否则：止损冻结，stopNext 不变。
    }

    prevMa5 = bar.ma5;
  }

  // 窗口耗尽未出场（含顺延未解）→ no_exit（带 locked/holdDays，与 Python 对齐）。
  return { kind: 'no_exit', reason: null, exitIndex: null, exitPrice: null, holdDays: hold, locked };
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
  /**
   * trailing_lock 新增列（可选：fixed_n/strategy 路径不填、不读 → 缺失即 null，行为零漂移）。
   * qfqHigh/qfqLow/high(=rawHigh) 取自 raw.daily_quote 同行；ma5 由 DB 层在 qfq_close 序列上滚动现算。
   */
  qfqHigh?: number | null;
  qfqLow?: number | null;
  high?: number | null;
  ma5?: number | null;
}

/**
 * buildHoldingDays 的可选附加数据（trailing_lock 用；fixed_n/strategy 省略 → 字段全 null）。
 */
export interface HoldingDayExtras {
  /** 跌停价（未复权）映射（key=cal_date；缺失时 downLimit=null）。 */
  downLimitMap?: Map<string, number | null>;
}

/**
 * 由「持有窗口日期序列 + quote/limit/exitHit 预取结果」组装 HoldingDaySnapshot[]。
 *
 * 与 simulator.db.ts 内联循环**语义等价**，唯一差异在 exitSignalHit 的判定：
 *   内联版：exitHitDates 来自 windowDates.slice(1) 的查询（buyDate 不在集合），故 days[0] 恒 false。
 *   本函数：hitSet 可能覆盖更大区间（含 buyDate），因此用 `idx > 0` 显式排除 days[0]，
 *   复刻原语义、保证 days[] byte-identical（zero-drift 核心不变量）。
 *
 * trailing_lock 新字段（qfqHigh/qfqLow/rawHigh/downLimit/ma5）：从 WindowQuote 可选字段 + extras 取；
 * fixed_n/strategy 路径不填这些 → 全 null，纯函数也不读，故现有两模式行为零漂移。
 *
 * @param windowDates  持有窗口的 SSE 交易日数组（buyDate 起升序）
 * @param quoteMap     预取的 quote 行（key=cal_date；停牌日无 key）
 * @param limitMap     预取的涨停价行（key=cal_date；缺失时 upLimit=null）
 * @param hitSet       命中卖出条件的交易日集合（可包含 buyDate，函数内部排除）
 * @param extras       可选附加数据（downLimitMap；trailing_lock 用）
 */
export function buildHoldingDays(
  windowDates: string[],
  quoteMap: Map<string, WindowQuote>,
  limitMap: Map<string, number | null>,
  hitSet: Set<string>,
  extras?: HoldingDayExtras,
): HoldingDaySnapshot[] {
  const downLimitMap = extras?.downLimitMap;
  return windowDates.map((calDate, idx) => {
    const q = quoteMap.get(calDate);
    const hasQuote = !!q && q.qfqOpen !== null && q.qfqClose !== null;
    return {
      calDate,
      hasQuote,
      qfqOpen: q?.qfqOpen ?? null,
      qfqClose: q?.qfqClose ?? null,
      qfqHigh: q?.qfqHigh ?? null,
      qfqLow: q?.qfqLow ?? null,
      rawOpen: q?.open ?? null,
      rawHigh: q?.high ?? null,
      upLimit: limitMap.get(calDate) ?? null,
      downLimit: downLimitMap?.get(calDate) ?? null,
      ma5: q?.ma5 ?? null,
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
