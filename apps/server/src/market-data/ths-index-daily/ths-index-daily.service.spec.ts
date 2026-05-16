import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ThsIndexDailyService } from './ths-index-daily.service';

describe('ThsIndexDailyService', () => {
  let service: ThsIndexDailyService;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThsIndexDailyService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(ThsIndexDailyService);
  });

  it('JOIN 行为：indicators 缺失时对应字段返回 null；ts/start/end 透传 $1/$2/$3', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        tradeDate: '20260512',
        open: 1000, high: 1020, low: 990, close: 1010, volHand: 100,
        ma5: null, ma30: null, ma60: null, ma120: null, ma240: null,
        dif: null, dea: null, macd: null,
        kdjK: null, kdjD: null, kdjJ: null, bbi: null,
        brick: null, brickDelta: null, brickXg: null,
      },
    ]);

    const result = await service.getKlines({
      ts_code: '881101.TI',
      start_date: '20260512',
      end_date: '20260512',
    });

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query.mock.calls[0][1]).toEqual(['881101.TI', '20260512', '20260512']);

    expect(result).toHaveLength(1);
    expect(result[0].open_time).toBe('20260512');
    expect(result[0].MA5).toBeNull();
    expect(result[0].DIF).toBeNull();
    expect(result[0].brickChart).toBeUndefined();
    // 落库存「手」，输出转「股」（×100）
    expect(result[0].volume).toBe(100 * 100);
  });

  it('排序：SQL 使用 ORDER BY q.trade_date ASC', async () => {
    dataSource.query.mockResolvedValueOnce([]);
    await service.getKlines({ ts_code: '881101.TI', start_date: '20260501', end_date: '20260512' });
    const sql: string = dataSource.query.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY q\.trade_date ASC/);
  });

  it('brickChart 仅在 brick 与 brickDelta 同时存在时返回对象', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        tradeDate: '20260512',
        open: 1, high: 1, low: 1, close: 1, volHand: 0,
        ma5: 1, ma30: 1, ma60: 1, ma120: 1, ma240: 1,
        dif: 0, dea: 0, macd: 0, kdjK: 50, kdjD: 50, kdjJ: 50, bbi: 1,
        brick: 100, brickDelta: 5, brickXg: true,
      },
    ]);
    const result = await service.getKlines({
      ts_code: '881101.TI', start_date: '20260512', end_date: '20260512',
    });
    expect(result[0].brickChart).toEqual({ brick: 100, delta: 5, xg: true });
  });
});
