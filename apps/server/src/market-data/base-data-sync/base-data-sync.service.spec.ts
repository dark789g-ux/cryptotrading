// TODO: 需集成测试验证 API 契约 —— 本文件 mock 了 TushareClientService.query，
// 无法发现 trade_cal / stk_limit / suspend_d 真实接口名、字段名、单位变更。
// 集成测试应覆盖：① 三接口真实响应 fields 顺序 ② trade_cal 真实开市日序列。
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { BaseDataSyncService } from './base-data-sync.service';
import { TradeCalEntity } from '../../entities/raw/trade-cal.entity';
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity';
import { StkLimitEntity } from '../../entities/raw/stk-limit.entity';
import { SuspendEntity } from '../../entities/raw/suspend.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

/** 按 apiName 区分返回值的 mock impl，用于并发场景（调用顺序不确定）。 */
function mockQueryByApiName(responses: Record<string, unknown[]>) {
  return (apiName: string) => {
    const rows = responses[apiName] ?? [];
    return Promise.resolve(rows);
  };
}

interface MockRepo {
  upsert: jest.Mock;
  create: jest.Mock;
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
  query?: jest.Mock;
}

function makeRepo(): MockRepo {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ min: null, max: null }),
  };
  return {
    upsert: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
}

/** 构造带 query 的 repo mock（用于 DailyQuoteEntity 对账查询）。 */
function makeQueryableRepo(): MockRepo & { query: jest.Mock } {
  return { ...makeRepo(), query: jest.fn().mockResolvedValue([]) };
}

async function buildModule(): Promise<{
  service: BaseDataSyncService;
  client: { query: jest.Mock };
  tradeCalRepo: MockRepo;
  stkLimitRepo: MockRepo;
  suspendRepo: MockRepo;
  dailyQuoteRepo: MockRepo & { query: jest.Mock };
}> {
  const client = { query: jest.fn() };
  const tradeCalRepo = makeRepo();
  const stkLimitRepo = makeRepo();
  const suspendRepo = makeRepo();
  const dailyQuoteRepo = makeQueryableRepo();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BaseDataSyncService,
      { provide: getRepositoryToken(TradeCalEntity), useValue: tradeCalRepo },
      { provide: getRepositoryToken(StkLimitEntity), useValue: stkLimitRepo },
      { provide: getRepositoryToken(SuspendEntity), useValue: suspendRepo },
      { provide: getRepositoryToken(DailyQuoteEntity), useValue: dailyQuoteRepo },
      { provide: TushareClientService, useValue: client },
    ],
  }).compile();
  module.useLogger(false);

  return {
    service: module.get(BaseDataSyncService),
    client,
    tradeCalRepo,
    stkLimitRepo,
    suspendRepo,
    dailyQuoteRepo,
  };
}

/** trade_cal 单日开市行（Tushare 出参 shape）。 */
function calRow(calDate: string, isOpen: '0' | '1') {
  return { exchange: 'SSE', cal_date: calDate, is_open: isOpen, pretrade_date: '20260511' };
}
/** stk_limit 单只票行。 */
function stkRow(tsCode: string, tradeDate: string) {
  return {
    ts_code: tsCode,
    trade_date: tradeDate,
    pre_close: '10.00',
    up_limit: '11.00',
    down_limit: '9.00',
  };
}
/** suspend_d 单行（type S/R）。 */
function suspendRow(tsCode: string, tradeDate: string, type: 'S' | 'R', timing: string | null = null) {
  return { ts_code: tsCode, trade_date: tradeDate, suspend_timing: timing, suspend_type: type };
}

const DTO = { start_date: '20260512', end_date: '20260512', syncMode: 'overwrite' as const };

describe('BaseDataSyncService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('依赖顺序：先 trade_cal upsert 落库，再用查库的开市日跑 stk_limit / suspend_d', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, suspendRepo } = await buildModule();
    // Step1 trade_cal
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    // Step2 查库开市日
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    // Step3 stk_limit / Step4 suspend_d
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);

    const result = await service.sync(DTO);

    // 调用顺序：trade_cal → stk_limit → suspend_d
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['trade_cal', 'stk_limit', 'suspend_d']);
    // stk_limit / suspend_d 用的是查库返回的开市日，且 trade_cal upsert 先于查库
    expect(tradeCalRepo.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      tradeCalRepo.find.mock.invocationCallOrder[0],
    );
    expect(client.query.mock.calls[1][1]).toEqual({ trade_date: '20260512' });
    expect(client.query.mock.calls[2][1]).toEqual({ trade_date: '20260512' });
    expect(stkLimitRepo.upsert).toHaveBeenCalledTimes(1);
    expect(suspendRepo.upsert).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0); // 无空日，warnings 桶为空
    expect(result.success).toBe(3); // 1 trade_cal + 1 stk + 1 suspend
  });

  it('0 开市日：errors 含 no_open_trade_dates，且不调 stk_limit / suspend_d', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, suspendRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '0')]); // 仅非开市
    tradeCalRepo.find.mockResolvedValueOnce([]); // 查库 0 开市日

    const result = await service.sync(DTO);

    expect(client.query).toHaveBeenCalledTimes(1); // 只调了 trade_cal
    expect(client.query.mock.calls[0][0]).toBe('trade_cal');
    expect(stkLimitRepo.upsert).not.toHaveBeenCalled();
    expect(suspendRepo.upsert).not.toHaveBeenCalled();
    expect(result.errors).toContainEqual({
      apiName: 'no_open_trade_dates',
      params: { start_date: '20260512', end_date: '20260512' },
    });
  });

  it('某日 stk_limit 0 行：errors 含 stk_limit_empty + params，success 不计该日', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([]); // stk_limit 0 行
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);

    const result = await service.sync(DTO);

    expect(stkLimitRepo.upsert).not.toHaveBeenCalled();
    expect(result.errors).toContainEqual({
      apiName: 'stk_limit_empty',
      params: { trade_date: '20260512' },
    });
    // success = 1(trade_cal) + 0(stk) + 1(suspend)
    expect(result.success).toBe(2);
  });

  it('某日 suspend_d 0 行：归 warnings 含 suspend_d_empty（正常空日），不计入 errors', async () => {
    const { service, client, tradeCalRepo, suspendRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([]); // suspend_d 0 行

    const result = await service.sync(DTO);

    expect(suspendRepo.upsert).not.toHaveBeenCalled();
    // 正常空日归 warnings 桶
    expect(result.warnings).toContainEqual({
      apiName: 'suspend_d_empty',
      params: { trade_date: '20260512' },
    });
    // 关键：suspend_d 空日不得计入 errors（否则 UX 误显示"失败 N 项"）
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ apiName: 'suspend_d_empty' }),
    );
    expect(result.errors).toHaveLength(0);
  });

  it('suspend_d upsert 冲突键为 3 列 [tsCode, tradeDate, suspendType]', async () => {
    const { service, client, tradeCalRepo, suspendRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    // 同票同日 S+R 两行，3 列复合键不冲突
    client.query.mockResolvedValueOnce([
      suspendRow('000002.SZ', '20260512', 'S', '09:30-10:00'),
      suspendRow('000002.SZ', '20260512', 'R'),
    ]);

    await service.sync(DTO);

    const [entities, conflictKeys] = suspendRepo.upsert.mock.calls[0];
    expect(conflictKeys).toEqual(['tsCode', 'tradeDate', 'suspendType']);
    expect(entities).toHaveLength(2); // S 与 R 都保留（3 列键不冲突）
    const s = entities.find((e: { suspendType: string }) => e.suspendType === 'S');
    expect(s.tsCode).toBe('000002.SZ');
    expect(s.tradeDate).toBe('20260512');
    expect(s.suspendTiming).toBe('09:30-10:00');
    const r = entities.find((e: { suspendType: string }) => e.suspendType === 'R');
    expect(r.suspendTiming).toBeNull();
  });

  it("is_open 字符串 '1' → 1（smallint number），冲突键为 [exchange, calDate]", async () => {
    const { service, client, tradeCalRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1'), calRow('20260513', '0')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([]);

    await service.sync(DTO);

    const [entities, conflictKeys] = tradeCalRepo.upsert.mock.calls[0];
    expect(conflictKeys).toEqual(['exchange', 'calDate']);
    const open = entities.find((e: { calDate: string }) => e.calDate === '20260512');
    expect(open.isOpen).toBe(1);
    expect(typeof open.isOpen).toBe('number');
    const closed = entities.find((e: { calDate: string }) => e.calDate === '20260513');
    expect(closed.isOpen).toBe(0);
  });

  it('stk_limit numeric 字段原样字符串入库（不转 number）', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([]);

    await service.sync(DTO);

    const [entities, conflictKeys] = stkLimitRepo.upsert.mock.calls[0];
    expect(conflictKeys).toEqual(['tsCode', 'tradeDate']);
    const e = entities[0];
    expect(e.tsCode).toBe('000001.SZ');
    expect(e.preClose).toBe('10.00');
    expect(e.upLimit).toBe('11.00');
    expect(e.downLimit).toBe('9.00');
    expect(typeof e.upLimit).toBe('string');
  });

  it('trade_cal 范围返回 0 行：errors 含 trade_cal_empty，并跳过后两表', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, suspendRepo } = await buildModule();
    client.query.mockResolvedValueOnce([]); // trade_cal 0 行
    tradeCalRepo.find.mockResolvedValueOnce([]); // 无开市日

    const result = await service.sync(DTO);

    expect(result.errors).toContainEqual({
      apiName: 'trade_cal_empty',
      params: { start_date: '20260512', end_date: '20260512' },
    });
    expect(tradeCalRepo.upsert).not.toHaveBeenCalled();
    expect(stkLimitRepo.upsert).not.toHaveBeenCalled();
    expect(suspendRepo.upsert).not.toHaveBeenCalled();
  });

  it('Tushare 调用异常透出 result.errors（apiName=stk_limit + message），不静默吞错', async () => {
    const { service, client, tradeCalRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    // stk_limit 三次都抛（runWithRetry 重试耗尽后透出）
    client.query.mockRejectedValueOnce(new Error('boom-stk'));
    client.query.mockRejectedValueOnce(new Error('boom-stk'));
    client.query.mockRejectedValueOnce(new Error('boom-stk'));
    // suspend_d 正常
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);

    const result = await service.sync(DTO);

    const stkErr = result.errors.find((e) => e.apiName === 'stk_limit');
    expect(stkErr).toBeDefined();
    expect(stkErr?.message).toContain('boom-stk');
    expect(stkErr?.params).toEqual({ trade_date: '20260512' });
  });

  it('getStoredRange：三表各查 MIN/MAX，trade_cal 用 calDate 列', async () => {
    const { service, tradeCalRepo, stkLimitRepo, suspendRepo } = await buildModule();
    stkLimitRepo.createQueryBuilder().getRawOne.mockResolvedValue({ min: '20260101', max: '20260512' });
    suspendRepo.createQueryBuilder().getRawOne.mockResolvedValue({ min: '20260102', max: '20260510' });
    tradeCalRepo.createQueryBuilder().getRawOne.mockResolvedValue({ min: '20200101', max: '20261231' });

    const range = await service.getStoredRange();

    expect(range.stkLimit).toEqual({ min: '20260101', max: '20260512' });
    expect(range.suspend).toEqual({ min: '20260102', max: '20260510' });
    expect(range.tradeCal).toEqual({ min: '20200101', max: '20261231' });
  });

  it('startSync：单飞锁——同步进行中再次触发推送 error 事件', async () => {
    const { service } = await buildModule();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    void warnSpy;
    // 注入正在同步状态
    (service as unknown as { isSyncing: boolean }).isSyncing = true;

    const subject = service.startSync(DTO);
    const events: unknown[] = [];
    await new Promise<void>((resolve) => {
      subject.subscribe({ next: (e) => events.push(e), complete: () => resolve() });
    });

    expect(events).toEqual([
      expect.objectContaining({ type: 'error' }),
    ]);
  });

  // ── POST-sync 完整性对账（stk_limit） ─────────────────────────────────────

  /**
   * 预置 dailyQuoteRepo.query 的 SQL 感知 mock：
   *   - target SQL（FROM raw.stk_limit）→ targetRows
   *   - baseline SQL（FROM raw.daily_quote）→ baselineRows
   */
  function seedStkLimitCompleteness(
    repo: MockRepo & { query: jest.Mock },
    targetRows: Array<{ trade_date: string; total: string }>,
    baselineRows: Array<{ trade_date: string; total: string }>,
  ) {
    repo.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM raw.stk_limit')) return Promise.resolve(targetRows);
      if (sql.includes('FROM raw.daily_quote')) return Promise.resolve(baselineRows);
      return Promise.resolve([]);
    });
  }

  it('stk_limit 入库 < daily_quote 基准 → errors 含 stk_limit_incomplete（携带 apiName + 日期 + 行数）', async () => {
    const { service, client, tradeCalRepo, dailyQuoteRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);
    seedStkLimitCompleteness(
      dailyQuoteRepo,
      [{ trade_date: '20260512', total: '4000' }], // stk_limit 入库
      [{ trade_date: '20260512', total: '5000' }], // daily_quote 基准
    );

    const result = await service.sync(DTO);

    const incomplete = result.errors.find((e) => e.apiName === 'stk_limit_incomplete');
    expect(incomplete).toBeDefined();
    expect(incomplete?.message).toContain('20260512');
    expect(incomplete?.message).toContain('4000 < 5000');
  });

  it('stk_limit 对账：daily_quote 基准当日未落库 → 不告警', async () => {
    const { service, client, tradeCalRepo, dailyQuoteRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);
    seedStkLimitCompleteness(
      dailyQuoteRepo,
      [{ trade_date: '20260512', total: '100' }],
      [], // baseline 当日未落库 → 跳过
    );

    const result = await service.sync(DTO);

    expect(result.errors.filter((e) => e.apiName === 'stk_limit_incomplete')).toEqual([]);
  });

  it('stk_limit 入库 == daily_quote 基准（完整）→ 不告警', async () => {
    const { service, client, tradeCalRepo, dailyQuoteRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }]);
    client.query.mockResolvedValueOnce([stkRow('000001.SZ', '20260512')]);
    client.query.mockResolvedValueOnce([suspendRow('000002.SZ', '20260512', 'S')]);
    seedStkLimitCompleteness(
      dailyQuoteRepo,
      [{ trade_date: '20260512', total: '5000' }],
      [{ trade_date: '20260512', total: '5000' }],
    );

    const result = await service.sync(DTO);

    expect(result.errors.filter((e) => e.apiName === 'stk_limit_incomplete')).toEqual([]);
  });

  // ── 并发场景补测 ──────────────────────────────────────────────────────

  it('并发：多日期(≥3)所有 stk_limit/suspend_d 均被拉取并 upsert', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, suspendRepo, dailyQuoteRepo } = await buildModule();
    // trade_cal
    client.query.mockResolvedValueOnce([calRow('20260512', '1'), calRow('20260513', '1'), calRow('20260514', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }, { calDate: '20260513' }, { calDate: '20260514' }]);
    // 并发场景：调用顺序不确定，用 mockImplementation 按 apiName 分派
    client.query.mockImplementation(mockQueryByApiName({
      trade_cal: [],
      stk_limit: [stkRow('000001.SZ', '20260512'), stkRow('000002.SZ', '20260513'), stkRow('000003.SZ', '20260514')],
      suspend_d: [suspendRow('000002.SZ', '20260512', 'S'), suspendRow('000003.SZ', '20260513', 'R'), suspendRow('000004.SZ', '20260514', 'S')],
    }));
    seedStkLimitCompleteness(dailyQuoteRepo, [], []);

    const result = await service.sync({ ...DTO, start_date: '20260512', end_date: '20260514' });

    expect(stkLimitRepo.upsert).toHaveBeenCalled();
    expect(suspendRepo.upsert).toHaveBeenCalled();
    // success = trade_cal upsert(3行) + stk_limit upsert(3日期 × 3行/日期 = 9) + suspend_d upsert(3日期 × 3行/日期 = 9) = 21
    // mockQueryByApiName 对相同 apiName 返回同一数组，故每个日期都拿到全部 3 行
    const totalStkLimitRows = 3 * 3; // 3 dates × 3 rows per date (mock returns same array for all dates)
    const totalSuspendDRows = 3 * 3; // 3 dates × 3 rows per date
    const expectedSuccess = 3 + totalStkLimitRows + totalSuspendDRows; // 3 trade_cal + stk_limit + suspend_d
    expect(result.success).toBe(expectedSuccess);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('并发：某日期 query 抛异常 → 收集到 errors，其他日期不受影响', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, suspendRepo, dailyQuoteRepo } = await buildModule();
    // trade_cal
    client.query.mockResolvedValueOnce([calRow('20260512', '1'), calRow('20260513', '1'), calRow('20260514', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }, { calDate: '20260513' }, { calDate: '20260514' }]);
    // stk_limit 20260513 抛异常，其他正常
    let stkCallCount = 0;
    client.query.mockImplementation((apiName: string) => {
      if (apiName === 'stk_limit') {
        stkCallCount++;
        if (stkCallCount <= 2) {
          // attempt 1 & 2 for 20260513: rejected; other dates pass
          // 由于 runWithRetry 会为同一 tradeDate 重试，我们需要区分
        }
      }
      return Promise.resolve([]);
    });
    // 用更精确的 mock：按 apiName + tradeDate 分派
    const pendingStk = new Map<string, number>();
    client.query.mockImplementation((apiName: string, params?: Record<string, unknown>) => {
      if (apiName === 'stk_limit') {
        const td = params?.trade_date as string;
        const count = (pendingStk.get(td) ?? 0) + 1;
        pendingStk.set(td, count);
        if (td === '20260513') {
          return Promise.reject(new Error('boom-concurrent'));
        }
        return Promise.resolve([stkRow('000001.SZ', td)]);
      }
      if (apiName === 'suspend_d') {
        const td = params?.trade_date as string;
        return Promise.resolve([suspendRow('000002.SZ', td as string, 'S')]);
      }
      return Promise.resolve([]);
    });
    seedStkLimitCompleteness(dailyQuoteRepo, [], []);

    const result = await service.sync({ ...DTO, start_date: '20260512', end_date: '20260514' });

    // 20260513 stk_limit 失败 → errors 中有 stk_limit
    const stkErr = result.errors.find((e) => e.apiName === 'stk_limit' && e.params?.trade_date === '20260513');
    expect(stkErr).toBeDefined();
    expect(stkErr?.message).toContain('boom-concurrent');
    // 20260512 和 20260514 正常 upsert
    expect(stkLimitRepo.upsert).toHaveBeenCalled();
    // suspend_d 三个日期都正常
    expect(suspendRepo.upsert).toHaveBeenCalled();
    // warnings 无（suspend_d 都返回非空）
    expect(result.warnings).toHaveLength(0);
  });

  it('对账 collectCompletenessErrors 在所有日期 upsert 后执行', async () => {
    const { service, client, tradeCalRepo, stkLimitRepo, dailyQuoteRepo } = await buildModule();
    client.query.mockResolvedValueOnce([calRow('20260512', '1'), calRow('20260513', '1')]);
    tradeCalRepo.find.mockResolvedValueOnce([{ calDate: '20260512' }, { calDate: '20260513' }]);
    // 并发 stk_limit：两个日期都有数据
    client.query.mockImplementation(mockQueryByApiName({
      trade_cal: [],
      stk_limit: [stkRow('000001.SZ', '20260512'), stkRow('000001.SZ', '20260513')],
      suspend_d: [],
    }));
    // 对账：stk_limit 入库 < baseline
    seedStkLimitCompleteness(
      dailyQuoteRepo,
      [
        { trade_date: '20260512', total: '4000' },
        { trade_date: '20260513', total: '3000' },
      ],
      [
        { trade_date: '20260512', total: '5000' },
        { trade_date: '20260513', total: '5000' },
      ],
    );

    const result = await service.sync({ ...DTO, start_date: '20260512', end_date: '20260513' });

    // 对账 errors 在 results 中
    const incompleteErrors = result.errors.filter((e) => e.apiName === 'stk_limit_incomplete');
    expect(incompleteErrors).toHaveLength(2);
    // stk_limit upsert 发生在对账 query 之前
    const stkLimitUpsertOrder = stkLimitRepo.upsert.mock.invocationCallOrder[0];
    const dailyQuoteQueryOrder = dailyQuoteRepo.query.mock.invocationCallOrder[0];
    expect(stkLimitUpsertOrder).toBeLessThan(dailyQuoteQueryOrder);
  });
});
