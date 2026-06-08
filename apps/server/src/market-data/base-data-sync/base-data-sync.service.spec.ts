// TODO: 需集成测试验证 API 契约 —— 本文件 mock 了 TushareClientService.query，
// 无法发现 trade_cal / stk_limit / suspend_d 真实接口名、字段名、单位变更。
// 集成测试应覆盖：① 三接口真实响应 fields 顺序 ② trade_cal 真实开市日序列。
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { BaseDataSyncService } from './base-data-sync.service';
import { TradeCalEntity } from '../../entities/raw/trade-cal.entity';
import { StkLimitEntity } from '../../entities/raw/stk-limit.entity';
import { SuspendEntity } from '../../entities/raw/suspend.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

interface MockRepo {
  upsert: jest.Mock;
  create: jest.Mock;
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
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

async function buildModule(): Promise<{
  service: BaseDataSyncService;
  client: { query: jest.Mock };
  tradeCalRepo: MockRepo;
  stkLimitRepo: MockRepo;
  suspendRepo: MockRepo;
}> {
  const client = { query: jest.fn() };
  const tradeCalRepo = makeRepo();
  const stkLimitRepo = makeRepo();
  const suspendRepo = makeRepo();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BaseDataSyncService,
      { provide: getRepositoryToken(TradeCalEntity), useValue: tradeCalRepo },
      { provide: getRepositoryToken(StkLimitEntity), useValue: stkLimitRepo },
      { provide: getRepositoryToken(SuspendEntity), useValue: suspendRepo },
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
});
