import { ConfigService } from '@nestjs/config';
import { OvernightMarketService } from './overnight-market.service';
import type { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';

type MockTushare = { query: jest.Mock };

const TRADE_DATE = '20260512';

function buildConfig(value: string | undefined): ConfigService {
  return {
    get: jest.fn().mockReturnValue(value),
  } as unknown as ConfigService;
}

describe('OvernightMarketService', () => {
  let tushare: MockTushare;
  let svc: OvernightMarketService;

  beforeEach(() => {
    tushare = { query: jest.fn() };
    svc = new OvernightMarketService(
      tushare as unknown as TushareClientService,
      buildConfig(undefined),
    );
  });

  describe('开关', () => {
    it('DAILY_REVIEW_OVERNIGHT_ENABLED=false 时直接返回 null，不调 Tushare', async () => {
      svc = new OvernightMarketService(
        tushare as unknown as TushareClientService,
        buildConfig('false'),
      );
      const res = await svc.fetch(TRADE_DATE);
      expect(res).toBeNull();
      expect(tushare.query).not.toHaveBeenCalled();
    });

    it('未配置 / 配置非 false 时正常拉取', async () => {
      tushare.query.mockResolvedValue([]);
      const res = await svc.fetch(TRADE_DATE);
      expect(res).not.toBeNull();
      // 美股指数 3 档 + 芯片股 3 档 + 中概 1 档 = 7 次 query（commodities 不调 Tushare）
      expect(tushare.query).toHaveBeenCalledTimes(7);
    });
  });

  describe('正常拉取', () => {
    it('指数 + 个股拉取成功时各档字段齐全', async () => {
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      // 用 apiName + ts_code 路由 mock，避免 Promise.all 并发消费 mockOnce 队列乱序
      const fixture: Record<string, Record<string, any>> = {
        index_global: {
          DJI: { ts_code: 'DJI', trade_date: TRADE_DATE, close: 39000, pct_chg: 0.8 },
          IXIC: { ts_code: 'IXIC', trade_date: TRADE_DATE, close: 16500, pct_chg: 1.5 },
          SPX: { ts_code: 'SPX', trade_date: TRADE_DATE, close: 5200, pct_chg: 1.1 },
        },
        us_daily: {
          NVDA: { ts_code: 'NVDA', trade_date: TRADE_DATE, close: 900, pct_change: 3.2 },
          MU: { ts_code: 'MU', trade_date: TRADE_DATE, close: 110, pct_change: 2.5 },
          INTC: { ts_code: 'INTC', trade_date: TRADE_DATE, close: 35, pct_change: -1.2 },
          BABA: { ts_code: 'BABA', trade_date: TRADE_DATE, close: 80, pct_change: 0.5 },
        },
      };
      tushare.query.mockImplementation(async (apiName: string, params: Record<string, any>) => {
        const row = fixture[apiName]?.[String(params.ts_code)];
        return row ? [row] : [];
      });

      const res = await svc.fetch(TRADE_DATE);
      expect(res).not.toBeNull();

      expect(res!.usIndices).toEqual([
        { name: '道琼斯工业指数', close: 39000, pctChg: 0.8, quotedAt: '2026-05-12T00:00:00Z' },
        { name: '纳斯达克指数', close: 16500, pctChg: 1.5, quotedAt: '2026-05-12T00:00:00Z' },
        { name: '标普500指数', close: 5200, pctChg: 1.1, quotedAt: '2026-05-12T00:00:00Z' },
      ]);

      expect(res!.chipStocks).toEqual([
        { ticker: 'NVDA', pctChg: 3.2, note: '英伟达' },
        { ticker: 'MU', pctChg: 2.5, note: '美光科技' },
        { ticker: 'INTC', pctChg: -1.2, note: '英特尔' },
      ]);

      expect(res!.chinaConcepts).toEqual([
        { ticker: 'BABA', pctChg: 0.5, note: '阿里巴巴' },
      ]);

      // commodities 当前无 Tushare 接口，固定空数组 + warn
      expect(res!.commodities).toEqual([]);
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes('[overnight_commodity_unsupported]'))).toBe(true);

      warnSpy.mockRestore();
    });

    it('精确日期匹配不到时回落到最近一条记录', async () => {
      // index_global 三次 + us_daily 四次，全部返回最近交易日（与 tradeDate 不一致）
      const olderDate = '20260511';
      tushare.query.mockResolvedValue([
        { ts_code: 'X', trade_date: olderDate, close: 100, pct_chg: 1.0, pct_change: 1.0 },
      ]);

      const res = await svc.fetch(TRADE_DATE);
      expect(res!.usIndices).toHaveLength(3);
      expect(res!.usIndices[0].quotedAt).toBe('2026-05-11T00:00:00Z');
      expect(res!.chipStocks).toHaveLength(3);
    });
  });

  describe('部分失败降级', () => {
    it('部分 ticker 抛错时返回剩余字段并 warn 含 apiName + params', async () => {
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      // 用 apiName + ts_code 路由 mock：
      //   DJI 成功 / IXIC 抛错 / SPX 空 / 芯片股全空 / BABA 抛错
      tushare.query.mockImplementation(async (apiName: string, params: Record<string, any>) => {
        const code = String(params.ts_code);
        if (apiName === 'index_global') {
          if (code === 'DJI') {
            return [{ ts_code: 'DJI', trade_date: TRADE_DATE, close: 39000, pct_chg: 0.8 }];
          }
          if (code === 'IXIC') {
            throw new Error('TuShare index_global 调用失败：积分不足');
          }
          return []; // SPX
        }
        if (apiName === 'us_daily') {
          if (code === 'BABA') throw new Error('boom');
          return []; // 芯片股
        }
        return [];
      });

      const res = await svc.fetch(TRADE_DATE);

      expect(res).not.toBeNull();
      expect(res!.usIndices).toEqual([
        { name: '道琼斯工业指数', close: 39000, pctChg: 0.8, quotedAt: '2026-05-12T00:00:00Z' },
      ]);
      expect(res!.chipStocks).toEqual([]);
      expect(res!.chinaConcepts).toEqual([]);

      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      // 抛错 / 空 都要分别 warn，且包含 apiName 与完整 params（spec §12 / CLAUDE.md 第三方 API 规范）
      expect(warnCalls.some((m) => m.includes('apiName=index_global') && m.includes('IXIC'))).toBe(true);
      expect(warnCalls.some((m) => m.includes('apiName=index_global') && m.includes('SPX'))).toBe(true);
      expect(warnCalls.some((m) => m.includes('apiName=us_daily') && m.includes('NVDA'))).toBe(true);
      expect(warnCalls.some((m) => m.includes('apiName=us_daily') && m.includes('BABA'))).toBe(true);

      warnSpy.mockRestore();
    });
  });
});
