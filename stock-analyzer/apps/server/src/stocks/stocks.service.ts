import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, MoreThan, LessThan, Between, Raw } from 'typeorm';
import { Stock } from './entities/stock.entity';
import { StockPrice } from './entities/stock-price.entity';
import { Indicator } from './entities/indicator.entity';
import { SearchStockDto } from './dto/search-stock.dto';
import { AdvancedFilterDto } from './dto/advanced-filter.dto';

@Injectable()
export class StocksService {
  constructor(
    @InjectRepository(Stock)
    private stockRepo: Repository<Stock>,
    @InjectRepository(StockPrice)
    private priceRepo: Repository<StockPrice>,
    @InjectRepository(Indicator)
    private indicatorRepo: Repository<Indicator>,
  ) {}

  async findAll(query: SearchStockDto) {
    const { keyword, industry, market, page = '1', limit = '50', sortBy, sortOrder } = query;
    
    const where: any = {};
    
    if (industry) where.industry = industry;
    if (market) where.market = market;
    
    const order: any = {};
    if (sortBy) {
      order[sortBy] = sortOrder || 'asc';
    } else {
      order.tsCode = 'asc';
    }

    const [data, total] = await this.stockRepo.findAndCount({
      where,
      order,
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    });

    return { data, total, page: parseInt(page), limit: parseInt(limit) };
  }

  async search(keyword: string) {
    if (!keyword) return [];
    
    return this.stockRepo.find({
      where: [
        { tsCode: Like(`%${keyword}%`) },
        { symbol: Like(`%${keyword}%`) },
        { name: Like(`%${keyword}%`) },
      ],
      take: 20,
    });
  }

  async findOne(tsCode: string) {
    return this.stockRepo.findOne({
      where: { tsCode },
      relations: ['prices', 'indicators'],
    });
  }

  async getPrices(
    tsCode: string,
    startDate: string,
    endDate: string,
    period: 'day' | 'week' | 'month',
  ) {
    if (period === 'day') {
      return this.priceRepo.find({
        where: {
          tsCode,
          tradeDate: Between(startDate, endDate),
        },
        order: { tradeDate: 'asc' },
      });
    }

    // 周线/月线聚合
    const prices = await this.priceRepo.find({
      where: {
        tsCode,
        tradeDate: Between(startDate, endDate),
      },
      order: { tradeDate: 'asc' },
    });

    return this.aggregatePrices(prices, period);
  }

  private aggregatePrices(prices: StockPrice[], period: 'week' | 'month') {
    if (prices.length === 0) return [];

    const grouped = new Map<string, StockPrice[]>();
    
    for (const price of prices) {
      const date = new Date(price.tradeDate);
      let key: string;
      
      if (period === 'week') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
      }
      
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(price);
    }

    return Array.from(grouped.entries()).map(([date, group]) => ({
      tsCode: group[0].tsCode,
      tradeDate: date,
      open: group[0].open,
      high: Math.max(...group.map(p => Number(p.high))),
      low: Math.min(...group.map(p => Number(p.low))),
      close: group[group.length - 1].close,
      vol: group.reduce((sum, p) => sum + Number(p.vol), 0),
      amount: group.reduce((sum, p) => sum + Number(p.amount), 0),
    }));
  }

  async getIndicators(tsCode: string, startDate: string, endDate: string) {
    return this.indicatorRepo.find({
      where: {
        tsCode,
        tradeDate: Between(startDate, endDate),
      },
      order: { tradeDate: 'asc' },
    });
  }

  async advancedFilter(filter: AdvancedFilterDto) {
    // 获取最新交易日
    const latestIndicator = await this.indicatorRepo.findOne({
      order: { tradeDate: 'desc' },
    });
    
    const tradeDate = filter.tradeDate || latestIndicator?.tradeDate;
    
    if (!tradeDate) return [];

    let query = this.indicatorRepo.createQueryBuilder('i')
      .where('i.tradeDate = :tradeDate', { tradeDate })
      .innerJoinAndSelect('i.stock', 'stock');

    // 根据指标条件过滤
    if (filter.indicator === 'ma' && filter.maShort && filter.maLong && filter.maCondition) {
      const shortField = `ma${filter.maShort}`;
      const longField = `ma${filter.maLong}`;
      
      switch (filter.maCondition) {
        case 'cross_up':
          // 需要前一天数据判断金叉，简化处理
          query = query.andWhere(`i.${shortField} > i.${longField}`);
          break;
        case 'cross_down':
          query = query.andWhere(`i.${shortField} < i.${longField}`);
          break;
        case 'above':
          query = query.andWhere(`i.${shortField} > i.${longField}`);
          break;
        case 'below':
          query = query.andWhere(`i.${shortField} < i.${longField}`);
          break;
      }
    }

    if (filter.indicator === 'macd' && filter.macdCondition) {
      switch (filter.macdCondition) {
        case 'golden_cross':
          query = query.andWhere('i.macdDif > i.macdDea').andWhere('i.macdBar > 0');
          break;
        case 'death_cross':
          query = query.andWhere('i.macdDif < i.macdDea').andWhere('i.macdBar < 0');
          break;
        case 'above_zero':
          query = query.andWhere('i.macdDif > 0');
          break;
        case 'below_zero':
          query = query.andWhere('i.macdDif < 0');
          break;
      }
    }

    if (filter.indicator === 'kdj' && filter.kdjCondition) {
      switch (filter.kdjCondition) {
        case 'golden_cross':
          query = query.andWhere('i.kdjK > i.kdjD');
          break;
        case 'death_cross':
          query = query.andWhere('i.kdjK < i.kdjD');
          break;
        case 'overbought':
          query = query.andWhere('i.kdjK > 80');
          break;
        case 'oversold':
          query = query.andWhere('i.kdjK < 20');
          break;
      }
    }

    if (filter.indicator === 'rsi' && filter.rsiPeriod && filter.rsiCompare && filter.rsiValue) {
      const rsiField = `rsi${filter.rsiPeriod}`;
      const value = parseFloat(filter.rsiValue);
      
      if (filter.rsiCompare === 'above') {
        query = query.andWhere(`i.${rsiField} > :value`, { value });
      } else {
        query = query.andWhere(`i.${rsiField} < :value`, { value });
      }
    }

    if (filter.indicator === 'boll' && filter.bollCondition) {
      switch (filter.bollCondition) {
        case 'touch_upper':
          // 简化处理，实际需要价格数据
          query = query.andWhere('i.bollUpper IS NOT NULL');
          break;
        case 'touch_lower':
          query = query.andWhere('i.bollLower IS NOT NULL');
          break;
        case 'squeeze':
          query = query.andWhere('(i.bollUpper - i.bollLower) / i.bollMid < 0.1');
          break;
      }
    }

    return query.getMany();
  }
}
