import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { ConfigService } from '../config/config.service';
import { Stock } from '../stocks/entities/stock.entity';
import { StockPrice } from '../stocks/entities/stock-price.entity';
import { IndicatorsService } from '../indicators/indicators.service';

@Injectable()
export class DataSyncService {
  private readonly logger = new Logger(DataSyncService.name);
  private readonly baseUrl = 'http://api.tushare.pro';

  constructor(
    private config: ConfigService,
    @InjectRepository(Stock)
    private stockRepo: Repository<Stock>,
    @InjectRepository(StockPrice)
    private priceRepo: Repository<StockPrice>,
    private indicatorsService: IndicatorsService,
  ) {}

  // 每天收盘后更新数据
  @Cron('0 30 15 * * 1-5') // 工作日 15:30
  async scheduledUpdate() {
    this.logger.log('开始定时更新数据...');
    await this.syncAllData();
    this.logger.log('数据更新完成');
  }

  async syncAllData() {
    // 1. 同步股票列表
    await this.syncStockList();
    
    // 2. 同步日线数据
    await this.syncDailyPrices();
    
    // 3. 计算技术指标
    await this.calculateAllIndicators();
  }

  private async requestTushare(apiName: string, params: any = {}) {
    const response = await axios.post(this.baseUrl, {
      api_name: apiName,
      token: this.config.tushareToken,
      params,
      fields: '',
    });

    if (response.data.code !== 0) {
      throw new Error(`Tushare API error: ${response.data.msg}`);
    }

    const { fields, items } = response.data.data;
    return items.map((item: any[]) => {
      const obj: any = {};
      fields.forEach((field: string, i: number) => {
        obj[field] = item[i];
      });
      return obj;
    });
  }

  async syncStockList() {
    this.logger.log('同步股票列表...');
    
    const stocks = await this.requestTushare('stock_basic', {
      exchange: '',
      list_status: 'L',
      fields: 'ts_code,symbol,name,area,industry,market,list_date',
    });

    const entities = stocks.map(s => {
      const stock = new Stock();
      stock.tsCode = s.ts_code;
      stock.symbol = s.symbol;
      stock.name = s.name;
      stock.area = s.area;
      stock.industry = s.industry;
      stock.market = s.market;
      stock.listDate = s.list_date;
      return stock;
    });

    await this.stockRepo.save(entities, { chunk: 100 });
    this.logger.log(`同步了 ${entities.length} 只股票`);
  }

  async syncDailyPrices() {
    this.logger.log('同步日线数据...');

    const stocks = await this.stockRepo.find();
    const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const startDate = this.getStartDate();

    // 分批处理，避免 API 限制
    const batchSize = 50;
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async stock => {
        try {
          // 检查已有数据
          const latestPrice = await this.priceRepo.findOne({
            where: { tsCode: stock.tsCode },
            order: { tradeDate: 'desc' },
          });

          const fetchStart = latestPrice 
            ? this.getNextDate(latestPrice.tradeDate)
            : startDate;

          if (fetchStart > endDate) return;

          const prices = await this.requestTushare('daily', {
            ts_code: stock.tsCode,
            start_date: fetchStart,
            end_date: endDate,
          });

          const entities = prices.map(p => {
            const price = new StockPrice();
            price.tsCode = p.ts_code;
            price.tradeDate = p.trade_date;
            price.open = p.open;
            price.high = p.high;
            price.low = p.low;
            price.close = p.close;
            price.vol = p.vol;
            price.amount = p.amount;
            price.pctChg = p.pct_chg;
            return price;
          });

          await this.priceRepo.save(entities);
        } catch (error) {
          this.logger.error(`同步 ${stock.tsCode} 失败: ${error.message}`);
        }
      }));

      // 避免请求过快
      await this.sleep(1000);
    }

    this.logger.log('日线数据同步完成');
  }

  async calculateAllIndicators() {
    this.logger.log('计算技术指标...');

    const stocks = await this.stockRepo.find();
    
    for (const stock of stocks) {
      try {
        // 获取最新价格日期
        const latestPrice = await this.priceRepo.findOne({
          where: { tsCode: stock.tsCode },
          order: { tradeDate: 'desc' },
        });

        const latestIndicator = await this.priceRepo.manager.findOne('Indicator', {
          where: { tsCode: stock.tsCode },
          order: { tradeDate: 'desc' },
        });

        const startDate = latestIndicator 
          ? latestIndicator.tradeDate
          : this.config.dataStartDate;

        if (latestPrice && startDate <= latestPrice.tradeDate) {
          await this.indicatorsService.calculateIndicators(
            stock.tsCode,
            startDate,
            latestPrice.tradeDate,
          );
        }
      } catch (error) {
        this.logger.error(`计算 ${stock.tsCode} 指标失败: ${error.message}`);
      }
    }

    this.logger.log('技术指标计算完成');
  }

  private getStartDate(): string {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 3); // 默认3年数据
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  private getNextDate(dateStr: string): string {
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);
    const date = new Date(`${year}-${month}-${day}`);
    date.setDate(date.getDate() + 1);
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
