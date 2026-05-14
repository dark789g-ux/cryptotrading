import { SnapshotBuilderService } from './snapshot-builder.service';
import { DataSource } from 'typeorm';
import type { OvernightMarketService } from './overnight/overnight-market.service';
import type { MacroCalendarService } from './macro/macro-calendar.service';
import type { ReviewHistoryService } from './history/review-history.service';

describe('SnapshotBuilderService', () => {
  let svc: SnapshotBuilderService;
  let mockDs: Partial<DataSource>;
  let mockTushare: any;
  let mockOvernight: jest.Mocked<Pick<OvernightMarketService, 'fetch'>>;
  let mockMacro: jest.Mocked<Pick<MacroCalendarService, 'fetchToday'>>;
  let mockHistory: jest.Mocked<Pick<ReviewHistoryService, 'previousSummary'>>;

  beforeEach(() => {
    mockDs = { query: jest.fn().mockResolvedValue([{ count: 0 }]) };
    mockTushare = { query: jest.fn().mockResolvedValue([]) };
    mockOvernight = { fetch: jest.fn().mockResolvedValue(null) };
    mockMacro = { fetchToday: jest.fn().mockResolvedValue(null) };
    mockHistory = { previousSummary: jest.fn().mockResolvedValue(null) };
    svc = new SnapshotBuilderService(
      mockDs as DataSource,
      mockTushare,
      mockOvernight as unknown as OvernightMarketService,
      mockMacro as unknown as MacroCalendarService,
      mockHistory as unknown as ReviewHistoryService,
    );
  });

  describe('validate', () => {
    it('A 股日线无数据时抛错', async () => {
      await expect(svc.validate('20260512')).rejects.toThrow(/A 股日线/);
    });

    it('有数据时不抛错', async () => {
      (mockDs.query as jest.Mock).mockResolvedValueOnce([{ count: 100 }]);
      await expect(svc.validate('20260512')).resolves.toBeUndefined();
    });
  });

  describe('aggregateUpdown', () => {
    it('按板块阈值正确计算涨停/跌停/上涨/下跌', async () => {
      (mockDs.query as jest.Mock).mockResolvedValueOnce([
        { up: '3000', down: '1500', flat: '200', limit_up: '80', limit_down: '5' },
      ]);
      const r = await svc.aggregateUpdown('20260512');
      expect(r).toEqual({
        updownDist: { up: 3000, down: 1500, flat: 200, limitUp: 80, limitDown: 5 },
        limitStats: { upCount: 80, downCount: 5, brokenCount: 0 },
      });
    });
  });

  describe('aggregateSectors', () => {
    it('行业取 pct_chg 降序前 10', async () => {
      (mockDs.query as jest.Mock)
        .mockResolvedValueOnce([
          { name: '半导体', pct_chg: '6.59' },
          { name: '光通信', pct_chg: '5.21' },
        ])
        .mockResolvedValueOnce([]);
      const r = await svc.aggregateSectors('20260512');
      expect(r.industryRank[0]).toEqual({ name: '半导体', pctChg: 6.59 });
    });
  });

  describe('aggregateMoneyFlow', () => {
    it('返回市场净流入 + 个股 TOP/BOTTOM 20', async () => {
      (mockDs.query as jest.Mock)
        .mockResolvedValueOnce([{ main_net_in: '12345600' }])
        .mockResolvedValueOnce([{ ts_code: '688256.SH', name: '寒武纪', main_net_in: '4000000000' }])
        .mockResolvedValueOnce([{ ts_code: '601318.SH', name: '中国平安', main_net_in: '-2500000000' }]);
      const r = await svc.aggregateMoneyFlow('20260512');
      // DB 单位「万元」→ snapshot 单位「元」，乘 10000
      expect(r.market.mainNetIn).toBe(123456000000);
      expect(r.stocksTopIn[0].mainNetIn).toBe(40000000000000);
      expect(r.stocksTopOut[0].mainNetIn).toBe(-25000000000000);
    });
  });

  describe('aggregateStrongAndVolume', () => {
    it('过滤 ST、取 TOP20', async () => {
      (mockDs.query as jest.Mock)
        .mockResolvedValueOnce([{ ts_code: '688256.SH', name: '寒武纪', pct_chg: '20.0', turnover_rate: '15.2' }])
        .mockResolvedValueOnce([{ ts_code: '600519.SH', name: '贵州茅台', amount: '4500000000', pct_chg: '0.5' }]);
      const r = await svc.aggregateStrongAndVolume('20260512');
      expect(r.strongStocks[0].pctChg).toBe(20.0);
      // DB 单位「千元」→ snapshot 单位「元」，乘 1000
      expect(r.volumeTop[0].amount).toBe(4500000000000);
    });
  });

  describe('fetchIndices', () => {
    it('拼装 4 个指数', async () => {
      (mockTushare.query as jest.Mock)
        .mockResolvedValueOnce([{ ts_code: '000001.SH', close: '4225.02', pct_chg: '1.08', amount: '450000000' }])
        .mockResolvedValueOnce([{ ts_code: '399001.SZ', close: '13280', pct_chg: '1.42', amount: '380000000' }])
        .mockResolvedValueOnce([{ ts_code: '399006.SZ', close: '2870', pct_chg: '1.85', amount: '180000000' }])
        .mockResolvedValueOnce([{ ts_code: '000688.SH', close: '1430', pct_chg: '4.65', amount: '90000000' }]);
      const r = await svc.fetchIndices('20260512');
      expect(r).toHaveLength(4);
      // Tushare index_daily.amount 单位「千元」→ snapshot 单位「元」，乘 1000
      expect(r[0]).toMatchObject({ tsCode: '000001.SH', name: '上证指数', close: 4225.02, pctChg: 1.08, amount: 450000000000 });
    });
  });

  describe('buildSnapshot', () => {
    const stubAggregations = () => {
      jest.spyOn(svc, 'validate').mockResolvedValue(undefined);
      jest.spyOn(svc, 'aggregateUpdown').mockResolvedValue({
        updownDist: { up: 1, down: 1, flat: 0, limitUp: 0, limitDown: 0 },
        limitStats: { upCount: 0, downCount: 0, brokenCount: 0 },
      });
      jest.spyOn(svc, 'aggregateSectors').mockResolvedValue({ industryRank: [], conceptRank: [] });
      jest.spyOn(svc, 'aggregateMoneyFlow').mockResolvedValue({
        market: { mainNetIn: 0 }, stocksTopIn: [], stocksTopOut: [],
      });
      jest.spyOn(svc, 'aggregateStrongAndVolume').mockResolvedValue({ strongStocks: [], volumeTop: [] });
      jest.spyOn(svc, 'fetchIndices').mockResolvedValue([]);
    };

    it('串联所有子聚合，输出 SnapshotPayload（含三块新字段）', async () => {
      stubAggregations();
      mockOvernight.fetch.mockResolvedValueOnce({
        usIndices: [{ name: '道琼斯', close: 40000, pctChg: 0.5, quotedAt: '2026-05-12T00:00:00Z' }],
        chipStocks: [],
        chinaConcepts: [],
        commodities: [],
      });
      mockMacro.fetchToday.mockResolvedValueOnce({
        todayEvents: [{ time: '10:00', event: 'CPI', importance: 'high' }],
        upcomingEvents: [],
      });
      mockHistory.previousSummary.mockResolvedValueOnce({
        tradeDate: '20260511',
        nextDayJudgmentExcerpt: '昨日判断：关注半导体',
      });
      const r = await svc.buildSnapshot('20260512');
      expect(r.generatedAt).toMatch(/T/);
      expect(r.updownDist.up).toBe(1);
      expect(r.overnight?.usIndices[0].name).toBe('道琼斯');
      expect(r.macroCalendar?.todayEvents[0].event).toBe('CPI');
      expect(r.previousReviewSummary?.tradeDate).toBe('20260511');
      expect(mockOvernight.fetch).toHaveBeenCalledWith('20260512');
      expect(mockMacro.fetchToday).toHaveBeenCalledWith('20260512');
      expect(mockHistory.previousSummary).toHaveBeenCalledWith(1);
    });

    it('overnight 返回 null 时整体 snapshot 仍构造成功', async () => {
      stubAggregations();
      mockOvernight.fetch.mockResolvedValueOnce(null);
      mockMacro.fetchToday.mockResolvedValueOnce({ todayEvents: [], upcomingEvents: [] });
      mockHistory.previousSummary.mockResolvedValueOnce({
        tradeDate: '20260511',
        nextDayJudgmentExcerpt: '',
      });
      const r = await svc.buildSnapshot('20260512');
      expect(r.overnight).toBeNull();
      expect(r.macroCalendar).not.toBeNull();
      expect(r.previousReviewSummary).not.toBeNull();
    });

    it('macroCalendar 返回 null 时整体 snapshot 仍构造成功', async () => {
      stubAggregations();
      mockOvernight.fetch.mockResolvedValueOnce({
        usIndices: [], chipStocks: [], chinaConcepts: [], commodities: [],
      });
      mockMacro.fetchToday.mockResolvedValueOnce(null);
      mockHistory.previousSummary.mockResolvedValueOnce(null);
      const r = await svc.buildSnapshot('20260512');
      expect(r.macroCalendar).toBeNull();
      expect(r.overnight).not.toBeNull();
    });

    it('previousReviewSummary 返回 null 时整体 snapshot 仍构造成功', async () => {
      stubAggregations();
      mockOvernight.fetch.mockResolvedValueOnce(null);
      mockMacro.fetchToday.mockResolvedValueOnce(null);
      mockHistory.previousSummary.mockResolvedValueOnce(null);
      const r = await svc.buildSnapshot('20260512');
      expect(r.previousReviewSummary).toBeNull();
      expect(r.overnight).toBeNull();
      expect(r.macroCalendar).toBeNull();
      expect(r.updownDist.up).toBe(1);
    });
  });
});
