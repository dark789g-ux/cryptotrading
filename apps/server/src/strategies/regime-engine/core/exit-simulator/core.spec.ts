import {
  simulateTradeCore,
  NEW_LISTING_MIN_TRADING_DAYS,
} from './index';
import { tradingDay, suspendedDay, baseInput } from './__tests__/fixtures';

describe('simulateTradeCore', () => {
  describe('fixed_n 基本口径', () => {
    it('N=1：买 days[0] qfqOpen，卖 days[1] qfqClose，ret 正确，holdDays=1', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.buyDate).toBe('20260102');
      expect(out.trade.exitDate).toBe('20260103');
      expect(out.trade.buyPrice).toBe(10);
      expect(out.trade.exitPrice).toBe(11);
      expect(out.trade.ret).toBeCloseTo(0.1, 10);
      expect(out.trade.holdDays).toBe(1);
      expect(out.trade.exitReason).toBe('max_hold');
    });

    it('N=3：跨 3 个可交易日，holdDays 恒=N=3', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103'),
        tradingDay('20260106'),
        tradingDay('20260107', { qfqClose: 12 }),
        tradingDay('20260108'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 3 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitPrice).toBe(12);
      expect(out.trade.ret).toBeCloseTo(12 / 10 - 1, 10);
      expect(out.trade.holdDays).toBe(3);
    });
  });

  describe('持有期停牌顺延（Q1）', () => {
    it('fixed_n N=2：中途停牌日不占额度，顺延到下一可交易日', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'),
        tradingDay('20260106'),
        tradingDay('20260107', { qfqClose: 13 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitPrice).toBe(13);
      expect(out.trade.holdDays).toBe(2);
    });
  });

  describe('strategy 首次命中（signal）', () => {
    it('buy_date 当天不判，从下一交易日起；首次 exitSignalHit 日出场', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, exitSignalHit: true }),
        tradingDay('20260103', { exitSignalHit: false }),
        tradingDay('20260106', { qfqClose: 14, exitSignalHit: true }),
        tradingDay('20260107', { exitSignalHit: true }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 10 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(14);
      expect(out.trade.exitReason).toBe('signal');
      expect(out.trade.holdDays).toBe(2);
    });

    it('最短持有 1 交易日：days[1] 即命中', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11, exitSignalHit: true }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 5 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.holdDays).toBe(1);
      expect(out.trade.exitReason).toBe('signal');
    });
  });

  describe('strategy 满 max_hold 强平', () => {
    it('max_hold=2 全程未命中：第 2 个可交易日 qfq_close 强平 max_hold', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { exitSignalHit: false }),
        tradingDay('20260106', { qfqClose: 9, exitSignalHit: false }),
        tradingDay('20260107', { exitSignalHit: false }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(9);
      expect(out.trade.exitReason).toBe('max_hold');
      expect(out.trade.ret).toBeCloseTo(9 / 10 - 1, 10);
      expect(out.trade.holdDays).toBe(2);
    });

    it('strategy 持有期停牌不占 max_hold 额度', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'),
        tradingDay('20260106', { exitSignalHit: false }),
        tradingDay('20260107', { qfqClose: 8, exitSignalHit: false }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 2 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260107');
      expect(out.trade.exitReason).toBe('max_hold');
      expect(out.trade.holdDays).toBe(2);
    });
  });

  describe('退市强平', () => {
    it('持有推进中 cal_date >= delistDate：用之前最后一个有 quote 日 qfq_close 强平 delist', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103'),
        tradingDay('20260106', { qfqClose: 15 }),
        tradingDay('20260107'),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 10 }, { delistDate: '20260107' }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260106');
      expect(out.trade.exitPrice).toBe(15);
      expect(out.trade.exitReason).toBe('delist');
      expect(out.trade.holdDays).toBe(2);
    });

    it('delistDate=null：永不触发退市，正常走 fixed_n', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { delistDate: null }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitReason).toBe('max_hold');
    });

    it('退市在停牌日之后触发：仍用退市前最后有 quote 日强平', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 12 }),
        suspendedDay('20260106'),
        tradingDay('20260107'),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'strategy', maxHold: 10 }, { delistDate: '20260107' }),
      );
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.exitDate).toBe('20260103');
      expect(out.trade.exitPrice).toBe(12);
      expect(out.trade.exitReason).toBe('delist');
    });
  });

  describe('入场过滤', () => {
    it('停牌剔除：buy_date 无 quote → suspended', () => {
      const days = [suspendedDay('20260102'), tradingDay('20260103')];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('suspended');
    });

    it('停牌剔除：buy_date 有行但 qfq_open 空 → suspended', () => {
      const buy = tradingDay('20260102', { qfqOpen: null });
      const days = [buy, tradingDay('20260103')];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('suspended');
    });

    it('一字涨停剔除：rawOpen >= upLimit → limit_up（计价用 qfqOpen 但判定用未复权）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 11, upLimit: 11 }),
        tradingDay('20260103'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('limit_up');
    });

    it('一字涨停边界：rawOpen 恰等于 upLimit 即剔除', () => {
      const days = [
        tradingDay('20260102', { rawOpen: 9.99, upLimit: 9.99 }),
        tradingDay('20260103'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind === 'filtered') expect(out.reason).toBe('limit_up');
    });

    it('未涨停：rawOpen < upLimit 不剔除', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 10.5, upLimit: 11, qfqClose: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
    });

    it('upLimit 缺失：不触发涨停过滤', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10, rawOpen: 99, upLimit: null }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
    });

    it('次新剔除：daysSinceList < 60 → new_listing', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: 59 }),
      );
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('new_listing');
    });

    it('次新边界：daysSinceList=60 恰好不剔除（< 60 才剔）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, {
          daysSinceList: NEW_LISTING_MIN_TRADING_DAYS,
        }),
      );
      expect(out.kind).toBe('trade');
    });

    it('list_date 缺失（daysSinceList=null）：不按次新剔除', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: null }),
      );
      expect(out.kind).toBe('trade');
    });

    it('skipNewListingFilter=true（买入条件显式含 list_days）：daysSinceList < 60 不剔除', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, {
          daysSinceList: 30,
          skipNewListingFilter: true,
        }),
      );
      expect(out.kind).toBe('trade');
    });

    it('skipNewListingFilter=false 显式传：daysSinceList < 60 仍剔除（行为同默认）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { qfqClose: 11 }),
      ];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, {
          daysSinceList: 30,
          skipNewListingFilter: false,
        }),
      );
      expect(out.kind).toBe('filtered');
      if (out.kind === 'filtered') expect(out.reason).toBe('new_listing');
    });

    it('过滤优先级：停牌先于涨停（buy_date 既无 quote 又看似涨停 → suspended）', () => {
      const days = [suspendedDay('20260102'), tradingDay('20260103')];
      const out = simulateTradeCore(
        baseInput(days, { mode: 'fixed_n', horizonN: 1 }, { daysSinceList: 1 }),
      );
      expect(out.kind).toBe('filtered');
      if (out.kind === 'filtered') expect(out.reason).toBe('suspended');
    });
  });

  describe('insufficient_data 边界', () => {
    it('空窗口（buy_date 越界/未收录）→ insufficient_data', () => {
      const out = simulateTradeCore(baseInput([], { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('fixed_n 窗口不足凑满 N 且未退市 → insufficient_data', () => {
      const days = [tradingDay('20260102', { qfqOpen: 10 })];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('fixed_n 窗口全是停牌日（无可交易出场日）→ insufficient_data', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        suspendedDay('20260103'),
        suspendedDay('20260106'),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });

    it('strategy 窗口不足凑满 max_hold 且未命中未退市 → insufficient_data', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 10 }),
        tradingDay('20260103', { exitSignalHit: false }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'strategy', maxHold: 5 }));
      expect(out.kind).toBe('filtered');
      if (out.kind !== 'filtered') return;
      expect(out.reason).toBe('insufficient_data');
    });
  });

  describe('前向收益 ret', () => {
    it('ret = qfq_close[exit]/qfq_open[buy] - 1（负收益）', () => {
      const days = [
        tradingDay('20260102', { qfqOpen: 20 }),
        tradingDay('20260103', { qfqClose: 18 }),
      ];
      const out = simulateTradeCore(baseInput(days, { mode: 'fixed_n', horizonN: 1 }));
      expect(out.kind).toBe('trade');
      if (out.kind !== 'trade') return;
      expect(out.trade.ret).toBeCloseTo(18 / 20 - 1, 10);
    });
  });
});
