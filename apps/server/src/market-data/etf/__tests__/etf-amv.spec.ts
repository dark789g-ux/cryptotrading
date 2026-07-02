/**
 * EtfAmvService 单元测试。
 *
 * 核心覆盖：sync(syncMode) 透传至底层 persistAmvDaily（共享 helper，决定增量跳过 vs 全量重写）。
 * amv-sync-helpers 本身（persistAmvDaily/aggregateAmount/buildAmvDailyRows）有独立测试覆盖，
 * 本文件只 mock 它们、验证 EtfAmvService 的透传逻辑，不重测 helper 内部。
 *
 * 注意：本文件 mock 了 amv-sync-helpers，无法发现 helper 真实行为回归——
 * helper 的真覆盖在 active-mv 的 spec；本文件聚焦 EtfAmvService 编排正确性。
 */
jest.mock('../../active-mv/amv-sync-helpers', () => ({
  aggregateAmount: jest.fn(),
  buildAmvDailyRows: jest.fn(),
  persistAmvDaily: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { EtfAmvService } from '../etf-amv.service';
import { FundAmvDailyEntity } from '../../../entities/raw/fund-amv-daily.entity';
import { EtfPcfEntity } from '../../../entities/raw/etf-pcf.entity';
import { FundDailyEntity } from '../../../entities/raw/fund-daily.entity';
import { EtfSymbolEntity } from '../../../entities/raw/etf-symbol.entity';
import {
  aggregateAmount,
  buildAmvDailyRows,
  persistAmvDaily,
} from '../../active-mv/amv-sync-helpers';
import type { AmvDailyRow } from '../../active-mv/active-mv.types';

const persistAmvDailyMock = persistAmvDaily as jest.MockedFunction<typeof persistAmvDaily>;
const aggregateAmountMock = aggregateAmount as jest.MockedFunction<typeof aggregateAmount>;
const buildAmvDailyRowsMock = buildAmvDailyRows as jest.MockedFunction<typeof buildAmvDailyRows>;

/** 构造一个链式 qb（pcf 走 getRawMany，daily 走 getMany） */
function makeQueryBuilder(opts: { getRawMany?: unknown[]; getMany?: unknown[] } = {}) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  qb.getRawMany = jest.fn().mockResolvedValue(opts.getRawMany ?? []);
  qb.getMany = jest.fn().mockResolvedValue(opts.getMany ?? []);
  return qb;
}

const AMV_ROW: AmvDailyRow = {
  tsCode: '510020.SH',
  tradeDate: '20260101',
  amvOpen: 1,
  amvHigh: 2,
  amvLow: 0.5,
  amvClose: 1.5,
  amvDif: 0,
  amvDea: 0,
  amvMacd: 0,
  amvZdf: 0,
  signal: 0,
  memberCount: 1,
};

describe('EtfAmvService syncMode 透传', () => {
  let service: EtfAmvService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const pcfRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(
        makeQueryBuilder({ getRawMany: [{ conCode: '000001.SZ' }] }),
      ),
    };
    const dailyRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(
        makeQueryBuilder({
          getMany: [
            { tradeDate: '20260101', open: 1, high: 2, low: 0.5, close: 1.5 },
          ],
        }),
      ),
    };
    // persistAmvDaily 已 mock，amvRepo 不会被真用
    const amvRepo = { __amvRepo: true };
    const symbolRepo = { find: jest.fn().mockResolvedValue([{ tsCode: '510020.SH' }]) };

    const dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === FundAmvDailyEntity) return amvRepo;
        if (entity === EtfPcfEntity) return pcfRepo;
        if (entity === FundDailyEntity) return dailyRepo;
        if (entity === EtfSymbolEntity) return symbolRepo;
        throw new Error('unexpected getRepository entity');
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EtfAmvService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(EtfAmvService);

    // aggregateAmount 返回非空 map，让流程继续到落库段
    aggregateAmountMock.mockResolvedValue(
      new Map([['20260101', { amt: 1000, memberCount: 1 }]]),
    );
    // buildAmvDailyRows 返回 1 行，确保 persistAmvDaily 被调用
    buildAmvDailyRowsMock.mockReturnValue([AMV_ROW]);
    persistAmvDailyMock.mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("syncMode='overwrite' 透传到 persistAmvDaily 第 4 参数（绕过增量跳过）", async () => {
    const result = await service.sync(
      ['510020.SH'],
      '20260101',
      '20260101',
      'overwrite',
    );

    expect(result.success).toBe(1);
    expect(persistAmvDailyMock).toHaveBeenCalledTimes(1);
    const args = persistAmvDailyMock.mock.calls[0];
    // 签名：(repo, idx, rows, syncMode, logger, label)
    expect(args[1]).toBe('510020.SH'); // idx
    expect(args[3]).toBe('overwrite'); // syncMode ← 关键透传点
    expect(args[5]).toBe('etf'); // label
  });

  it("syncMode='incremental' 透传到 persistAmvDaily", async () => {
    await service.sync(['510020.SH'], '20260101', '20260101', 'incremental');
    expect(persistAmvDailyMock).toHaveBeenCalledTimes(1);
    expect(persistAmvDailyMock.mock.calls[0][3]).toBe('incremental');
  });

  it('不传 syncMode 时默认 incremental 透传', async () => {
    await service.sync(['510020.SH'], '20260101', '20260101');
    expect(persistAmvDailyMock).toHaveBeenCalledTimes(1);
    expect(persistAmvDailyMock.mock.calls[0][3]).toBe('incremental');
  });

  it('启动日志记录实际 syncMode', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await service.sync(['510020.SH'], '20260101', '20260101', 'overwrite');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('overwrite'));
  });
});
