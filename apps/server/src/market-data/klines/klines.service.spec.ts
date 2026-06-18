import { KlinesService } from './klines.service';
import { KlineEntity } from '../../entities/symbol/kline.entity';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';

/**
 * 构造一个确定性的 KlineEntity 序列，便于验证 KDJ 重算。
 * 价格递增，默认 DB 中的 KDJ 恒为 50（人为固定，便于断言被替换）。
 */
function makeKlineRows(count = 10): KlineEntity[] {
  const rows: KlineEntity[] = [];
  for (let i = 0; i < count; i++) {
    const row = new KlineEntity();
    row.id = String(i + 1);
    row.symbol = 'BTCUSDT';
    row.interval = '1h';
    row.openTime = new Date(2026_01_01_00_00_00 + i * 3_600_000);
    row.open = String(100 + i);
    row.high = String(102 + i);
    row.low = String(99 + i);
    row.close = String(101 + i);
    row.volume = String(1000 + i * 10);
    row.closeTime = new Date(row.openTime.getTime() + 3_599_999);
    row.quoteVolume = String(100_000 + i * 1000);
    row.trades = String(100 + i);
    row.takerBuyBaseVol = String(500 + i * 5);
    row.takerBuyQuoteVol = String(50_000 + i * 500);
    row.dif = 0.1 + i;
    row.dea = 0.2 + i;
    row.macd = 0.3 + i;
    row.kdjK = 50;
    row.kdjD = 50;
    row.kdjJ = 50;
    row.bbi = 100 + i;
    row.ma5 = 100 + i;
    row.ma30 = 100 + i;
    row.ma60 = 100 + i;
    row.ma120 = 100 + i;
    row.ma240 = 100 + i;
    row.quoteVolume10 = 100_000 + i;
    row.atr14 = 1 + i * 0.1;
    row.lossAtr14 = 0.5 + i * 0.1;
    row.low9 = 99 + i;
    row.high9 = 102 + i;
    row.stopLossPct = 0.02;
    row.riskRewardRatio = 2;
    rows.push(row);
  }
  return rows;
}

function makeRepoMock(rows: KlineEntity[]) {
  return { find: jest.fn().mockResolvedValue(rows) };
}

describe('KlinesService.recalcKlines', () => {
  it('不传 kdjParams 时保持原始 KDJ 不变', async () => {
    const rows = makeKlineRows(10);
    const repo = makeRepoMock(rows);
    const service = new KlinesService(repo as never);

    const out = (await service.recalcKlines('BTCUSDT', '1h')) as Array<{
      'KDJ.K': number;
      'KDJ.D': number;
      'KDJ.J': number;
    }>;

    expect(repo.find).toHaveBeenCalledWith({
      where: { symbol: 'BTCUSDT', interval: '1h' },
      order: { openTime: 'ASC' },
    });
    expect(out).toHaveLength(rows.length);
    expect(out.every((bar) => bar['KDJ.K'] === 50 && bar['KDJ.D'] === 50 && bar['KDJ.J'] === 50)).toBe(true);
  });

  it('自定义 KDJ 参数产生与默认不同的 KDJ 序列', async () => {
    const rows = makeKlineRows(10);
    const repo = makeRepoMock(rows);
    const service = new KlinesService(repo as never);

    const custom = await service.recalcKlines('BTCUSDT', '1h', { n: 6, m1: 2, m2: 2 });
    const noRecalc = await service.recalcKlines('BTCUSDT', '1h');

    const customLast = (custom[custom.length - 1] as { 'KDJ.K': number; 'KDJ.D': number; 'KDJ.J': number });
    const defaultLast = (noRecalc[noRecalc.length - 1] as { 'KDJ.K': number; 'KDJ.D': number; 'KDJ.J': number });

    expect(customLast['KDJ.K']).not.toEqual(defaultLast['KDJ.K']);
    expect(customLast['KDJ.D']).not.toEqual(defaultLast['KDJ.D']);
    expect(customLast['KDJ.J']).not.toEqual(defaultLast['KDJ.J']);
  });

  it('自定义 KDJ 结果按 4 位小数取整，并与 calcKdjSeries 取整后一致', async () => {
    const rows = makeKlineRows(10);
    const repo = makeRepoMock(rows);
    const service = new KlinesService(repo as never);

    const kdjParams = { n: 6, m1: 2, m2: 2 };
    const out = await service.recalcKlines('BTCUSDT', '1h', kdjParams);

    const expected = calcKdjSeries(
      rows.map((r) => ({ high: parseFloat(r.high), low: parseFloat(r.low), close: parseFloat(r.close) })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    ).map(roundKdjPoint);

    // 锁定最后 3 根：数值精度到 4 位小数
    for (let offset = 3; offset >= 1; offset--) {
      const idx = out.length - offset;
      const bar = out[idx] as { 'KDJ.K': number; 'KDJ.D': number; 'KDJ.J': number };
      expect(bar['KDJ.K']).toBeCloseTo(expected[idx].k, 4);
      expect(bar['KDJ.D']).toBeCloseTo(expected[idx].d, 4);
      expect(bar['KDJ.J']).toBeCloseTo(expected[idx].j, 4);

      // 同时断言 toFixed(4) 后无更多小数位（防浮点尾差）
      expect(bar['KDJ.K']).toEqual(parseFloat(bar['KDJ.K'].toFixed(4)));
      expect(bar['KDJ.D']).toEqual(parseFloat(bar['KDJ.D'].toFixed(4)));
      expect(bar['KDJ.J']).toEqual(parseFloat(bar['KDJ.J'].toFixed(4)));
    }
  });

  it('自定义 KDJ 时其它指标列保持不变', async () => {
    const rows = makeKlineRows(10);
    const repo = makeRepoMock(rows);
    const service = new KlinesService(repo as never);

    const custom = await service.recalcKlines('BTCUSDT', '1h', { n: 6, m1: 2, m2: 2 });
    const noRecalc = await service.recalcKlines('BTCUSDT', '1h');

    const keysToCompare = [
      'open', 'high', 'low', 'close', 'volume', 'quote_volume', 'trades',
      'DIF', 'DEA', 'MACD', 'BBI', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240',
      '10_quote_volume', 'atr_14', 'loss_atr_14', 'low_9', 'high_9',
      'stop_loss_pct', 'risk_reward_ratio',
    ];

    for (let i = 0; i < rows.length; i++) {
      const c = custom[i] as Record<string, unknown>;
      const n = noRecalc[i] as Record<string, unknown>;
      for (const key of keysToCompare) {
        expect(c[key]).toEqual(n[key]);
      }
    }
  });

  it('返回字段形状与 getKlines 完全一致', async () => {
    const rows = makeKlineRows(5);
    const repo = makeRepoMock(rows);
    const service = new KlinesService(repo as never);

    const recalc = await service.recalcKlines('BTCUSDT', '1h', { n: 6, m1: 2, m2: 2 });
    const original = await service.getKlines('BTCUSDT', '1h');

    const recalcKeys = Object.keys(recalc[0] as object).sort();
    const originalKeys = Object.keys(original[0] as object).sort();

    expect(recalcKeys).toEqual(originalKeys);
  });
});
