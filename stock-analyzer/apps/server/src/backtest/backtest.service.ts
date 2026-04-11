import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { StockPrice } from '../stocks/entities/stock-price.entity';
import { Indicator } from '../stocks/entities/indicator.entity';
import { RunBacktestDto } from './dto/run-backtest.dto';

interface Trade {
  date: string;
  type: 'buy' | 'sell';
  price: number;
  shares: number;
  amount: number;
  reason: string;
}

interface BacktestResult {
  summary: {
    initialCapital: number;
    finalCapital: number;
    totalReturn: number;
    annualizedReturn: number;
    maxDrawdown: number;
    winRate: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
  };
  trades: Trade[];
  dailyValues: { date: string; value: number }[];
}

@Injectable()
export class BacktestService {
  constructor(
    @InjectRepository(StockPrice)
    private priceRepo: Repository<StockPrice>,
    @InjectRepository(Indicator)
    private indicatorRepo: Repository<Indicator>,
  ) {}

  async runBacktest(dto: RunBacktestDto): Promise<BacktestResult> {
    const { tsCode, startDate, endDate, initialCapital, strategy, params } = dto;

    // 获取数据
    const prices = await this.priceRepo.find({
      where: { tsCode, tradeDate: Between(startDate, endDate) },
      order: { tradeDate: 'asc' },
    });

    const indicators = await this.indicatorRepo.find({
      where: { tsCode, tradeDate: Between(startDate, endDate) },
      order: { tradeDate: 'asc' },
    });

    if (prices.length === 0) {
      throw new Error('No price data found');
    }

    // 执行策略
    switch (strategy) {
      case 'ma_cross':
        return this.runMACrossStrategy(
          prices,
          indicators,
          initialCapital,
          params?.maShort || 5,
          params?.maLong || 20,
        );
      default:
        throw new Error('Unknown strategy');
    }
  }

  private runMACrossStrategy(
    prices: StockPrice[],
    indicators: Indicator[],
    initialCapital: number,
    maShort: number,
    maLong: number,
  ): BacktestResult {
    const trades: Trade[] = [];
    const dailyValues: { date: string; value: number }[] = [];

    let cash = initialCapital;
    let shares = 0;
    let position = false;
    let maxValue = initialCapital;
    let maxDrawdown = 0;

    const maShortField = `ma${maShort}` as keyof Indicator;
    const maLongField = `ma${maLong}` as keyof Indicator;

    for (let i = 1; i < prices.length; i++) {
      const price = prices[i];
      const prevIndicator = indicators[i - 1];
      const currIndicator = indicators[i];

      if (!prevIndicator || !currIndicator) continue;

      const prevShort = Number(prevIndicator[maShortField]) || 0;
      const prevLong = Number(prevIndicator[maLongField]) || 0;
      const currShort = Number(currIndicator[maShortField]) || 0;
      const currLong = Number(currIndicator[maLongField]) || 0;

      // 金叉买入
      if (!position && prevShort <= prevLong && currShort > currLong) {
        const buyPrice = Number(price.open);
        const buyShares = Math.floor(cash / buyPrice / 100) * 100; // 整手

        if (buyShares > 0) {
          const amount = buyShares * buyPrice;
          cash -= amount;
          shares = buyShares;
          position = true;

          trades.push({
            date: price.tradeDate,
            type: 'buy',
            price: buyPrice,
            shares: buyShares,
            amount,
            reason: `MA${maShort}上穿MA${maLong}`,
          });
        }
      }

      // 死叉卖出
      else if (position && prevShort >= prevLong && currShort < currLong) {
        const sellPrice = Number(price.open);
        const amount = shares * sellPrice;
        cash += amount;

        trades.push({
          date: price.tradeDate,
          type: 'sell',
          price: sellPrice,
          shares,
          amount,
          reason: `MA${maShort}下穿MA${maLong}`,
        });

        shares = 0;
        position = false;
      }

      // 计算当日市值
      const currentValue = cash + shares * Number(price.close);
      dailyValues.push({ date: price.tradeDate, value: currentValue });

      // 更新最大回撤
      if (currentValue > maxValue) {
        maxValue = currentValue;
      }
      const drawdown = (maxValue - currentValue) / maxValue;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // 最后一天清仓
    const lastPrice = prices[prices.length - 1];
    if (position && shares > 0) {
      const sellPrice = Number(lastPrice.close);
      const amount = shares * sellPrice;
      cash += amount;

      trades.push({
        date: lastPrice.tradeDate,
        type: 'sell',
        price: sellPrice,
        shares,
        amount,
        reason: '回测结束清仓',
      });
    }

    const finalCapital = cash;
    const totalReturn = (finalCapital - initialCapital) / initialCapital;

    // 计算年化收益
    const days = prices.length;
    const years = days / 252;
    const annualizedReturn = Math.pow(1 + totalReturn, 1 / years) - 1;

    // 计算胜率
    const sellTrades = trades.filter(t => t.type === 'sell');
    let winningTrades = 0;
    for (let i = 1; i < trades.length; i += 2) {
      const buy = trades[i - 1];
      const sell = trades[i];
      if (sell.price > buy.price) winningTrades++;
    }

    return {
      summary: {
        initialCapital,
        finalCapital,
        totalReturn: Number((totalReturn * 100).toFixed(2)),
        annualizedReturn: Number((annualizedReturn * 100).toFixed(2)),
        maxDrawdown: Number((maxDrawdown * 100).toFixed(2)),
        winRate: sellTrades.length > 0
          ? Number(((winningTrades / sellTrades.length) * 100).toFixed(2))
          : 0,
        totalTrades: trades.length,
        winningTrades,
        losingTrades: sellTrades.length - winningTrades,
      },
      trades,
      dailyValues,
    };
  }
}
