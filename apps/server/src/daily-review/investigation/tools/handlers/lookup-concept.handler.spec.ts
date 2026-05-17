import { LookupConceptHandler } from './lookup-concept.handler';
import { ToolArgError } from '../tool-types';
import type { Repository } from 'typeorm';
import type { MoneyFlowSectorEntity } from '../../../../entities/money-flow/money-flow-sector.entity';
import type { MoneyFlowIndustryEntity } from '../../../../entities/money-flow/money-flow-industry.entity';
import type { MoneyFlowStockEntity } from '../../../../entities/money-flow/money-flow-stock.entity';
import type { ThsMemberStockEntity } from '../../../../entities/money-flow/ths-member-stock.entity';

function buildQbRepo<T>(getOneResult: T | null = null) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(getOneResult),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    query: jest.fn(),
    qb,
  };
}

describe('LookupConceptHandler', () => {
  let sectorRepo: ReturnType<typeof buildQbRepo<MoneyFlowSectorEntity>>;
  let industryRepo: ReturnType<typeof buildQbRepo<MoneyFlowIndustryEntity>>;
  let stockRepo: ReturnType<typeof buildQbRepo<MoneyFlowStockEntity>>;
  let memberRepo: ReturnType<typeof buildQbRepo<ThsMemberStockEntity>>;
  let handler: LookupConceptHandler;

  beforeEach(() => {
    sectorRepo = buildQbRepo<MoneyFlowSectorEntity>(null);
    industryRepo = buildQbRepo<MoneyFlowIndustryEntity>(null);
    stockRepo = buildQbRepo<MoneyFlowStockEntity>(null);
    memberRepo = buildQbRepo<ThsMemberStockEntity>(null);
    handler = new LookupConceptHandler(
      sectorRepo as unknown as Repository<MoneyFlowSectorEntity>,
      industryRepo as unknown as Repository<MoneyFlowIndustryEntity>,
      stockRepo as unknown as Repository<MoneyFlowStockEntity>,
      memberRepo as unknown as Repository<ThsMemberStockEntity>,
    );
  });

  it('1) 命中概念：sector 命中 + constituents 排序后首位为龙头', async () => {
    sectorRepo.qb.getOne.mockResolvedValue({
      tsCode: '885900.TI',
      sector: '半导体',
      pctChange: '3.21',
    });
    stockRepo.query.mockResolvedValueOnce([
      { ts_code: '601138.SH', name: '工业富联', pct_change: '5.10', net_amount: '99999' },
      { ts_code: '000725.SZ', name: '京东方A',  pct_change: '2.10', net_amount: '50000' },
    ]);

    const out: any = await handler.call({ conceptName: '半导体' });

    expect(out.matchedName).toBe('半导体');
    expect(out.todayPctChg).toBe(3.21);
    expect(out.constituents).toHaveLength(2);
    expect(out.constituents[0]).toEqual({
      tsCode: '601138.SH',
      name: '工业富联',
      pctChg: 5.1,
      netIn: 99999,
      isLeader: true,
    });
    expect(out.constituents[1].isLeader).toBe(false);
  });

  it('2) 降级路径：sector 未命中 → 回退到 industry，constituents 空（行业无成分股映射）', async () => {
    sectorRepo.qb.getOne.mockResolvedValue(null);
    industryRepo.qb.getOne.mockResolvedValue({
      tsCode: 'IND001',
      industry: '电子元件',
      pctChange: '1.50',
    });

    const out: any = await handler.call({ conceptName: '电子元件' });
    expect(out.matchedName).toBe('电子元件');
    expect(out.todayPctChg).toBe(1.5);
    expect(out.constituents).toEqual([]);
    // 不应触发 stockRepo.query（不查成分股）
    expect(stockRepo.query).not.toHaveBeenCalled();
  });

  it('3) 全部未命中：matchedName=入参 + null + 空数组（不抛错）', async () => {
    sectorRepo.qb.getOne.mockResolvedValue(null);
    industryRepo.qb.getOne.mockResolvedValue(null);
    const out: any = await handler.call({ conceptName: '不存在的板块' });
    expect(out).toEqual({
      matchedName: '不存在的板块',
      todayPctChg: null,
      constituents: [],
    });
  });

  it('4) 入参 conceptName 缺失 → 抛 ToolArgError', async () => {
    await expect(handler.call({})).rejects.toBeInstanceOf(ToolArgError);
  });
});
