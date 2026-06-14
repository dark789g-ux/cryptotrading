/**
 * portfolio-sim.cooldown.spec.ts
 *
 * 引擎熔断段单测（spec 05 / 09 测试计划）：
 *  - 本地副本 vs backtest/engine/cooldown.ts 原版对拍（同输入序列 → 同 state 轨迹）
 *  - 连亏触发 / 盈利缩短 / 自然到期解除
 *  - drawdown 滞回（停 / 维持 / 复）
 *
 * win 口径（net）与同日 round-trip 计入：在 portfolio-sim.engine.spec.ts 端到端验证。
 */

import {
  CooldownState,
  initCooldown,
  isInCooldown,
  registerExit,
  updateDrawdownHalt,
} from './portfolio-sim.cooldown';
import {
  initCooldown as initCooldownOrig,
  isInCooldown as isInCooldownOrig,
  registerExit as registerExitOrig,
  CooldownState as CooldownStateOrig,
} from '../../backtest/engine/cooldown';
import { CircuitBreaker } from './portfolio-sim.types';

// ─────────────────────────────────────────────────────────────────────────────
// 对拍：本地副本 vs backtest 原版（同输入 → 同 state 轨迹）
// ─────────────────────────────────────────────────────────────────────────────
describe('cooldown 对拍 backtest/engine/cooldown.ts', () => {
  it('随机出场序列：两实现逐步 state 完全一致', () => {
    const threshold = 3;
    const maxDays = 10;
    const extendOnLoss = 2;
    const reduceOnProfit = 1;
    const base = 5;

    const local: CooldownState = initCooldown(base);
    const orig: CooldownStateOrig = initCooldownOrig(base);

    // 一段刻意混入连亏 / 盈利 / 冷却期内的出场序列。
    const wins = [
      false, false, false, // 连亏 3 → 触发冷却
      false, // 冷却期内再亏 → 延长
      true, // 盈利 → 缩短 + 清连亏
      false, false, false, // 再连亏 3
      true, true, // 连续盈利
      false, false, false, false, // 连亏 4
    ];

    for (let dayIdx = 0; dayIdx < wins.length; dayIdx++) {
      const isWin = wins[dayIdx];
      registerExit(local, isWin, false, dayIdx, threshold, maxDays, extendOnLoss, reduceOnProfit);
      registerExitOrig(orig, isWin, false, dayIdx, threshold, maxDays, extendOnLoss, reduceOnProfit);
      expect(local.consecLosses).toBe(orig.consecLosses);
      expect(local.cooldownDuration).toBe(orig.cooldownDuration);
      expect(local.cooldownUntilBarIdx).toBe(orig.cooldownUntilBarIdx);

      // 每步也对拍 isInCooldown（含自然到期副作用）。
      const qIdx = dayIdx + 1;
      expect(isInCooldown(local, qIdx)).toBe(isInCooldownOrig(orig, qIdx));
      expect(local.cooldownUntilBarIdx).toBe(orig.cooldownUntilBarIdx);
    }
  });

  it('isHalf=true 两实现都不登记（直接 return）', () => {
    const local = initCooldown(5);
    const orig = initCooldownOrig(5);
    registerExit(local, false, true, 0, 3, 10, 2, 1);
    registerExitOrig(orig, false, true, 0, 3, 10, 2, 1);
    expect(local).toEqual(orig);
    expect(local.consecLosses).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 连亏触发 / 盈利缩短 / 到期解除
// ─────────────────────────────────────────────────────────────────────────────
describe('cooldown 状态机', () => {
  it('连亏达阈值 → 冻结后续 dayIdx；到期自然解除', () => {
    const s = initCooldown(3); // base 3
    const threshold = 2;
    // dayIdx 0 亏、1 亏 → consec=2 >= threshold → until = 1 + 3 = 4
    registerExit(s, false, false, 0, threshold, 10, 0, 0);
    expect(isInCooldown(s, 1)).toBe(false); // 还没触发（第 0 笔后 consec=1）
    registerExit(s, false, false, 1, threshold, 10, 0, 0);
    expect(s.cooldownUntilBarIdx).toBe(4);
    // dayIdx 2,3 冻结，4 解除
    expect(isInCooldown(s, 2)).toBe(true);
    expect(isInCooldown(s, 3)).toBe(true);
    expect(isInCooldown(s, 4)).toBe(false); // 自然到期
    expect(s.cooldownUntilBarIdx).toBeNull();
    expect(s.consecLosses).toBe(0);
  });

  it('盈利缩短 cooldownDuration、清零连亏；归零立即解除', () => {
    const s = initCooldown(2); // base 2
    const threshold = 1;
    // dayIdx 0 亏 → consec=1>=1 → until=0+2=2
    registerExit(s, false, false, 0, threshold, 10, 0, 1);
    expect(s.cooldownUntilBarIdx).toBe(2);
    expect(isInCooldown(s, 1)).toBe(true);
    // dayIdx 1 盈利、reduceOnProfit=1：duration 2→1、consec=0、在冷却期 until 2→1
    registerExit(s, true, false, 1, threshold, 10, 0, 1);
    expect(s.consecLosses).toBe(0);
    expect(s.cooldownDuration).toBe(1);
    expect(s.cooldownUntilBarIdx).toBe(1);
  });

  it('亏损 extendOnLoss 增长 cooldownDuration + 设 until', () => {
    // base=3, extendOnLoss=2, threshold=1：
    //   dayIdx0 亏：duration=min(3+2,10)=5、consec=1>=1 → until=0+5=5。
    const s = initCooldown(3);
    registerExit(s, false, false, 0, 1, 10, 2, 0);
    expect(s.cooldownDuration).toBe(5);
    expect(s.cooldownUntilBarIdx).toBe(5);
    //   dayIdx1 在冷却期（1<5）再亏：duration=min(5+2,10)=7、inCooldown→until 5+2=7、
    //     consec=2>=1 → until=1+7=8。
    registerExit(s, false, false, 1, 1, 10, 2, 0);
    expect(s.cooldownDuration).toBe(7);
    expect(s.cooldownUntilBarIdx).toBe(8);
  });

  it('maxCooldownDays 封顶 cooldownDuration', () => {
    const s = initCooldown(8);
    // base 8、extendOnLoss 5、max 10：duration=min(8+5,10)=10（封顶）。
    registerExit(s, false, false, 0, 1, 10, 5, 0);
    expect(s.cooldownDuration).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// drawdown 滞回
// ─────────────────────────────────────────────────────────────────────────────
describe('updateDrawdownHalt 滞回', () => {
  const cb: CircuitBreaker = {
    enableCooldown: false,
    consecutiveLossesThreshold: 3,
    baseCooldownDays: 0,
    maxCooldownDays: 0,
    extendOnLoss: 0,
    reduceOnProfit: 0,
    enableDrawdownHalt: true,
    drawdownHaltPct: 0.15,
    drawdownResumePct: 0.1,
  };

  it('跌破 haltPct → 停', () => {
    expect(updateDrawdownHalt(false, -0.16, cb)).toBe(true);
    expect(updateDrawdownHalt(false, -0.15, cb)).toBe(true); // 恰等触发线（<=）
  });

  it('未跌破 → 不停', () => {
    expect(updateDrawdownHalt(false, -0.14, cb)).toBe(false);
    expect(updateDrawdownHalt(false, 0, cb)).toBe(false);
  });

  it('滞回区维持原态（已停且回撤介于 resume 与 halt 之间）', () => {
    // 已停，ddNow=-0.12（在 -0.15 与 -0.10 之间）→ 维持停
    expect(updateDrawdownHalt(true, -0.12, cb)).toBe(true);
  });

  it('回升到 resumePct 内 → 复', () => {
    expect(updateDrawdownHalt(true, -0.1, cb)).toBe(false); // 恰等恢复线（>=）
    expect(updateDrawdownHalt(true, -0.05, cb)).toBe(false);
    expect(updateDrawdownHalt(true, 0, cb)).toBe(false);
  });

  it('未停且在滞回区 → 维持不停', () => {
    expect(updateDrawdownHalt(false, -0.12, cb)).toBe(false);
  });
});
