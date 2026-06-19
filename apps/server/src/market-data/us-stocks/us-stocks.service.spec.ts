import { BadRequestException } from '@nestjs/common';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
import { UsStocksService } from './us-stocks.service';

/**
 * 单测 UsStocksService：
 *   - sync：写 ml.jobs run_type='us_sync'，params 用 snake_case date_range/tickers，透传 createdBy；非法入参 400
 *   - getKlines：日期区间参数化与 LIMIT 占位
 * 不连真 DB，mock dataSource.query / quantJobs.create。
 */

function makeQuantJobsMock(jobId = 'job-uuid-1') {
  return { create: jest.fn().mockResolvedValue({ id: jobId }) };
}

function makeDataSourceMock() {
  return { query: jest.fn().mockResolvedValue([]) };
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

describe('UsStocksService.sync — 派 ml.jobs(us_sync)', () => {
  it('无参数 → run_type=us_sync，params={}，透传 createdBy，返回 jobId', async () => {
    const quant = makeQuantJobsMock('job-xyz');
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);

    const res = await svc.sync({}, 'user-1');

    expect(res).toEqual({ jobId: 'job-xyz' });
    expect(quant.create).toHaveBeenCalledTimes(1);
    const [dto, createdBy] = quant.create.mock.calls[0];
    expect(dto.runType).toBe('us_sync');
    expect(dto.params).toEqual({});
    expect(dto.priority).toBe(100);
    expect(dto.maxAttempts).toBe(1);
    expect(createdBy).toBe('user-1');
  });

  it('dateRange + tickers → params 用 snake_case date_range / tickers', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);

    await svc.sync({ dateRange: ['20250101', '20260612'], tickers: ['NVDA', 'MSFT'] }, 'admin');

    const [dto] = quant.create.mock.calls[0];
    expect(dto.params).toEqual({
      date_range: '20250101:20260612',
      tickers: ['NVDA', 'MSFT'],
    });
  });

  it('createdBy 可为 null（内部调用）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await svc.sync({}, null);
    expect(quant.create.mock.calls[0][1]).toBeNull();
  });

  it.each([
    [{ dateRange: ['2025-01-01', '20260612'] }, 'dateRange 非 YYYYMMDD'],
    [{ dateRange: ['20250101'] }, 'dateRange 非二元组'],
    [{ dateRange: ['20260612', '20250101'] }, 'dateRange start>end'],
  ])('非法 dateRange (%s) → 400 且不派 job', async (body) => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await expect(svc.sync(body as never, 'u')).rejects.toBeInstanceOf(BadRequestException);
    expect(quant.create).not.toHaveBeenCalled();
  });

  it('非法 tickers（含非字符串）→ 400 且不派 job', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await expect(
      svc.sync({ tickers: ['NVDA', 123] } as never, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(quant.create).not.toHaveBeenCalled();
  });
});

describe('UsStocksService.oneClickSync — 派 ml.jobs(us_one_click_sync)', () => {
  it('合法 dateRange → run_type=us_one_click_sync，params.date_range 冒号串，priority/maxAttempts，透传 createdBy，返回 jobId', async () => {
    const quant = makeQuantJobsMock('job-ocs');
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);

    const res = await svc.oneClickSync({ dateRange: ['20250101', '20260612'] }, 'user-1');

    expect(res).toEqual({ jobId: 'job-ocs' });
    expect(quant.create).toHaveBeenCalledTimes(1);
    const [dto, createdBy] = quant.create.mock.calls[0];
    expect(dto.runType).toBe('us_one_click_sync');
    expect(dto.params).toEqual({ date_range: '20250101:20260612' });
    expect(dto.priority).toBe(100);
    expect(dto.maxAttempts).toBe(1);
    expect(createdBy).toBe('user-1');
  });

  it('不传 tickers/symbols（params 仅含 date_range）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await svc.oneClickSync({ dateRange: ['20250101', '20260612'] }, 'admin');
    const [dto] = quant.create.mock.calls[0];
    expect(Object.keys(dto.params)).toEqual(['date_range']);
  });

  it('createdBy 可为 null（内部调用）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await svc.oneClickSync({ dateRange: ['20250101', '20260612'] }, null);
    expect(quant.create.mock.calls[0][1]).toBeNull();
  });

  it.each([
    [undefined],
    [{}],
    [{ dateRange: ['2025-01-01', '20260612'] }],
    [{ dateRange: ['20250101'] }],
    [{ dateRange: ['20250101', '20250102', '20250103'] }],
    [{ dateRange: '20250101:20260612' }],
    [{ dateRange: ['20260612', '20250101'] }],
  ])('非法/缺失 dateRange (%s) → 400 且不派 job', async (body) => {
    const quant = makeQuantJobsMock();
    const svc = new UsStocksService(null as never, makeDataSourceMock() as never, quant as never);
    await expect(svc.oneClickSync(body as never, 'u')).rejects.toBeInstanceOf(BadRequestException);
    expect(quant.create).not.toHaveBeenCalled();
  });
});

describe('UsStocksService.getKlines — 日期区间参数化', () => {
  const ticker = 'NVDA';

  async function callKlines(
    args: Parameters<UsStocksService['getKlines']>,
  ): Promise<{ sql: string; params: unknown[] }> {
    const ds = makeDataSourceMock();
    const svc = new UsStocksService(null as never, ds as never, null as never);
    await svc.getKlines(...args);
    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    return { sql, params };
  }

  it('不传 range → params=[ticker, safeLimit]，SQL 无区间约束', async () => {
    const { sql, params } = await callKlines([ticker, 300, 'qfq', undefined]);
    expect(params).toEqual([ticker, 300]);
    const flat = squash(sql);
    expect(flat).not.toContain('trade_date >=');
    expect(flat).not.toContain('trade_date <=');
  });

  it('传 {startDate,endDate} → params=[ticker, start, end, limit]，含两段约束', async () => {
    const { sql, params } = await callKlines([
      ticker,
      300,
      'qfq',
      { startDate: '20250101', endDate: '20250630' },
    ]);
    expect(params).toEqual([ticker, '20250101', '20250630', 300]);
    const flat = squash(sql);
    expect(flat).toContain('q.trade_date >= $2');
    expect(flat).toContain('q.trade_date <= $3');
    expect(flat).toContain('LIMIT $4');
  });

  it('raw 口径选原始价列', async () => {
    const { sql } = await callKlines([ticker, 300, 'raw', undefined]);
    expect(sql).toContain('q.open AS open');
    expect(sql).not.toContain('q.qfq_open AS open');
  });

  it('qfq 口径选 qfq 价列', async () => {
    const { sql } = await callKlines([ticker, 300, 'qfq', undefined]);
    expect(sql).toContain('q.qfq_open AS open');
  });
});


// ── 工具：构造模拟 DB 行 ──────────────────────────────────────────────────────

interface MockUsStockRow {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pctChg: number;
  volume: number;
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
  atr14: number | null;
  low9: number | null;
  high9: number | null;
  stopLossPct: number | null;
  riskRewardRatio: number | null;
}

function makeMockRows(count = 12): MockUsStockRow[] {
  const rows: MockUsStockRow[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 2;
    rows.push({
      tradeDate: `202401${String(i + 1).padStart(2, '0')}`,
      open: base,
      high: base + 3,
      low: base - 1,
      close: base + (i % 3) - 1,
      pctChg: (i % 5) - 2,
      volume: 1000000 + i * 10000,
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
      atr14: 2 + i * 0.1,
      low9: base - 2,
      high9: base + 4,
      stopLossPct: 0.05,
      riskRewardRatio: 2,
    });
  }
  return rows;
}

// ── 测试套件：recalcKlines ────────────────────────────────────────────────────

describe('UsStocksService.recalcKlines', () => {
  const ticker = 'NVDA';

  it('不传 kdjParams 时返回与 getKlines 完全相同的数据', async () => {
    const ds = makeDataSourceMock();
    ds.query.mockResolvedValue(makeMockRows());
    const svc = new UsStocksService(null as never, ds as never, null as never);

    const fromGet = await svc.getKlines(ticker, 300, 'qfq', undefined);
    const fromRecalc = await svc.recalcKlines(ticker, { priceMode: 'qfq' }, undefined);

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 参数会改变 KDJ 三列，其余列保持不变', async () => {
    const ds = makeDataSourceMock();
    ds.query.mockResolvedValue(makeMockRows());
    const svc = new UsStocksService(null as never, ds as never, null as never);

    const defaultRows = await svc.recalcKlines(ticker, { priceMode: 'qfq' }, undefined);
    const customRows = await svc.recalcKlines(
      ticker,
      { priceMode: 'qfq' },
      { n: 6, m1: 2, m2: 2 },
    );

    expect(customRows).toHaveLength(defaultRows.length);

    for (let i = 0; i < customRows.length; i++) {
      const custom = customRows[i];
      const baseline = defaultRows[i];

      expect(custom['KDJ.K']).not.toEqual(baseline['KDJ.K']);
      expect(custom['KDJ.D']).not.toEqual(baseline['KDJ.D']);
      expect(custom['KDJ.J']).not.toEqual(baseline['KDJ.J']);

      expect(custom.open_time).toEqual(baseline.open_time);
      expect(custom.open).toEqual(baseline.open);
      expect(custom.high).toEqual(baseline.high);
      expect(custom.low).toEqual(baseline.low);
      expect(custom.close).toEqual(baseline.close);
      expect(custom.pctChg).toEqual(baseline.pctChg);
      expect(custom.volume).toEqual(baseline.volume);
      expect(custom.DIF).toEqual(baseline.DIF);
      expect(custom.DEA).toEqual(baseline.DEA);
      expect(custom.MACD).toEqual(baseline.MACD);
      expect(custom.BBI).toEqual(baseline.BBI);
      expect(custom.MA5).toEqual(baseline.MA5);
      expect(custom.MA30).toEqual(baseline.MA30);
      expect(custom.MA60).toEqual(baseline.MA60);
      expect(custom.MA120).toEqual(baseline.MA120);
      expect(custom.MA240).toEqual(baseline.MA240);
      expect(custom.atr_14).toEqual(baseline.atr_14);
      expect(custom.low_9).toEqual(baseline.low_9);
      expect(custom.high_9).toEqual(baseline.high_9);
      expect(custom.stop_loss_pct).toEqual(baseline.stop_loss_pct);
      expect(custom.risk_reward_ratio).toEqual(baseline.risk_reward_ratio);
    }
  });

  it('显式传入默认参数 9/3/3 时不触发重算，结果与 getKlines 一致', async () => {
    const ds = makeDataSourceMock();
    ds.query.mockResolvedValue(makeMockRows());
    const svc = new UsStocksService(null as never, ds as never, null as never);

    const fromGet = await svc.getKlines(ticker, 300, 'qfq', undefined);
    const fromRecalc = await svc.recalcKlines(
      ticker,
      { priceMode: 'qfq' },
      { n: 9, m1: 3, m2: 3 },
    );

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 结果按 4 位小数取整，并与 calcKdjSeries 取整后一致', async () => {
    const ds = makeDataSourceMock();
    const mockRows = makeMockRows();
    ds.query.mockResolvedValue(mockRows);
    const svc = new UsStocksService(null as never, ds as never, null as never);

    const kdjParams = { n: 6, m1: 2, m2: 2 };
    const out = await svc.recalcKlines(ticker, { priceMode: 'qfq' }, kdjParams);

    const expected = calcKdjSeries(
      mockRows.map((r) => ({ high: r.high, low: r.low, close: r.close })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    ).map(roundKdjPoint);

    expect(out).toHaveLength(expected.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]['KDJ.K']).toBeCloseTo(expected[i].k, 4);
      expect(out[i]['KDJ.D']).toBeCloseTo(expected[i].d, 4);
      expect(out[i]['KDJ.J']).toBeCloseTo(expected[i].j, 4);

      expect(out[i]['KDJ.K']).toEqual(parseFloat(out[i]['KDJ.K']!.toFixed(4)));
      expect(out[i]['KDJ.D']).toEqual(parseFloat(out[i]['KDJ.D']!.toFixed(4)));
      expect(out[i]['KDJ.J']).toEqual(parseFloat(out[i]['KDJ.J']!.toFixed(4)));
    }
  });
});
