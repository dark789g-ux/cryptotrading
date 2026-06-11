/**
 * portfolio-sim.cost.spec.ts
 *
 * 成本模型纯函数单测：买/卖费率拆解 + 印花税时变（字符串比较边界）+ 预设档。
 */

import {
  buyRate,
  sellRate,
  stampRateForExitDate,
  STAMP_HALVE_DATE,
  COST_PRESET_OPTIMISTIC,
  COST_PRESET_REALISTIC,
  COST_PRESET_CONSERVATIVE,
  COST_PRESET_ZERO,
  COMMISSION_REALISTIC,
  TRANSFER_REALISTIC,
  STAMP_BEFORE,
  STAMP_FROM,
  SLIPPAGE_REALISTIC,
} from './portfolio-sim.cost';
import { PortfolioSimCostRates } from './portfolio-sim.types';

describe('portfolio-sim cost model', () => {
  // ───────────────────────────────────────────────
  // 印花税时变（字符串比较，禁 new Date）
  // ───────────────────────────────────────────────
  describe('stampRateForExitDate（印花税时变）', () => {
    it('exitDate=20230825（减半前）→ 0.001', () => {
      expect(stampRateForExitDate(COST_PRESET_REALISTIC, '20230825')).toBe(
        STAMP_BEFORE,
      );
    });

    it('exitDate=20230828（减半生效首日）→ 0.0005（>= 边界包含）', () => {
      expect(stampRateForExitDate(COST_PRESET_REALISTIC, '20230828')).toBe(
        STAMP_FROM,
      );
    });

    it('exitDate=20230827（减半前一日）→ 0.001', () => {
      expect(stampRateForExitDate(COST_PRESET_REALISTIC, '20230827')).toBe(
        STAMP_BEFORE,
      );
    });

    it('exitDate=20240101（远在减半后）→ 0.0005', () => {
      expect(stampRateForExitDate(COST_PRESET_REALISTIC, '20240101')).toBe(
        STAMP_FROM,
      );
    });

    it('STAMP_HALVE_DATE 常量 = 20230828', () => {
      expect(STAMP_HALVE_DATE).toBe('20230828');
    });
  });

  // ───────────────────────────────────────────────
  // 买入费率（与卖出日无关）
  // ───────────────────────────────────────────────
  describe('buyRate', () => {
    it('= commission + transfer + slippage（不含印花税）', () => {
      // 现实档：0.00025 + 0.00001 + 0.0005 = 0.00076
      expect(buyRate(COST_PRESET_REALISTIC)).toBeCloseTo(
        COMMISSION_REALISTIC + TRANSFER_REALISTIC + SLIPPAGE_REALISTIC,
        12,
      );
      expect(buyRate(COST_PRESET_REALISTIC)).toBeCloseTo(0.00076, 12);
    });

    it('零成本档 buyRate = 0', () => {
      expect(buyRate(COST_PRESET_ZERO)).toBe(0);
    });
  });

  // ───────────────────────────────────────────────
  // 卖出费率（含印花税，随 exitDate 变）
  // ───────────────────────────────────────────────
  describe('sellRate', () => {
    it('减半前：commission + transfer + 0.001 + slippage', () => {
      // 0.00025 + 0.00001 + 0.001 + 0.0005 = 0.00176
      expect(sellRate(COST_PRESET_REALISTIC, '20230825')).toBeCloseTo(
        0.00025 + 0.00001 + STAMP_BEFORE + SLIPPAGE_REALISTIC,
        12,
      );
      expect(sellRate(COST_PRESET_REALISTIC, '20230825')).toBeCloseTo(
        0.00176,
        12,
      );
    });

    it('减半后：commission + transfer + 0.0005 + slippage', () => {
      // 0.00025 + 0.00001 + 0.0005 + 0.0005 = 0.00126
      expect(sellRate(COST_PRESET_REALISTIC, '20230828')).toBeCloseTo(
        0.00025 + 0.00001 + STAMP_FROM + SLIPPAGE_REALISTIC,
        12,
      );
      expect(sellRate(COST_PRESET_REALISTIC, '20230828')).toBeCloseTo(
        0.00126,
        12,
      );
    });

    it('同一档：卖出费率 = 买入费率 + 印花税', () => {
      const r = COST_PRESET_REALISTIC;
      expect(sellRate(r, '20230828')).toBeCloseTo(
        buyRate(r) + STAMP_FROM,
        12,
      );
    });

    it('零成本档 sellRate = 0（任意 exitDate）', () => {
      expect(sellRate(COST_PRESET_ZERO, '20230825')).toBe(0);
      expect(sellRate(COST_PRESET_ZERO, '20240101')).toBe(0);
    });
  });

  // ───────────────────────────────────────────────
  // 预设档：滑点单调（乐观 < 现实 < 保守），其余字段一致
  // ───────────────────────────────────────────────
  describe('预设档', () => {
    it('滑点逐档递增：乐观 0 < 现实 0.0005 < 保守 0.001', () => {
      expect(COST_PRESET_OPTIMISTIC.slippagePerSide).toBe(0);
      expect(COST_PRESET_REALISTIC.slippagePerSide).toBe(0.0005);
      expect(COST_PRESET_CONSERVATIVE.slippagePerSide).toBe(0.001);
    });

    it('三现实档佣金/过户费/印花税一致', () => {
      const presets: PortfolioSimCostRates[] = [
        COST_PRESET_OPTIMISTIC,
        COST_PRESET_REALISTIC,
        COST_PRESET_CONSERVATIVE,
      ];
      for (const p of presets) {
        expect(p.commissionPerSide).toBe(COMMISSION_REALISTIC);
        expect(p.transferPerSide).toBe(TRANSFER_REALISTIC);
        expect(p.stampSellBefore20230828).toBe(STAMP_BEFORE);
        expect(p.stampSellFrom20230828).toBe(STAMP_FROM);
      }
    });

    it('买/卖费率逐档单调递增（乐观 < 现实 < 保守）', () => {
      expect(buyRate(COST_PRESET_OPTIMISTIC)).toBeLessThan(
        buyRate(COST_PRESET_REALISTIC),
      );
      expect(buyRate(COST_PRESET_REALISTIC)).toBeLessThan(
        buyRate(COST_PRESET_CONSERVATIVE),
      );
      const d = '20230828';
      expect(sellRate(COST_PRESET_OPTIMISTIC, d)).toBeLessThan(
        sellRate(COST_PRESET_REALISTIC, d),
      );
      expect(sellRate(COST_PRESET_REALISTIC, d)).toBeLessThan(
        sellRate(COST_PRESET_CONSERVATIVE, d),
      );
    });

    it('零成本档全 0', () => {
      expect(COST_PRESET_ZERO.commissionPerSide).toBe(0);
      expect(COST_PRESET_ZERO.transferPerSide).toBe(0);
      expect(COST_PRESET_ZERO.stampSellBefore20230828).toBe(0);
      expect(COST_PRESET_ZERO.stampSellFrom20230828).toBe(0);
      expect(COST_PRESET_ZERO.slippagePerSide).toBe(0);
    });
  });
});
