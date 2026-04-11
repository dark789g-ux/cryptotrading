import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Indicator } from '../stocks/entities/indicator.entity';
import { StockPrice } from '../stocks/entities/stock-price.entity';

@Injectable()
export class IndicatorsService {
  constructor(
    @InjectRepository(Indicator)
    private indicatorRepo: Repository<Indicator>,
    @InjectRepository(StockPrice)
    private priceRepo: Repository<StockPrice>,
  ) {}

  async calculateIndicators(tsCode: string, startDate: string, endDate: string) {
    // 获取价格数据
    const prices = await this.priceRepo.find({
      where: { tsCode, tradeDate: Between(startDate, endDate) },
      order: { tradeDate: 'asc' },
    });

    if (prices.length < 60) return; // 数据不足

    const indicators: Indicator[] = [];

    for (let i = 0; i < prices.length; i++) {
      const price = prices[i];
      const closes = prices.slice(0, i + 1).map(p => Number(p.close));
      const highs = prices.slice(0, i + 1).map(p => Number(p.high));
      const lows = prices.slice(0, i + 1).map(p => Number(p.low));

      const indicator = new Indicator();
      indicator.tsCode = tsCode;
      indicator.tradeDate = price.tradeDate;

      // MA
      indicator.ma5 = this.sma(closes, 5);
      indicator.ma10 = this.sma(closes, 10);
      indicator.ma20 = this.sma(closes, 20);
      indicator.ma60 = this.sma(closes, 60);

      // MACD
      const macd = this.calculateMACD(closes);
      indicator.macdDif = macd.dif;
      indicator.macdDea = macd.dea;
      indicator.macdBar = macd.bar;

      // KDJ
      const kdj = this.calculateKDJ(highs, lows, closes);
      indicator.kdjK = kdj.k;
      indicator.kdjD = kdj.d;
      indicator.kdjJ = kdj.j;

      // RSI
      indicator.rsi6 = this.calculateRSI(closes, 6);
      indicator.rsi12 = this.calculateRSI(closes, 12);
      indicator.rsi24 = this.calculateRSI(closes, 24);

      // BOLL
      const boll = this.calculateBOLL(closes);
      indicator.bollUpper = boll.upper;
      indicator.bollMid = boll.mid;
      indicator.bollLower = boll.lower;

      indicators.push(indicator);
    }

    // 批量保存
    await this.indicatorRepo.save(indicators, { chunk: 100 });
  }

  // 简单移动平均
  private sma(data: number[], period: number): number {
    if (data.length < period) return null;
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // MACD
  private calculateMACD(closes: number[]) {
    if (closes.length < 26) return { dif: null, dea: null, bar: null };

    const ema12 = this.ema(closes, 12);
    const ema26 = this.ema(closes, 26);
    const dif = ema12 - ema26;
    
    // DEA 是 DIF 的 9 日 EMA
    const difs = closes.map((_, i) => {
      if (i < 26) return 0;
      const e12 = this.ema(closes.slice(0, i + 1), 12);
      const e26 = this.ema(closes.slice(0, i + 1), 26);
      return e12 - e26;
    }).slice(26);

    const dea = this.ema(difs, 9);
    const bar = (dif - dea) * 2;

    return { dif, dea, bar };
  }

  private ema(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  // KDJ
  private calculateKDJ(highs: number[], lows: number[], closes: number[]) {
    if (closes.length < 9) return { k: null, d: null, j: null };

    const period = 9;
    const rsvs: number[] = [];

    for (let i = period - 1; i < closes.length; i++) {
      const high9 = Math.max(...highs.slice(i - period + 1, i + 1));
      const low9 = Math.min(...lows.slice(i - period + 1, i + 1));
      const close = closes[i];
      const rsv = ((close - low9) / (high9 - low9)) * 100;
      rsvs.push(rsv);
    }

    let k = 50, d = 50;
    for (const rsv of rsvs) {
      k = (2 / 3) * k + (1 / 3) * rsv;
      d = (2 / 3) * d + (1 / 3) * k;
    }

    const j = 3 * k - 2 * d;
    return { k, d, j };
  }

  // RSI
  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  // 布林带
  private calculateBOLL(closes: number[]) {
    if (closes.length < 20) return { upper: null, mid: null, lower: null };

    const period = 20;
    const mid = this.sma(closes, period);
    const slice = closes.slice(-period);
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - mid, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: mid + 2 * stdDev,
      mid,
      lower: mid - 2 * stdDev,
    };
  }
}

// 辅助函数
function Between(start: string, end: string) {
  return Between(start, end);
}
