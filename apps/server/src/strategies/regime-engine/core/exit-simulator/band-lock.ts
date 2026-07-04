/**
 * exit-simulator/band-lock.ts
 *
 * 波段跟踪止损 trailing_lock：floor2 / isDeadLimitDown / decideBandLock。
 * 从 signal-stats.simulator.ts 迁移，逻辑不变。
 */

import { HoldingDaySnapshot, ExitDecision, BandLockOptions } from './types';

/**
 * 向下截断到 0.01（跨语言逐位一致，与 Python `math.floor(x*100)/100` 给出相同结果）。
 *
 * 统一先 `x*100`、`Math.floor`、再 `/100`；**不要**用字符串截断。
 * 例：floor2(9.99)=9.99；floor2(10.4895)=10.48；floor2(10.567×0.999)=10.55。
 */
export function floor2(x: number): number {
  return Math.floor(x * 100) / 100;
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
  const stopRatio = opts.stopRatio ?? 0.999;
  const floorRatio = opts.floorRatio ?? 0.999;
  const floorEnabled = opts.floorEnabled ?? true;
  const ma5RequireDown = opts.ma5RequireDown ?? true;
  if (days.length === 0) return null;
  const entry = days[0];

  const cost = entry.qfqOpen!;
  const scheme =
    entry.qfqClose !== null && entry.qfqClose > entry.qfqOpen! ? 1 : 2;

  let stopNext: number | null;
  if (scheme === 1) {
    stopNext = floor2(entry.qfqOpen! * stopRatio);
  } else {
    const baseLow = entry.qfqLow !== null ? entry.qfqLow : entry.qfqOpen!;
    stopNext = floor2(baseLow * stopRatio);
  }

  let locked = false;
  let floorActive = false;
  let pending: 'stop' | 'ma5_exit' | null = null;
  let hold = 0;
  let prevMa5 = entry.ma5;
  const floorPrice = floor2(cost * floorRatio);

  let lastQuoteIdx = 0;
  let lastQuoteHold = 0;

  for (let i = 1; i < days.length; i++) {
    const bar = days[i];

    if (delistDate !== null && bar.calDate >= delistDate) {
      if (lastQuoteIdx < 0 || days[lastQuoteIdx].qfqClose === null) return null;
      return {
        exitDay: days[lastQuoteIdx],
        exitReason: 'delist',
        holdDays: lastQuoteHold,
      };
    }

    if (!bar.hasQuote) continue;

    hold += 1;
    lastQuoteIdx = i;
    lastQuoteHold = hold;
    const stopEff = stopNext;
    const deadLimitDown = isDeadLimitDown(bar);

    // (0) 顺延中（pending ≠ null）
    if (pending !== null) {
      if (!deadLimitDown) {
        return {
          exitDay: bar,
          exitReason: pending,
          exitPrice: bar.qfqOpen ?? undefined,
          holdDays: hold,
        };
      }
      continue;
    }

    // (1) 日内止损
    if (stopEff !== null && bar.qfqLow !== null && bar.qfqLow <= stopEff) {
      if (deadLimitDown) {
        pending = 'stop';
        continue;
      }
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
      locked = true;
    }

    if (locked) {
      // (2b) 已锁定（含本日刚锁定）→ MA5 收盘离场。
      let ma5ExitHit =
        bar.ma5 !== null && bar.qfqClose !== null && bar.qfqClose < bar.ma5;
      if (ma5RequireDown) {
        ma5ExitHit = ma5ExitHit && prevMa5 !== null && bar.ma5! < prevMa5;
      }
      if (ma5ExitHit) {
        if (deadLimitDown) {
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

  return null;
}
