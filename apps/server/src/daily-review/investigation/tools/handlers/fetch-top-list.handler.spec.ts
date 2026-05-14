import { FetchTopListHandler } from './fetch-top-list.handler';
import { ToolArgError } from '../tool-types';
import type { Repository } from 'typeorm';
import type { MoneyFlowStockEntity } from '../../../../entities/money-flow/money-flow-stock.entity';
import type { TushareClientService } from '../../../../market-data/a-shares/services/tushare-client.service';

describe('FetchTopListHandler', () => {
  let stockRepo: { query: jest.Mock };
  let tushare: { query: jest.Mock };
  let handler: FetchTopListHandler;

  beforeEach(() => {
    stockRepo = { query: jest.fn() };
    tushare = { query: jest.fn() };
    handler = new FetchTopListHandler(
      stockRepo as unknown as Repository<MoneyFlowStockEntity>,
      tushare as unknown as TushareClientService,
    );
  });

  it("1) mode='daily' 正常路径：单次调 top_list(trade_date) 后映射字段", async () => {
    tushare.query.mockResolvedValue([
      {
        trade_date: '20260513',
        ts_code: '601138.SH',
        name: '工业富联',
        close: 25.6,
        pct_change: 10.01,
        turnover_rate: 5.4,
        amount: 1234567,
        l_sell: 200000,
        l_buy: 500000,
        l_amount: 700000,
        net_amount: 300000,
        net_rate: 0.24,
        amount_rate: 0.57,
        float_values: 9999999,
        reason: '日涨幅偏离 7%',
      },
    ]);
    const out: any = await handler.call({ mode: 'daily', tradeDate: '20260513' });
    expect(tushare.query).toHaveBeenCalledWith('top_list', { trade_date: '20260513' });
    expect(out.mode).toBe('daily');
    expect(out.tradeDate).toBe('20260513');
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].tsCode).toBe('601138.SH');
    expect(out.entries[0].netAmount).toBe(300000);
    expect(out.entries[0].reason).toBe('日涨幅偏离 7%');
  });

  it("2) mode='recent5d' 正常路径：用 DB 取 5 个交易日，分别带 ts_code 调 top_list；appearCount 为命中日数", async () => {
    stockRepo.query.mockResolvedValueOnce([
      { trade_date: '20260513' },
      { trade_date: '20260512' },
      { trade_date: '20260511' },
      { trade_date: '20260510' },
      { trade_date: '20260509' },
    ]);
    tushare.query
      .mockResolvedValueOnce([{ trade_date: '20260513', ts_code: '601138.SH', net_amount: 1, reason: 'r1' }])
      .mockResolvedValueOnce([]) // 0512 未上榜
      .mockResolvedValueOnce([{ trade_date: '20260511', ts_code: '601138.SH', net_amount: 2, reason: 'r2' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const out: any = await handler.call({ mode: 'recent5d', tsCode: '601138.SH' });
    expect(out.mode).toBe('recent5d');
    expect(out.tsCode).toBe('601138.SH');
    expect(out.entries).toHaveLength(2);
    expect(out.appearCount).toBe(2);
    expect(tushare.query).toHaveBeenCalledTimes(5);
    // 抽样验证第一次调用的参数
    expect(tushare.query).toHaveBeenNthCalledWith(1, 'top_list', {
      trade_date: '20260513',
      ts_code: '601138.SH',
    });
  });

  it("3) 降级路径：recent5d 但 DB 无交易日 → entries=[] / appearCount=0，不调 Tushare", async () => {
    stockRepo.query.mockResolvedValueOnce([]);
    const out: any = await handler.call({ mode: 'recent5d', tsCode: '601138.SH' });
    expect(out.entries).toEqual([]);
    expect(out.appearCount).toBe(0);
    expect(tushare.query).not.toHaveBeenCalled();
  });

  it('4) 入参校验：mode 缺失 / mode=daily 缺 tradeDate / mode=recent5d 缺 tsCode / tradeDate 非 YYYYMMDD', async () => {
    await expect(handler.call({})).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ mode: 'daily' })).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ mode: 'daily', tradeDate: '2026-05-13' })).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ mode: 'recent5d' })).rejects.toBeInstanceOf(ToolArgError);
  });
});
