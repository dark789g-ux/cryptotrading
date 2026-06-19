import { BadRequestException } from '@nestjs/common';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
import { UsIndexDailyService } from './us-index-daily.service';

/**
 * 单测 UsIndexDailyService（不连真 DB，mock dataSource.query / quantJobs.create）：
 *   - getKlines：映射成 KlineChartBar 子集（open_time 'YYYY-MM-DD'、KDJ 平铺点键、BBI、null 透传、升序）
 *   - getDateRange：空 → {start:null,end:null}；有值 → min/max
 *   - sync：写 ml.jobs run_type='us_index_sync'，date_range 存冒号串（非数组），非法入参 400
 */

function makeQuantJobsMock(jobId = 'job-uuid-1') {
  return { create: jest.fn().mockResolvedValue({ id: jobId }) };
}

function makeDataSourceMock(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue(rows) };
}

describe('UsIndexDailyService.getKlines — 映射 KlineChartBar 子集', () => {
  it('映射 open_time/KDJ 平铺键/BBI/null 透传/升序', async () => {
    // 两行已按 trade_date 升序（SQL ORDER BY ASC 保证），第二行指标全 null 验透传
    const rawRows = [
      {
        tradeDate: '20240102',
        open: '100.5',
        high: '101.2',
        low: '99.8',
        close: '100.9',
        volume: '1234567',
        ma5: '100.1',
        ma30: '99.5',
        ma60: '98.7',
        ma120: '97.3',
        ma240: '96.1',
        bbi: '99.9',
        kdjK: '55.5',
        kdjD: '50.1',
        kdjJ: '66.3',
        dif: '0.42',
        dea: '0.31',
        macd: '0.22',
      },
      {
        tradeDate: '20240103',
        open: '101.0',
        high: '102.0',
        low: '100.5',
        close: '101.5',
        volume: '7654321',
        ma5: null,
        ma30: null,
        ma60: null,
        ma120: null,
        ma240: null,
        bbi: null,
        kdjK: null,
        kdjD: null,
        kdjJ: null,
        dif: null,
        dea: null,
        macd: null,
      },
    ];
    const ds = makeDataSourceMock(rawRows);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const out = await svc.getKlines('.NDX', '20240101', '20240131');

    expect(out).toHaveLength(2);

    // open_time 转 YYYY-MM-DD
    expect(out[0].open_time).toBe('2024-01-02');
    expect(out[1].open_time).toBe('2024-01-03');

    // 升序保持
    expect(out.map((r) => r.open_time)).toEqual(['2024-01-02', '2024-01-03']);

    // OHLCV 转 number
    expect(out[0].open).toBe(100.5);
    expect(out[0].close).toBe(100.9);
    expect(out[0].volume).toBe(1234567);

    // KDJ 是平铺字符串点键，不是嵌套对象
    expect(out[0]['KDJ.K']).toBe(55.5);
    expect(out[0]['KDJ.D']).toBe(50.1);
    expect(out[0]['KDJ.J']).toBe(66.3);
    expect((out[0] as unknown as Record<string, unknown>).KDJ).toBeUndefined();

    // BBI 映射
    expect(out[0].BBI).toBe(99.9);

    // MA / MACD 映射
    expect(out[0].MA5).toBe(100.1);
    expect(out[0].MA240).toBe(96.1);
    expect(out[0].DIF).toBe(0.42);
    expect(out[0].MACD).toBe(0.22);

    // 第二行指标全 null 透传
    expect(out[1].MA5).toBeNull();
    expect(out[1]['KDJ.K']).toBeNull();
    expect(out[1].BBI).toBeNull();
    expect(out[1].DIF).toBeNull();
  });

  it('参数化 index_code/start/end 传入 query', async () => {
    const ds = makeDataSourceMock([]);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    await svc.getKlines('.NDX', '20240101', '20240131');

    const [, params] = ds.query.mock.calls[0];
    expect(params).toEqual(['.NDX', '20240101', '20240131']);
  });
});

describe('UsIndexDailyService.getDateRange', () => {
  it('空表 → {start:null,end:null}', async () => {
    // PG MIN/MAX 空集仍返回一行 {start:null,end:null}
    const ds = makeDataSourceMock([{ start: null, end: null }]);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: null, end: null });
  });

  it('rows 为空数组也兜底 {start:null,end:null}', async () => {
    const ds = makeDataSourceMock([]);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: null, end: null });
  });

  it('有值 → 取 min/max（键名 start/end）', async () => {
    const ds = makeDataSourceMock([{ start: '20210901', end: '20260612' }]);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: '20210901', end: '20260612' });
  });
});

describe('UsIndexDailyService.sync — 派 ml.jobs(us_index_sync)', () => {
  it('无参数 → run_type=us_index_sync，params 无 date_range 键，透传 createdBy，返回 jobId', async () => {
    const quant = makeQuantJobsMock('job-xyz');
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, quant as never);

    const res = await svc.sync({}, 'user-1');

    expect(res).toEqual({ jobId: 'job-xyz' });
    expect(quant.create).toHaveBeenCalledTimes(1);
    const [dto, createdBy] = quant.create.mock.calls[0];
    expect(dto.runType).toBe('us_index_sync');
    expect(dto.params).toEqual({});
    expect('date_range' in dto.params).toBe(false);
    expect(dto.priority).toBe(100);
    expect(dto.maxAttempts).toBe(1);
    expect(createdBy).toBe('user-1');
  });

  it('dateRange → params.date_range 是冒号串（非数组）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, quant as never);

    await svc.sync({ dateRange: ['20240101', '20240131'] }, 'admin');

    const [dto] = quant.create.mock.calls[0];
    expect(dto.params.date_range).toBe('20240101:20240131');
    expect(Array.isArray(dto.params.date_range)).toBe(false);
  });

  it('dateRange + symbols → date_range 冒号串 + symbols 数组', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, quant as never);

    await svc.sync({ dateRange: ['20240101', '20240131'], symbols: ['.NDX', '.SPX'] }, 'admin');

    const [dto] = quant.create.mock.calls[0];
    expect(dto.params).toEqual({
      date_range: '20240101:20240131',
      symbols: ['.NDX', '.SPX'],
    });
  });

  it('createdBy 可为 null（内部调用）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, quant as never);
    await svc.sync({}, null);
    expect(quant.create.mock.calls[0][1]).toBeNull();
  });

  it.each([
    ['非二元组', { dateRange: ['20240101'] as never }],
    ['非 YYYYMMDD', { dateRange: ['2024-01-01', '20240131'] as never }],
    ['start > end', { dateRange: ['20240201', '20240131'] as never }],
  ])('非法 dateRange（%s）→ 400', async (_label, body) => {
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, makeQuantJobsMock() as never);
    await expect(svc.sync(body, 'u')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('symbols 含空串 → 400', async () => {
    const svc = new UsIndexDailyService(makeDataSourceMock() as never, makeQuantJobsMock() as never);
    await expect(svc.sync({ symbols: ['.NDX', ''] }, 'u')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});


// ── 工具：构造模拟 DB 行 ──────────────────────────────────────────────────────

interface MockUsIndexRow {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  bbi: number | null;
  kdjK: number;
  kdjD: number;
  kdjJ: number;
  dif: number | null;
  dea: number | null;
  macd: number | null;
}

function makeMockRows(count = 12): MockUsIndexRow[] {
  const rows: MockUsIndexRow[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 2;
    rows.push({
      tradeDate: `202401${String(i + 1).padStart(2, '0')}`,
      open: base,
      high: base + 3,
      low: base - 1,
      close: base + (i % 3) - 1,
      volume: 1000000 + i * 10000,
      ma5: base + 0.5,
      ma30: base - 0.5,
      ma60: base - 1.5,
      ma120: base - 3,
      ma240: base - 5,
      bbi: base + 1,
      kdjK: 50 + i,
      kdjD: 45 + i,
      kdjJ: 60 + i,
      dif: 0.5 + i * 0.1,
      dea: 0.3 + i * 0.05,
      macd: 0.2 + i * 0.05,
    });
  }
  return rows;
}

// ── 测试套件：recalcKlines ────────────────────────────────────────────────────

describe('UsIndexDailyService.recalcKlines', () => {
  const indexCode = '.NDX';
  const startDate = '20240101';
  const endDate = '20240131';

  it('不传 kdjParams 时返回与 getKlines 完全相同的数据', async () => {
    const ds = makeDataSourceMock(makeMockRows());
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const fromGet = await svc.getKlines(indexCode, startDate, endDate);
    const fromRecalc = await svc.recalcKlines(indexCode, { startDate, endDate });

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 参数会改变 KDJ 三列，其余列保持不变', async () => {
    const ds = makeDataSourceMock(makeMockRows());
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const defaultRows = await svc.recalcKlines(indexCode, { startDate, endDate });
    const customRows = await svc.recalcKlines(
      indexCode,
      { startDate, endDate },
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
      expect(custom.volume).toEqual(baseline.volume);
      expect(custom.MA5).toEqual(baseline.MA5);
      expect(custom.MA30).toEqual(baseline.MA30);
      expect(custom.MA60).toEqual(baseline.MA60);
      expect(custom.MA120).toEqual(baseline.MA120);
      expect(custom.MA240).toEqual(baseline.MA240);
      expect(custom.BBI).toEqual(baseline.BBI);
      expect(custom.DIF).toEqual(baseline.DIF);
      expect(custom.DEA).toEqual(baseline.DEA);
      expect(custom.MACD).toEqual(baseline.MACD);
    }
  });

  it('显式传入默认参数 9/3/3 时不触发重算，结果与 getKlines 一致', async () => {
    const ds = makeDataSourceMock(makeMockRows());
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const fromGet = await svc.getKlines(indexCode, startDate, endDate);
    const fromRecalc = await svc.recalcKlines(
      indexCode,
      { startDate, endDate },
      { n: 9, m1: 3, m2: 3 },
    );

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 结果按 4 位小数取整，并与 calcKdjSeries 取整后一致', async () => {
    const mockRows = makeMockRows();
    const ds = makeDataSourceMock(mockRows);
    const svc = new UsIndexDailyService(ds as never, makeQuantJobsMock() as never);

    const kdjParams = { n: 6, m1: 2, m2: 2 };
    const out = await svc.recalcKlines(indexCode, { startDate, endDate }, kdjParams);

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
