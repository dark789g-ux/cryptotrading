import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomIndexDailyIndicatorEntity } from '../../../entities/custom-index/custom-index-daily-indicator.entity';
import { calcIndicators, KlineRow } from '../../../indicators/indicators';
import { CustomIndexIndicatorService } from './custom-index-indicator.service';
import type { IndexQuoteRow } from './custom-index-compute.types';

const CID = '11111111-1111-1111-1111-111111111111';

function fakeIndicatorsRepo() {
  return {
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

describe('CustomIndexIndicatorService', () => {
  it('3 日 quotes → ma5/dif 与 calcIndicators 一致且 dif 非 null', async () => {
    const quotes: IndexQuoteRow[] = [
      { tradeDate: '20260102', open: 100, high: 105, low: 95, close: 102 },
      { tradeDate: '20260103', open: 102, high: 108, low: 100, close: 106 },
      { tradeDate: '20260106', open: 106, high: 110, low: 104, close: 108 },
    ];

    const indicatorsRepo = fakeIndicatorsRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomIndexIndicatorService,
        {
          provide: getRepositoryToken(CustomIndexDailyIndicatorEntity),
          useValue: indicatorsRepo,
        },
      ],
    }).compile();
    module.useLogger(false);

    const service = module.get(CustomIndexIndicatorService);
    const written = await service.upsertIndicatorsFromQuotes(CID, quotes);
    expect(written).toBe(3);

    const klineRows: KlineRow[] = quotes.map((q) => ({
      open_time: q.tradeDate,
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: 0,
    }));
    const expected = calcIndicators(klineRows);

    const upsertCalls = indicatorsRepo.upsert.mock.calls;
    expect(upsertCalls).toHaveLength(1);
    const [persisted] = upsertCalls[0];
    expect(persisted).toHaveLength(3);

    for (let i = 0; i < quotes.length; i++) {
      const p = persisted[i];
      expect(p.customIndexId).toBe(CID);
      expect(p.tradeDate).toBe(quotes[i].tradeDate);
      expect(p.ma5).toBe(expected[i].MA5);
      expect(p.dif).toBe(expected[i].DIF);
      expect(p.dif).not.toBeNull();
    }
  });
});
