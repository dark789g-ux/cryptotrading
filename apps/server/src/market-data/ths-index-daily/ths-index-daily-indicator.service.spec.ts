// TODO: 需集成测试验证 API 契约 —— 本文件只断言 ThsIndexDailyIndicatorService
// 与 indicators/indicators.ts 的 calcIndicators 数学等价。
// 如果未来抽取专用 indicators/moving-average.ts 等纯函数，需要更新等价性测试。
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';
import { ThsIndexDailyQuoteEntity } from '../../entities/ths-index-daily/ths-index-daily-quote.entity';
import { ThsIndexDailyIndicatorEntity } from '../../entities/ths-index-daily/ths-index-daily-indicator.entity';
import { calcIndicators, KlineRow } from '../../indicators/indicators';
import { calcBrickChartPoints } from '../../indicators/brick-chart';

function fakeQuotesRepo(rows: Array<{ tradeDate: string; open: number; high: number; low: number; close: number }>) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

function fakeIndicatorsRepo() {
  return {
    createQueryBuilder: jest.fn(),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

describe('ThsIndexDailyIndicatorService', () => {
  it('MA/MACD/KDJ/BBI/BRICK 与 calcIndicators + calcBrickChartPoints 输出一致', async () => {
    const quoteRows = Array.from({ length: 30 }, (_, i) => ({
      tradeDate: `2026050${i < 9 ? '0' + (i + 1) : i + 1}`.slice(-8).padStart(8, '0'),
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 100 + i * 1.5,
    }));
    const quotesRepo = fakeQuotesRepo(quoteRows);
    const indicatorsRepo = fakeIndicatorsRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThsIndexDailyIndicatorService,
        { provide: getRepositoryToken(ThsIndexDailyQuoteEntity), useValue: quotesRepo },
        { provide: getRepositoryToken(ThsIndexDailyIndicatorEntity), useValue: indicatorsRepo },
      ],
    }).compile();
    module.useLogger(false);

    const service = module.get(ThsIndexDailyIndicatorService);
    const written = await service.recalculateForSymbols(['881101.TI']);
    expect(written).toBe(quoteRows.length);

    // 对照计算
    const klineRows: KlineRow[] = quoteRows.map((r) => ({
      open_time: r.tradeDate,
      open: r.open, high: r.high, low: r.low, close: r.close, volume: 0,
    }));
    const expected = calcIndicators(klineRows);
    const expectedBricks = calcBrickChartPoints(
      quoteRows.map((r) => ({ high: r.high, low: r.low, close: r.close })),
    );

    const upsertCalls = indicatorsRepo.upsert.mock.calls;
    expect(upsertCalls).toHaveLength(1);
    const [persisted] = upsertCalls[0];
    expect(persisted).toHaveLength(quoteRows.length);

    for (let i = 0; i < quoteRows.length; i++) {
      const p = persisted[i];
      expect(p.tradeDate).toBe(quoteRows[i].tradeDate);
      expect(p.ma5).toBe(expected[i].MA5);
      expect(p.ma30).toBe(expected[i].MA30);
      expect(p.ma60).toBe(expected[i].MA60);
      expect(p.dif).toBe(expected[i].DIF);
      expect(p.dea).toBe(expected[i].DEA);
      expect(p.macd).toBe(expected[i].MACD);
      expect(p.kdjK).toBe(expected[i]['KDJ.K']);
      expect(p.bbi).toBe(expected[i].BBI);
      expect(p.brick).toBe(expectedBricks[i].brick);
      expect(p.brickDelta).toBe(expectedBricks[i].delta);
      expect(p.brickXg).toBe(expectedBricks[i].xg);
    }
  });
});
