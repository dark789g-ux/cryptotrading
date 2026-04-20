/**
 * 账户级冷却期管理（重构版）
 *
 * 将原先 per-symbol 的 setCooldown + LossTracker 两套机制合并为
 * 一个账户级 CooldownState，统一在引擎主循环中维护。
 */

export interface CooldownState {
  /** 当前连续亏损次数 */
  consecLosses: number;
  /** 当前冷却时长（根数），持久维护，范围 [0, maxCooldownCandles] */
  cooldownDuration: number;
  /** 冷却到期的 barIdx（含），null 表示当前不处于冷却期 */
  cooldownUntilBarIdx: number | null;
}

/**
 * 初始化冷却状态。
 * @param base baseCooldownCandles 初始冷却时长
 */
export function initCooldown(base: number): CooldownState {
  return {
    consecLosses: 0,
    cooldownDuration: base,
    cooldownUntilBarIdx: null,
  };
}

/**
 * 登记一笔完整平仓（非半仓）的出场结果，更新冷却状态。
 *
 * 规则：
 * - isHalf=true 直接 return，不登记
 * - 亏损（pnl <= 0）：
 *     cooldownDuration = min(cooldownDuration+extendOnLoss, maxCooldownCandles)
 *     consecLosses++
 *     若当前处于冷却期（cooldownUntilBarIdx != null && barIdx < cooldownUntilBarIdx）
 *       → cooldownUntilBarIdx += extendOnLoss（延长冷却）
 *     若 consecLosses >= threshold → 设置/刷新 cooldownUntilBarIdx = barIdx + cooldownDuration
 * - 盈利（pnl > 0）：
 *     cooldownDuration = max(cooldownDuration-reduceOnProfit, 0)
 *     consecLosses = 0
 *     若当前处于冷却期 → cooldownUntilBarIdx -= reduceOnProfit（缩短冷却）
 *     若 cooldownDuration == 0 → cooldownUntilBarIdx = null（立即解除）
 *
 * @param state              冷却状态（原地修改）
 * @param isWin              true = pnl > 0（盈利），false = pnl <= 0（亏损/平）
 * @param isHalf             是否半仓交易
 * @param barIdx             当前 K 线全局索引
 * @param consecutiveLossesThreshold  连续亏损触发冷却的阈值
 * @param maxCooldownCandles          最大冷却时长上限
 * @param extendOnLoss                每次亏损为冷却时长/结束 bar 增加的根数（非负整数）
 * @param reduceOnProfit              每次盈利为冷却时长/结束 bar 减少的根数（非负整数）
 */
export function registerExit(
  state: CooldownState,
  isWin: boolean,
  isHalf: boolean,
  barIdx: number,
  consecutiveLossesThreshold: number,
  maxCooldownCandles: number,
  extendOnLoss: number,
  reduceOnProfit: number,
): void {
  // 半仓交易不参与冷却统计
  if (isHalf) return;

  const inCooldown =
    state.cooldownUntilBarIdx !== null && barIdx < state.cooldownUntilBarIdx;

  if (!isWin) {
    // ── 亏损路径 ──
    state.cooldownDuration = Math.min(state.cooldownDuration + extendOnLoss, maxCooldownCandles);
    state.consecLosses += 1;

    if (inCooldown) {
      state.cooldownUntilBarIdx = state.cooldownUntilBarIdx! + extendOnLoss;
    }

    if (state.consecLosses >= consecutiveLossesThreshold) {
      // 达到或超过阈值 → 设置/刷新冷却结束点
      state.cooldownUntilBarIdx = barIdx + state.cooldownDuration;
    }
  } else {
    // ── 盈利路径 ──
    state.cooldownDuration = Math.max(state.cooldownDuration - reduceOnProfit, 0);
    state.consecLosses = 0;

    if (inCooldown) {
      state.cooldownUntilBarIdx = state.cooldownUntilBarIdx! - reduceOnProfit;
    }

    if (state.cooldownDuration === 0) {
      // 冷却时长归零 → 立即解除冷却
      state.cooldownUntilBarIdx = null;
    }
  }
}

/**
 * 查询当前 barIdx 是否处于冷却期。
 *
 * 若 cooldownUntilBarIdx 不为 null 且 curBarIdx >= cooldownUntilBarIdx
 * → 冷却自然到期：清零 consecLosses，cooldownUntilBarIdx = null（cooldownDuration 保留）。
 *
 * @param state      冷却状态（原地修改：处理自然到期）
 * @param curBarIdx  当前 K 线全局索引
 */
export function isInCooldown(state: CooldownState, curBarIdx: number): boolean {
  if (state.cooldownUntilBarIdx === null) return false;

  if (curBarIdx >= state.cooldownUntilBarIdx) {
    // 冷却自然到期
    state.consecLosses = 0;
    state.cooldownUntilBarIdx = null;
    return false;
  }

  return true;
}
