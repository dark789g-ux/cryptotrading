import { LookupStockHandler } from './lookup-stock.handler';
import { ToolArgError } from '../tool-types';
import type { Repository } from 'typeorm';
import type { AShareSymbolEntity } from '../../../../entities/a-share/a-share-symbol.entity';
import type { MoneyFlowStockEntity } from '../../../../entities/money-flow/money-flow-stock.entity';
import type { ThsMemberStockEntity } from '../../../../entities/money-flow/ths-member-stock.entity';
import type { TushareClientService } from '../../../../market-data/a-shares/services/tushare-client.service';

/**
 * 构造一个轻量 query builder：捕获最后一次 take 的值，统一控制 getMany 的返回。
 */
function buildQbRepo<T>(getManyResult: T[]) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(getManyResult),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOne: jest.fn(),
    query: jest.fn(),
    qb,
  };
}

describe('LookupStockHandler', () => {
  let symbolRepo: ReturnType<typeof buildQbRepo<AShareSymbolEntity>>;
  let moneyFlowStockRepo: ReturnType<typeof buildQbRepo<MoneyFlowStockEntity>>;
  let memberStockRepo: ReturnType<typeof buildQbRepo<ThsMemberStockEntity>>;
  let tushare: { query: jest.Mock };
  let handler: LookupStockHandler;

  beforeEach(() => {
    symbolRepo = buildQbRepo<AShareSymbolEntity>([]);
    moneyFlowStockRepo = buildQbRepo<MoneyFlowStockEntity>([]);
    memberStockRepo = buildQbRepo<ThsMemberStockEntity>([]);
    tushare = { query: jest.fn().mockResolvedValue([]) };

    handler = new LookupStockHandler(
      symbolRepo as unknown as Repository<AShareSymbolEntity>,
      moneyFlowStockRepo as unknown as Repository<MoneyFlowStockEntity>,
      memberStockRepo as unknown as Repository<ThsMemberStockEntity>,
      tushare as unknown as TushareClientService,
    );
  });

  it('1) 正常路径：聚合 basic / recentFlow / concepts / topListEntries', async () => {
    symbolRepo.findOne.mockResolvedValue({
      tsCode: '601138.SH',
      name: '工业富联',
      swIndustryL3Code: '电子元件',
      area: '上海',
      listDate: '20180608',
    } as unknown as AShareSymbolEntity);

    // 最近 6 行资金流：最新 trade_date=20260513
    const flowRows = [
      { tradeDate: '20260513', netAmount: '1000' },
      { tradeDate: '20260512', netAmount: '500' },
      { tradeDate: '20260511', netAmount: '300' },
      { tradeDate: '20260510', netAmount: '200' },
      { tradeDate: '20260509', netAmount: '100' },
      { tradeDate: '20260508', netAmount: '50' },
    ];
    moneyFlowStockRepo.qb.getMany.mockResolvedValue(flowRows);
    memberStockRepo.qb.getMany.mockResolvedValue([
      { tsCode: '885900.TI', conCode: '601138.SH' },
      { tsCode: '885901.TI', conCode: '601138.SH' },
    ]);

    // 第一个 query → ROW_NUMBER 排名；第二个 query → distinct trade_date
    moneyFlowStockRepo.query
      .mockResolvedValueOnce([{ rank: 3 }])
      .mockResolvedValueOnce([{ trade_date: '20260513' }, { trade_date: '20260512' }]);

    // top_list 两次：第一日命中一条，第二日空
    tushare.query
      .mockResolvedValueOnce([
        { trade_date: '20260513', net_amount: 9999, reason: '日涨幅偏离 7%' },
      ])
      .mockResolvedValueOnce([]);

    const out: any = await handler.call({ tsCode: '601138.SH' });

    expect(out.basic.name).toBe('工业富联');
    expect(out.basic.industry).toBe('电子元件');
    expect(out.basic.marketCap).toBeNull();
    expect(out.recentFlow.last5dNetIn).toBe(2100); // 1000+500+300+200+100
    expect(out.recentFlow.last20dNetIn).toBe(2150);
    expect(out.recentFlow.todayRank).toBe(3);
    expect(out.concepts).toEqual(['885900.TI', '885901.TI']);
    expect(out.topListEntries).toHaveLength(1);
    expect(out.topListEntries[0]).toEqual({
      tradeDate: '20260513',
      netAmount: 9999,
      reason: '日涨幅偏离 7%',
    });
    expect(tushare.query).toHaveBeenCalledWith('top_list', {
      trade_date: '20260513',
      ts_code: '601138.SH',
    });
  });

  it('2) 降级路径：money_flow_stocks 空表 → recentFlow 全 null + topListEntries 空 + 不调 Tushare', async () => {
    symbolRepo.findOne.mockResolvedValue(null);
    moneyFlowStockRepo.qb.getMany.mockResolvedValue([]);
    memberStockRepo.qb.getMany.mockResolvedValue([]);
    // distinct trade_date 返回空
    moneyFlowStockRepo.query.mockResolvedValueOnce([]);

    const out: any = await handler.call({ tsCode: '999999.SH' });

    expect(out.basic.name).toBe('999999.SH'); // symbol 未命中时用 tsCode 作 name
    expect(out.recentFlow).toEqual({ last5dNetIn: null, last20dNetIn: null, todayRank: null });
    expect(out.concepts).toEqual([]);
    expect(out.topListEntries).toEqual([]);
    expect(tushare.query).not.toHaveBeenCalled();
  });

  it('3) 入参 tsCode 缺失 → 抛 ToolArgError', async () => {
    await expect(handler.call({})).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ tsCode: 123 as any })).rejects.toBeInstanceOf(ToolArgError);
  });
});
