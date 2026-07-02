/**
 * EtfFundDailyService POST-sync 完整性对账单测。
 *
 * 覆盖三种场景：
 *   - actual < baseline（fund_daily 入库 < etf_symbol.tracked 总数）→ errors 含 fund_daily_incomplete
 *   - baseline 全表为 0（etf_symbol.tracked 未落库）→ 不告警
 *   - actual == baseline（完整）→ 不告警
 *
 * mock DataSource.getRepository + tushareClient.query + resolveOpenTradeDates；
 * 不连真 DB。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { FundDailyEntity } from '../../../entities/raw/fund-daily.entity';
import { TushareClientService } from '../../a-shares/services/tushare-client.service';
import * as syncUtils from '../../a-shares/sync/a-shares-sync-utils';
import { EtfFundDailyService } from '../etf-fund-daily.service';

jest.mock('../../a-shares/sync/a-shares-sync-utils', () => ({
  resolveOpenTradeDates: jest.fn(),
}));

describe('EtfFundDailyService - POST-sync 完整性对账', () => {
  let service: EtfFundDailyService;
  let client: { query: jest.Mock };
  let dailyRepo: {
    upsert: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };

  function seedQuery(
    targetRows: Array<{ trade_date: string; total: string }>,
    baselineRows: Array<{ total: string }>,
  ) {
    dailyRepo.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM raw.fund_daily')) return Promise.resolve(targetRows);
      if (sql.includes('FROM raw.etf_symbol')) return Promise.resolve(baselineRows);
      return Promise.resolve([]);
    });
  }

  beforeEach(async () => {
    client = { query: jest.fn() };
    dailyRepo = {
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockImplementation((x: unknown) => x),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
      query: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(dailyRepo),
    };
    (syncUtils.resolveOpenTradeDates as jest.Mock).mockResolvedValue(['20260630']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EtfFundDailyService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: TushareClientService, useValue: client },
      ],
    }).compile();
    service = module.get(EtfFundDailyService);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * 驱动 syncFundDaily 走完两阶段并触发对账：
   *   - fund_adj 返回空（不会产生 qfq 计算但不阻塞流程）
   *   - fund_daily 返回 1 条 tracked 行 → upsert 成功
   *   - completeness SQL 由 seedQuery 控制
   */
  async function runSyncFundDaily(): Promise<{ errors: Array<{ apiName: string; message: string }> }> {
    client.query.mockImplementation((apiName: string) => {
      if (apiName === 'fund_adj') return Promise.resolve([]);
      if (apiName === 'fund_daily') {
        return Promise.resolve([
          {
            ts_code: '510300.SH',
            trade_date: '20260630',
            open: 4.0, high: 4.1, low: 3.9, close: 4.05,
            pre_close: 4.0, change: 0.05, pct_chg: 1.25,
            vol: 1000, amount: 4000,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    return service.syncFundDaily(['510300.SH'], '20260630', '20260630');
  }

  it('actual < baseline → errors 含 fund_daily_incomplete（tracked 全表标量基准）', async () => {
    seedQuery(
      [{ trade_date: '20260630', total: '900' }], // target: fund_daily
      [{ total: '1000' }], // baseline: etf_symbol.tracked 全表
    );

    const result = await runSyncFundDaily();

    const incompletes = result.errors.filter((e) => e.apiName === 'fund_daily_incomplete');
    expect(incompletes).toHaveLength(1);
    expect(incompletes[0].message).toContain('20260630');
    expect(incompletes[0].message).toContain('900 < 1000');
  });

  it('baseline 全表为 0（etf_symbol.tracked 未落库）→ 不告警', async () => {
    seedQuery(
      [{ trade_date: '20260630', total: '5' }],
      [{ total: '0' }], // tracked 全表空 → 跳过
    );

    const result = await runSyncFundDaily();

    expect(result.errors.filter((e) => e.apiName === 'fund_daily_incomplete')).toEqual([]);
  });

  it('actual == baseline（完整）→ 不告警', async () => {
    seedQuery(
      [{ trade_date: '20260630', total: '1000' }],
      [{ total: '1000' }],
    );

    const result = await runSyncFundDaily();

    expect(result.errors.filter((e) => e.apiName === 'fund_daily_incomplete')).toEqual([]);
  });
});
