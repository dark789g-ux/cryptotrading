/**
 * portfolio-sim.cooldown.ts
 *
 * 引擎熔断段（纯函数，不依赖 DB / NestJS）。spec 05 §cooldown 移植 + 回撤滞回。
 *
 * 连亏熔断部分逐行移植 `backtest/engine/cooldown.ts`（K 线无关纯状态机），**本地副本**
 * （不 import backtest 模块，避免跨市场耦合）。barIdx 语义换成「交易日序号 dayIdx」。
 * 账户级（跨所有 source 合并一个 state）；isHalf 恒 false（portfolio-sim 无半仓概念）。
 *
 * 回撤熔断 updateDrawdownHalt 为新增滞回函数（spec 05 §回撤熔断）。
 */

import { CircuitBreaker } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 连亏熔断状态机（移植 backtest/engine/cooldown.ts，barIdx → dayIdx）
// ─────────────────────────────────────────────────────────────────────────────

export interface CooldownState {
  /** 当前连续亏损次数。 */
  consecLosses: number;
  /** 当前冷却时长（交易日数），持久维护，范围 [0, maxCooldownDays]。 */
  cooldownDuration: number;
  /** 冷却到期的 dayIdx（含），null 表示当前不处于冷却期。 */
  cooldownUntilBarIdx: number | null;
}

/**
 * 初始化冷却状态。
 * @param base baseCooldownDays 初始冷却时长。
 */
export function initCooldown(base: number): CooldownState {
  return {
    consecLosses: 0,
    cooldownDuration: base,
    cooldownUntilBarIdx: null,
  };
}

/**
 * 登记一笔完整平仓的出场结果，更新冷却状态（原地修改）。
 *
 * 规则（与 backtest/engine/cooldown.ts 逐行一致）：
 * - isHalf=true 直接 return；
 * - 亏损（isWin=false）：cooldownDuration=min(+extendOnLoss, maxCooldownDays)、consecLosses++；
 *     处于冷却期 → cooldownUntilBarIdx += extendOnLoss；
 *     consecLosses >= threshold → cooldownUntilBarIdx = dayIdx + cooldownDuration；
 * - 盈利（isWin=true）：cooldownDuration=max(-reduceOnProfit, 0)、consecLosses=0；
 *     处于冷却期 → cooldownUntilBarIdx -= reduceOnProfit；
 *     cooldownDuration==0 → cooldownUntilBarIdx=null（立即解除）。
 *
 * @param state          冷却状态（原地修改）
 * @param isWin          true = 净盈利，false = 净亏损/平
 * @param isHalf         是否半仓（portfolio-sim 恒 false）
 * @param dayIdx         当前交易日序号
 */
export function registerExit(
  state: CooldownState,
  isWin: boolean,
  isHalf: boolean,
  dayIdx: number,
  consecutiveLossesThreshold: number,
  maxCooldownDays: number,
  extendOnLoss: number,
  reduceOnProfit: number,
): void {
  if (isHalf) return;

  const inCooldown =
    state.cooldownUntilBarIdx !== null && dayIdx < state.cooldownUntilBarIdx;

  if (!isWin) {
    // ── 亏损路径 ──
    state.cooldownDuration = Math.min(
      state.cooldownDuration + extendOnLoss,
      maxCooldownDays,
    );
    state.consecLosses += 1;

    if (inCooldown) {
      state.cooldownUntilBarIdx = state.cooldownUntilBarIdx! + extendOnLoss;
    }

    if (state.consecLosses >= consecutiveLossesThreshold) {
      state.cooldownUntilBarIdx = dayIdx + state.cooldownDuration;
    }
  } else {
    // ── 盈利路径 ──
    state.cooldownDuration = Math.max(state.cooldownDuration - reduceOnProfit, 0);
    state.consecLosses = 0;

    if (inCooldown) {
      state.cooldownUntilBarIdx = state.cooldownUntilBarIdx! - reduceOnProfit;
    }

    if (state.cooldownDuration === 0) {
      state.cooldownUntilBarIdx = null;
    }
  }
}

/**
 * 查询当前 dayIdx 是否处于冷却期（原地处理自然到期）。
 *
 * cooldownUntilBarIdx 非 null 且 curDayIdx >= cooldownUntilBarIdx → 自然到期：
 *   清零 consecLosses、cooldownUntilBarIdx=null（cooldownDuration 保留）。
 */
export function isInCooldown(state: CooldownState, curDayIdx: number): boolean {
  if (state.cooldownUntilBarIdx === null) return false;

  if (curDayIdx >= state.cooldownUntilBarIdx) {
    state.consecLosses = 0;
    state.cooldownUntilBarIdx = null;
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 回撤熔断（滞回，spec 05 §回撤熔断）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回撤熔断滞回状态转移。
 *
 *   ddNow ≤ 0（回撤为负值）；drawdownHaltPct/ResumePct 为正。
 *   未停且跌破触发线（ddNow ≤ -haltPct）       → true（停）
 *   已停且回升到恢复线内（ddNow ≥ -resumePct） → false（复）
 *   否则                                        → 维持原态（滞回区不抖动）
 *
 * @param prevHalted 上一日是否处于停开仓态
 * @param ddNow      当前回撤（prevNav/peak − 1，≤0）
 * @param cb         熔断配置（取 drawdownHaltPct/drawdownResumePct）
 */
export function updateDrawdownHalt(
  prevHalted: boolean,
  ddNow: number,
  cb: CircuitBreaker,
): boolean {
  if (!prevHalted && ddNow <= -cb.drawdownHaltPct) return true;
  if (prevHalted && ddNow >= -cb.drawdownResumePct) return false;
  return prevHalted;
}
