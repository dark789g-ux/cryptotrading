import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
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

  describe('recalcKlines', () => {
    const dto = { ts_code: '881101.TI', start_date: '20260501', end_date: '20260512' };

    function makeMockRows(count = 10) {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const base = 100 + i * 2;
        rows.push({
          tradeDate: `202605${String(i + 1).padStart(2, '0')}`,
          open: base,
          high: base + 3,
          low: base - 1,
          close: base + (i % 3) - 1,
          volHand: 100 + i,
          ma5: base + 0.5,
          ma30: base - 0.5,
          ma60: base - 1.5,
          ma120: base - 3,
          ma240: base - 5,
          dif: 0.5 + i * 0.1,
          dea: 0.3 + i * 0.05,
          macd: 0.2 + i * 0.05,
          kdjK: 50 + i,
          kdjD: 45 + i,
          kdjJ: 60 + i,
          bbi: base + 1,
          brick: i > 2 ? base : null,
          brickDelta: i > 2 ? 1 : null,
          brickXg: i === 5,
        });
      }
      return rows;
    }

    it('不传 kdjParams 时返回与 getKlines 完全相同的数据', async () => {
      dataSource.query.mockResolvedValue(makeMockRows());

      const fromGet = await service.getKlines(dto);
      const fromRecalc = await service.recalcKlines(dto, undefined);

      expect(fromRecalc).toEqual(fromGet);
    });

    it('自定义 KDJ 参数会改变 KDJ 三列，其余列保持不变', async () => {
      dataSource.query.mockResolvedValue(makeMockRows());

      const defaultRows = await service.recalcKlines(dto, undefined);
      const customRows = await service.recalcKlines(dto, { n: 6, m1: 2, m2: 2 });

      expect(customRows).toHaveLength(defaultRows.length);

      for (let i = 0; i < customRows.length; i++) {
        const custom = customRows[i];
        const baseline = defaultRows[i];

        expect(custom['KDJ.K']).not.toEqual(baseline['KDJ.K']);
        expect(custom['KDJ.D']).not.toEqual(baseline['KDJ.D']);
        expect(custom['KDJ.J']).not.toEqual(baseline['KDJ.J']);

        expect(custom.open_time).toEqual(baseline.open_time);
        expect(custom.open).toEqual(baseline.open);
        expect(custom.high).toEqual(baseline.high);
        expect(custom.low).toEqual(baseline.low);
        expect(custom.close).toEqual(baseline.close);
        expect(custom.volume).toEqual(baseline.volume);
        expect(custom.DIF).toEqual(baseline.DIF);
        expect(custom.DEA).toEqual(baseline.DEA);
        expect(custom.MACD).toEqual(baseline.MACD);
        expect(custom.BBI).toEqual(baseline.BBI);
        expect(custom.MA5).toEqual(baseline.MA5);
        expect(custom.MA30).toEqual(baseline.MA30);
        expect(custom.MA60).toEqual(baseline.MA60);
        expect(custom.MA120).toEqual(baseline.MA120);
        expect(custom.MA240).toEqual(baseline.MA240);
        expect(custom.brickChart).toEqual(baseline.brickChart);
      }
    });

    it('显式传入默认参数 9/3/3 时不触发重算，结果与 getKlines 一致', async () => {
      dataSource.query.mockResolvedValue(makeMockRows());

      const fromGet = await service.getKlines(dto);
      const fromRecalc = await service.recalcKlines(dto, { n: 9, m1: 3, m2: 3 });

      expect(fromRecalc).toEqual(fromGet);
    });

    it('自定义 KDJ 结果按 4 位小数取整，并与 calcKdjSeries 取整后一致', async () => {
      const mockRows = makeMockRows();
      dataSource.query.mockResolvedValue(mockRows);

      const kdjParams = { n: 6, m1: 2, m2: 2 };
      const out = await service.recalcKlines(dto, kdjParams);

      const expected = calcKdjSeries(
        mockRows.map((r) => ({ high: r.high, low: r.low, close: r.close })),
        kdjParams.n,
        kdjParams.m1,
        kdjParams.m2,
      ).map(roundKdjPoint);

      expect(out).toHaveLength(expected.length);
      for (let i = 0; i < out.length; i++) {
        const bar = out[i];
        expect(bar['KDJ.K']).toBeCloseTo(expected[i].k, 4);
        expect(bar['KDJ.D']).toBeCloseTo(expected[i].d, 4);
        expect(bar['KDJ.J']).toBeCloseTo(expected[i].j, 4);

        expect(bar['KDJ.K']).toEqual(parseFloat(bar['KDJ.K'].toFixed(4)));
        expect(bar['KDJ.D']).toEqual(parseFloat(bar['KDJ.D'].toFixed(4)));
        expect(bar['KDJ.J']).toEqual(parseFloat(bar['KDJ.J'].toFixed(4)));
      }
    });
  });
});
