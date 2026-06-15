import { BadRequestException } from '@nestjs/common';
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
      date_range: ['20250101', '20260612'],
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
