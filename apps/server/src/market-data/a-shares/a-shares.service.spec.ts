/**
 * a-shares.service.spec.ts
 *
 * 单测 ASharesService.getKlines 的日期区间参数扩展：
 *   1. 不传 range → params=[tsCode, safeLimit]，SQL 不含 trade_date 区间
 *   2. 传 {startDate, endDate} → params=[tsCode, startDate, endDate, safeLimit]，含两段约束
 *   3. 只传 startDate → params=[tsCode, startDate, safeLimit]，只含 >=
 *   4. 只传 endDate   → params=[tsCode, endDate, safeLimit]，只含 <=
 * 不连真 DB，mock dataSource.query 返回空数组。
 */

import { ASharesService } from './a-shares.service';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
import { BadRequestException } from '@nestjs/common';

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 折叠连续空白，便于子串匹配（不受缩进/换行影响）。 */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── mock 工厂 ─────────────────────────────────────────────────────────────────

function makeQueryDataSourceMock() {
  return { query: jest.fn().mockResolvedValue([]) };
}

function makeKlinesDataSourceMock() {
  return {
    query: jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        status: 'none',
        sinceDate: null,
        timing: null,
        lastQuoteTradeDate: '20240710',
        asOfTradeDate: '20240710',
      }]),
  };
}

function makeService(dataSource: ReturnType<typeof makeQueryDataSourceMock>): ASharesService {
  // ASharesService 构造函数：symbolRepo, dataSource, syncService
  // getKlines 只碰 dataSource，其余 null 即可。
  return new ASharesService(null as never, dataSource as never, null as never);
}

// ── 辅助：调用并取 dataSource.query 的实参 ────────────────────────────────────

async function callGetKlines(
  service: ASharesService,
  dataSource: ReturnType<typeof makeKlinesDataSourceMock>,
  args: Parameters<ASharesService['getKlines']>,
): Promise<{ sql: string; params: unknown[]; suspendSql: string; suspendParams: unknown[] }> {
  await service.getKlines(...args);
  const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
  const [suspendSql, suspendParams] = dataSource.query.mock.calls[1] as [string, unknown[]];
  return { sql, params, suspendSql, suspendParams };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('ASharesService.getKlines - 日期区间参数', () => {
  const tsCode = '000001.SZ';
  const defaultLimit = 300;
  const safeLimit = 300; // Math.min(1000, Math.max(30, 300)) = 300

  describe('不传 range（向后兼容）', () => {
    it('params 数组为 [tsCode, safeLimit]，并行查询 suspend', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { params, suspendParams } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', undefined]);
      expect(params).toEqual([tsCode, safeLimit]);
      expect(suspendParams).toEqual([tsCode]);
      expect(ds.query).toHaveBeenCalledTimes(2);
    });

    it('SQL 不含 trade_date 区间约束', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', undefined]);
      const flat = squash(sql);
      expect(flat).not.toContain('trade_date >=');
      expect(flat).not.toContain('trade_date <=');
    });
  });

  describe('传 {startDate, endDate}', () => {
    const startDate = '20240101';
    const endDate = '20240630';

    it('params 数组为 [tsCode, startDate, endDate, safeLimit]', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate, endDate }]);
      expect(params).toEqual([tsCode, startDate, endDate, safeLimit]);
    });

    it('SQL 含 q.trade_date >= $2 且 q.trade_date <= $3，LIMIT $4', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate, endDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date >= $2');
      expect(flat).toContain('q.trade_date <= $3');
      expect(flat).toContain('LIMIT $4');
    });
  });

  describe('只传 startDate', () => {
    const startDate = '20240101';

    it('params 数组为 [tsCode, startDate, safeLimit]', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate }]);
      expect(params).toEqual([tsCode, startDate, safeLimit]);
    });

    it('SQL 含 q.trade_date >= $2，不含 <=，LIMIT $3', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date >= $2');
      expect(flat).not.toContain('trade_date <=');
      expect(flat).toContain('LIMIT $3');
    });
  });

  describe('只传 endDate', () => {
    const endDate = '20240630';

    it('params 数组为 [tsCode, endDate, safeLimit]', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { endDate }]);
      expect(params).toEqual([tsCode, endDate, safeLimit]);
    });

    it('SQL 含 q.trade_date <= $2，不含 >=，LIMIT $3', async () => {
      const ds = makeKlinesDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { endDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date <= $2');
      expect(flat).not.toContain('trade_date >=');
      expect(flat).toContain('LIMIT $3');
    });
  });
});

describe('ASharesService.getKlines - suspend 响应', () => {
  const tsCode = '000008.SZ';

  it('返回 { bars, suspend } 包装，suspend 含 asOfTradeDate', async () => {
    const ds = makeKlinesDataSourceMock();
    ds.query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        status: 'suspended',
        sinceDate: '20260707',
        timing: null,
        lastQuoteTradeDate: '20260706',
        asOfTradeDate: '20260710',
      }]);
    const svc = makeService(ds);

    const result = await svc.getKlines(tsCode, 300, 'qfq', undefined);
    expect(result.bars).toEqual([]);
    expect(result.suspend).toEqual({
      status: 'suspended',
      sinceDate: '20260707',
      timing: null,
      lastQuoteTradeDate: '20260706',
      asOfTradeDate: '20260710',
    });
  });

  it('suspend SQL 锚定 raw.suspend_d 与全局 MAX(trade_date)', async () => {
    const ds = makeKlinesDataSourceMock();
    const svc = makeService(ds);
    const { suspendSql } = await callGetKlines(svc, ds, [tsCode, 300, 'qfq', undefined]);
    expect(squash(suspendSql)).toContain('raw.suspend_d');
    expect(squash(suspendSql)).toContain('MAX(trade_date) AS trade_date FROM raw.daily_quote');
  });
});

// ── 工具：构造模拟 DB 行 ──────────────────────────────────────────────────────

interface MockDbRow {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pctChg: number;
  vol: number;
  amount: number;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdjK: number;
  kdjD: number;
  kdjJ: number;
  bbi: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  quoteVolume10: number | null;
  atr14: number | null;
  lossAtr14: number | null;
  low9: number | null;
  high9: number | null;
  stopLossPct: number | null;
  riskRewardRatio: number | null;
  brick: number | null;
  brickDelta: number | null;
  brickXg: boolean | null;
  turnoverRate: number | null;
  volumeRatio: number | null;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMv: number | null;
  circMv: number | null;
}

function makeMockRows(count = 12): MockDbRow[] {
  const rows: MockDbRow[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 2;
    rows.push({
      tradeDate: `202401${String(i + 1).padStart(2, '0')}`,
      open: base,
      high: base + 3,
      low: base - 1,
      close: base + (i % 3) - 1,
      pctChg: (i % 5) - 2,
      vol: 10000 + i * 100,
      amount: 2000000 + i * 10000,
      dif: 0.5 + i * 0.1,
      dea: 0.3 + i * 0.05,
      macd: 0.2 + i * 0.05,
      kdjK: 50 + i,
      kdjD: 45 + i,
      kdjJ: 60 + i,
      bbi: base + 1,
      ma5: base + 0.5,
      ma30: base - 0.5,
      ma60: base - 1.5,
      ma120: base - 3,
      ma240: base - 5,
      quoteVolume10: 15000 + i * 50,
      atr14: 2 + i * 0.1,
      lossAtr14: 1.5 + i * 0.1,
      low9: base - 2,
      high9: base + 4,
      stopLossPct: 0.05,
      riskRewardRatio: 2,
      brick: i > 2 ? base : null,
      brickDelta: i > 2 ? 1 : null,
      brickXg: i === 5,
      turnoverRate: 1.5 + i * 0.1,
      volumeRatio: 1.2 + i * 0.05,
      pe: 15 + i,
      peTtm: 14 + i,
      pb: 2 + i * 0.1,
      totalMv: 1000000 + i * 10000,
      circMv: 800000 + i * 8000,
    });
  }
  return rows;
}

const DEFAULT_SUSPEND_ROW = {
  status: 'none',
  sinceDate: null,
  timing: null,
  lastQuoteTradeDate: '20240112',
  asOfTradeDate: '20240112',
};

function setupKlinesAndSuspendMock(
  ds: ReturnType<typeof makeKlinesDataSourceMock>,
  bars: MockDbRow[] | [] = [],
) {
  ds.query.mockReset();
  ds.query
    .mockResolvedValueOnce(bars)
    .mockResolvedValueOnce([DEFAULT_SUSPEND_ROW]);
}

// ── 测试套件：recalcKlines ────────────────────────────────────────────────────

describe('ASharesService.recalcKlines', () => {
  const tsCode = '000001.SZ';

  it('不传 kdjParams 时返回与 getKlines 完全相同的数据', async () => {
    const ds = makeKlinesDataSourceMock();
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const svc = makeService(ds);

    const fromGet = await svc.getKlines(tsCode, 300, 'qfq', undefined);
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const fromRecalc = await svc.recalcKlines(tsCode, { priceMode: 'qfq' }, undefined);

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 参数会改变 KDJ 三列，其余列保持不变', async () => {
    const ds = makeKlinesDataSourceMock();
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const svc = makeService(ds);

    const defaultResult = await svc.recalcKlines(tsCode, { priceMode: 'qfq' }, undefined);
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const customResult = await svc.recalcKlines(
      tsCode,
      { priceMode: 'qfq' },
      { n: 6, m1: 2, m2: 2 },
    );

    const defaultRows = defaultResult.bars;
    const customRows = customResult.bars;
    expect(customResult.suspend).toEqual(defaultResult.suspend);

    expect(customRows).toHaveLength(defaultRows.length);

    for (let i = 0; i < customRows.length; i++) {
      const custom = customRows[i];
      const baseline = defaultRows[i];

      // KDJ 三列必须不同
      expect(custom['KDJ.K']).not.toEqual(baseline['KDJ.K']);
      expect(custom['KDJ.D']).not.toEqual(baseline['KDJ.D']);
      expect(custom['KDJ.J']).not.toEqual(baseline['KDJ.J']);

      // 其余列保持不变
      expect(custom.open_time).toEqual(baseline.open_time);
      expect(custom.open).toEqual(baseline.open);
      expect(custom.high).toEqual(baseline.high);
      expect(custom.low).toEqual(baseline.low);
      expect(custom.close).toEqual(baseline.close);
      expect(custom.pctChg).toEqual(baseline.pctChg);
      expect(custom.volume).toEqual(baseline.volume);
      expect(custom.quote_volume).toEqual(baseline.quote_volume);
      expect(custom.DIF).toEqual(baseline.DIF);
      expect(custom.DEA).toEqual(baseline.DEA);
      expect(custom.MACD).toEqual(baseline.MACD);
      expect(custom.BBI).toEqual(baseline.BBI);
      expect(custom.MA5).toEqual(baseline.MA5);
      expect(custom.MA30).toEqual(baseline.MA30);
      expect(custom.MA60).toEqual(baseline.MA60);
      expect(custom.MA120).toEqual(baseline.MA120);
      expect(custom.MA240).toEqual(baseline.MA240);
      expect(custom['10_quote_volume']).toEqual(baseline['10_quote_volume']);
      expect(custom.atr_14).toEqual(baseline.atr_14);
      expect(custom.loss_atr_14).toEqual(baseline.loss_atr_14);
      expect(custom.low_9).toEqual(baseline.low_9);
      expect(custom.high_9).toEqual(baseline.high_9);
      expect(custom.stop_loss_pct).toEqual(baseline.stop_loss_pct);
      expect(custom.risk_reward_ratio).toEqual(baseline.risk_reward_ratio);
      expect(custom.turnoverRate).toEqual(baseline.turnoverRate);
      expect(custom.volumeRatio).toEqual(baseline.volumeRatio);
      expect(custom.pe).toEqual(baseline.pe);
      expect(custom.peTtm).toEqual(baseline.peTtm);
      expect(custom.pb).toEqual(baseline.pb);
      expect(custom.totalMv).toEqual(baseline.totalMv);
      expect(custom.circMv).toEqual(baseline.circMv);
      expect(custom.brickChart).toEqual(baseline.brickChart);
    }
  });

  it('显式传入默认参数 9/3/3 时不触发重算，结果与 getKlines 一致', async () => {
    const ds = makeKlinesDataSourceMock();
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const svc = makeService(ds);

    const fromGet = await svc.getKlines(tsCode, 300, 'qfq', undefined);
    setupKlinesAndSuspendMock(ds, makeMockRows());
    const fromRecalc = await svc.recalcKlines(
      tsCode,
      { priceMode: 'qfq' },
      { n: 9, m1: 3, m2: 3 },
    );

    expect(fromRecalc).toEqual(fromGet);
  });

  it('startDate/endDate 会透传给 getKlines 并出现在 SQL 中', async () => {
    const ds = makeKlinesDataSourceMock();
    setupKlinesAndSuspendMock(ds, []);
    const svc = makeService(ds);

    await svc.recalcKlines(
      tsCode,
      { priceMode: 'qfq', startDate: '20240101', endDate: '20240131' },
      { n: 6, m1: 2, m2: 2 },
    );

    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    const flat = squash(sql);
    expect(flat).toContain('q.trade_date >= $2');
    expect(flat).toContain('q.trade_date <= $3');
    expect(params).toEqual([tsCode, '20240101', '20240131', 300]);
  });

  it('priceMode=raw 时 SQL 选择 q.high/q.low/q.close，且自定义 KDJ 按 4 位小数取整', async () => {
    const ds = makeKlinesDataSourceMock();
    const mockRows = makeMockRows();
    setupKlinesAndSuspendMock(ds, mockRows);
    const svc = makeService(ds);

    const kdjParams = { n: 6, m1: 2, m2: 2 };
    const out = await svc.recalcKlines(tsCode, { priceMode: 'raw' }, kdjParams);

    const [sql] = ds.query.mock.calls[0] as [string, unknown[]];
    const flat = squash(sql);
    expect(flat).toContain('q.high');
    expect(flat).toContain('q.low');
    expect(flat).toContain('q.close');
    expect(flat).not.toContain('qfq_high');
    expect(flat).not.toContain('qfq_low');
    expect(flat).not.toContain('qfq_close');

    const expected = calcKdjSeries(
      mockRows.map((r) => ({ high: r.high, low: r.low, close: r.close })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    ).map(roundKdjPoint);

    expect(out.bars).toHaveLength(expected.length);
    for (let i = 0; i < out.bars.length; i++) {
      const bar = out.bars[i] as { 'KDJ.K': number; 'KDJ.D': number; 'KDJ.J': number };
      expect(bar['KDJ.K']).toBeCloseTo(expected[i].k, 4);
      expect(bar['KDJ.D']).toBeCloseTo(expected[i].d, 4);
      expect(bar['KDJ.J']).toBeCloseTo(expected[i].j, 4);

      expect(bar['KDJ.K']).toEqual(parseFloat(bar['KDJ.K'].toFixed(4)));
      expect(bar['KDJ.D']).toEqual(parseFloat(bar['KDJ.D'].toFixed(4)));
      expect(bar['KDJ.J']).toEqual(parseFloat(bar['KDJ.J'].toFixed(4)));
    }
  });
});

describe('ASharesService.query - indexTsCode 校验', () => {
  it('非法后缀 .XX 时抛 BadRequestException', async () => {
    const ds = makeQueryDataSourceMock();
    const svc = makeService(ds);

    await expect(svc.query({ indexTsCode: 'foo.XX' })).rejects.toThrow(BadRequestException);
    await expect(svc.query({ indexTsCode: 'foo.XX' })).rejects.toThrow('不支持的指数类型');
  });

  it('无后缀时抛 BadRequestException', async () => {
    const ds = makeQueryDataSourceMock();
    const svc = makeService(ds);

    await expect(svc.query({ indexTsCode: 'foo' })).rejects.toThrow(BadRequestException);
  });

  it('.TI 后缀不抛异常', async () => {
    const ds = makeQueryDataSourceMock();
    ds.query
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const svc = makeService(ds);

    await expect(svc.query({ indexTsCode: '885001.TI' })).resolves.toBeDefined();
  });

  it('.SI 后缀不抛异常', async () => {
    const ds = makeQueryDataSourceMock();
    ds.query
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const svc = makeService(ds);

    await expect(svc.query({ indexTsCode: '801010.SI' })).resolves.toBeDefined();
  });
});

describe('ASharesService.query - 两阶段 + skipCount', () => {
  it('skipCount=true 时不发起 COUNT 查询', async () => {
    const ds = makeQueryDataSourceMock();
    ds.query
      .mockResolvedValueOnce([{ tsCode: '600519.SH' }, { tsCode: '000858.SZ' }])
      .mockResolvedValueOnce([{ tsCode: '600519.SH' }, { tsCode: '000858.SZ' }]);
    const svc = makeService(ds);

    const res = await svc.query({
      page: 1,
      pageSize: 10,
      sort: { field: 'pctChg', order: 'descend' },
      skipCount: true,
    });

    expect(res.total).toBe(-1);
    expect(ds.query).toHaveBeenCalledTimes(2);
    const [firstSql] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(squash(firstSql)).not.toContain('SELECT COUNT(*)');
  });

  it('skipCount=false 时先 COUNT 再 id-sort 再 hydrate', async () => {
    const ds = makeQueryDataSourceMock();
    ds.query
      .mockResolvedValueOnce([{ count: '100' }])
      .mockResolvedValueOnce([{ tsCode: '600519.SH' }])
      .mockResolvedValueOnce([{ tsCode: '600519.SH', name: '茅台' }]);
    const svc = makeService(ds);

    const res = await svc.query({
      page: 1,
      pageSize: 10,
      sort: { field: 'pctChg', order: 'descend' },
    });

    expect(res.total).toBe(100);
    expect(ds.query).toHaveBeenCalledTimes(3);
    const [countSql] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(squash(countSql)).toContain('SELECT COUNT(*)');
    const [idSql] = ds.query.mock.calls[1] as [string, unknown[]];
    expect(squash(idSql)).toContain('SELECT s.ts_code');
    const [hydrateSql] = ds.query.mock.calls[2] as [string, unknown[]];
    expect(squash(hydrateSql)).toContain('tags');
  });
});
