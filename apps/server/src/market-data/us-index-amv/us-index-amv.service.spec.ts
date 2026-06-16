import { BadRequestException } from '@nestjs/common';
import { UsIndexAmvService } from './us-index-amv.service';
import { UsIndexAmvController } from './us-index-amv.controller';

/**
 * 单测 UsIndexAmvService / UsIndexAmvController（不连真 DB，mock dataSource.query / quantJobs.create）：
 *   - getSeries：SELECT 别名水合全字段（tradeDate 保 YYYYMMDD 不转横线、数值经 asNullableNumber、null 透传、升序）
 *   - getDateRange：空表 → {start:null,end:null}；有值 → min/max
 *   - sync：派 ml.jobs run_type='us_index_amv_sync'，date_range 存冒号串（非数组），priority/maxAttempts，非法入参 400
 *   - controller：getSeries 缺 index_code / 非 YYYYMMDD start/end → BadRequestException
 */

function makeQuantJobsMock(jobId = 'job-uuid-1') {
  return { create: jest.fn().mockResolvedValue({ id: jobId }) };
}

function makeDataSourceMock(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue(rows) };
}

describe('UsIndexAmvService.getSeries — SELECT 别名水合 AmvSeriesRow', () => {
  it('全字段水合 / tradeDate 保 YYYYMMDD / 数值转 number / null 透传 / 升序', async () => {
    // 两行已按 trade_date 升序（SQL ORDER BY ASC 保证），第二行可空列全 null 验透传
    const rawRows = [
      {
        tradeDate: '20240102',
        amvOpen: '12.5',
        amvHigh: '13.2',
        amvLow: '11.8',
        amvClose: '12.9',
        amvDif: '0.42',
        amvDea: '0.31',
        amvMacd: '0.22',
        amvZdf: '1.55',
        signal: '1',
        memberCount: '101',
      },
      {
        tradeDate: '20240103',
        amvOpen: '13.0',
        amvHigh: '13.5',
        amvLow: '12.7',
        amvClose: '13.1',
        amvDif: null,
        amvDea: null,
        amvMacd: null,
        amvZdf: null,
        signal: '0',
        memberCount: null,
      },
    ];
    const ds = makeDataSourceMock(rawRows);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    const out = await svc.getSeries('.NDX', '20240101', '20240131');

    expect(out).toHaveLength(2);

    // tradeDate 不转横线（保 YYYYMMDD），升序保持
    expect(out[0].tradeDate).toBe('20240102');
    expect(out[1].tradeDate).toBe('20240103');
    expect(out.map((r) => r.tradeDate)).toEqual(['20240102', '20240103']);

    // 全数值字段水合为 number
    expect(out[0].amvOpen).toBe(12.5);
    expect(out[0].amvHigh).toBe(13.2);
    expect(out[0].amvLow).toBe(11.8);
    expect(out[0].amvClose).toBe(12.9);
    expect(out[0].amvDif).toBe(0.42);
    expect(out[0].amvDea).toBe(0.31);
    expect(out[0].amvMacd).toBe(0.22);
    expect(out[0].amvZdf).toBe(1.55);
    expect(out[0].signal).toBe(1);
    expect(out[0].memberCount).toBe(101);

    // 第二行可空列 null 透传
    expect(out[1].amvDif).toBeNull();
    expect(out[1].amvDea).toBeNull();
    expect(out[1].amvMacd).toBeNull();
    expect(out[1].amvZdf).toBeNull();
    expect(out[1].memberCount).toBeNull();
    // 非空列仍水合
    expect(out[1].amvClose).toBe(13.1);
    expect(out[1].signal).toBe(0);
  });

  it('参数化 index_code/start/end 传入 query', async () => {
    const ds = makeDataSourceMock([]);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    await svc.getSeries('.NDX', '20240101', '20240131');

    const [, params] = ds.query.mock.calls[0];
    expect(params).toEqual(['.NDX', '20240101', '20240131']);
  });

  it('空区间 → []', async () => {
    const ds = makeDataSourceMock([]);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    const out = await svc.getSeries('.NDX', '20240101', '20240131');
    expect(out).toEqual([]);
  });
});

describe('UsIndexAmvService.getDateRange', () => {
  it('空表 → {start:null,end:null}', async () => {
    // PG MIN/MAX 空集仍返回一行 {start:null,end:null}
    const ds = makeDataSourceMock([{ start: null, end: null }]);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: null, end: null });
  });

  it('rows 为空数组也兜底 {start:null,end:null}', async () => {
    const ds = makeDataSourceMock([]);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: null, end: null });
  });

  it('有值 → 取 min/max（键名 start/end）', async () => {
    const ds = makeDataSourceMock([{ start: '20210901', end: '20260612' }]);
    const svc = new UsIndexAmvService(ds as never, makeQuantJobsMock() as never);

    const res = await svc.getDateRange('.NDX');
    expect(res).toEqual({ start: '20210901', end: '20260612' });
  });
});

describe('UsIndexAmvService.sync — 派 ml.jobs(us_index_amv_sync)', () => {
  it('无参数 → run_type=us_index_amv_sync，params 无 date_range 键，透传 createdBy，priority/maxAttempts', async () => {
    const quant = makeQuantJobsMock('job-xyz');
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, quant as never);

    const res = await svc.sync({}, 'user-1');

    expect(res).toEqual({ jobId: 'job-xyz' });
    expect(quant.create).toHaveBeenCalledTimes(1);
    const [dto, createdBy] = quant.create.mock.calls[0];
    expect(dto.runType).toBe('us_index_amv_sync');
    expect(dto.params).toEqual({});
    expect('date_range' in dto.params).toBe(false);
    expect(dto.priority).toBe(100);
    expect(dto.maxAttempts).toBe(1);
    expect(createdBy).toBe('user-1');
  });

  it('dateRange → params.date_range 是冒号串（非数组）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, quant as never);

    await svc.sync({ dateRange: ['20240101', '20240131'] }, 'admin');

    const [dto] = quant.create.mock.calls[0];
    expect(dto.params.date_range).toBe('20240101:20240131');
    expect(Array.isArray(dto.params.date_range)).toBe(false);
  });

  it('dateRange + symbols → date_range 冒号串 + symbols 数组', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, quant as never);

    await svc.sync({ dateRange: ['20240101', '20240131'], symbols: ['AAPL', 'MSFT'] }, 'admin');

    const [dto] = quant.create.mock.calls[0];
    expect(dto.params).toEqual({
      date_range: '20240101:20240131',
      symbols: ['AAPL', 'MSFT'],
    });
  });

  it('createdBy 可为 null（内部调用）', async () => {
    const quant = makeQuantJobsMock();
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, quant as never);
    await svc.sync({}, null);
    expect(quant.create.mock.calls[0][1]).toBeNull();
  });

  it.each([
    ['非二元组', { dateRange: ['20240101'] as never }],
    ['非 YYYYMMDD', { dateRange: ['2024-01-01', '20240131'] as never }],
    ['start > end', { dateRange: ['20240201', '20240131'] as never }],
  ])('非法 dateRange（%s）→ 400', async (_label, body) => {
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, makeQuantJobsMock() as never);
    await expect(svc.sync(body, 'u')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('symbols 含空串 → 400', async () => {
    const svc = new UsIndexAmvService(makeDataSourceMock() as never, makeQuantJobsMock() as never);
    await expect(svc.sync({ symbols: ['AAPL', ''] }, 'u')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('UsIndexAmvController — 入参校验', () => {
  function makeServiceMock() {
    return {
      getSeries: jest.fn().mockResolvedValue([]),
      getDateRange: jest.fn().mockResolvedValue({ start: null, end: null }),
      sync: jest.fn().mockResolvedValue({ jobId: 'j1' }),
    };
  }

  it('getSeries 缺 index_code → 400', () => {
    const ctrl = new UsIndexAmvController(makeServiceMock() as never);
    expect(() =>
      ctrl.getSeries({ start_date: '20240101', end_date: '20240131' }),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['start_date 非 YYYYMMDD', { index_code: '.NDX', start_date: '2024-01-01', end_date: '20240131' }],
    ['end_date 非 YYYYMMDD', { index_code: '.NDX', start_date: '20240101', end_date: '2024-1-31' }],
    ['start_date 缺失', { index_code: '.NDX', end_date: '20240131' }],
    ['end_date 缺失', { index_code: '.NDX', start_date: '20240101' }],
  ])('getSeries %s → 400', (_label, params) => {
    const ctrl = new UsIndexAmvController(makeServiceMock() as never);
    expect(() => ctrl.getSeries(params)).toThrow(BadRequestException);
  });

  it('getSeries 三参合法 → 委托 service.getSeries（参数透传）', () => {
    const svc = makeServiceMock();
    const ctrl = new UsIndexAmvController(svc as never);
    ctrl.getSeries({ index_code: '.NDX', start_date: '20240101', end_date: '20240131' });
    expect(svc.getSeries).toHaveBeenCalledWith('.NDX', '20240101', '20240131');
  });

  it('getDateRange 缺 index_code → 400', () => {
    const ctrl = new UsIndexAmvController(makeServiceMock() as never);
    expect(() => ctrl.getDateRange(undefined)).toThrow(BadRequestException);
  });

  it('sync 委托 service.sync（body + user.id）', () => {
    const svc = makeServiceMock();
    const ctrl = new UsIndexAmvController(svc as never);
    ctrl.sync({ dateRange: ['20240101', '20240131'] }, { id: 'admin-1' });
    expect(svc.sync).toHaveBeenCalledWith({ dateRange: ['20240101', '20240131'] }, 'admin-1');
  });

  it('sync body 为 undefined → 兜底 {} + user.id', () => {
    const svc = makeServiceMock();
    const ctrl = new UsIndexAmvController(svc as never);
    ctrl.sync(undefined as never, { id: 'admin-1' });
    expect(svc.sync).toHaveBeenCalledWith({}, 'admin-1');
  });
});
