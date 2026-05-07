import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { QueryFlowDto } from './dto/query-flow.dto';

@Injectable()
export class MoneyFlowService {
  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
  ) {}

  async queryStocks(dto: QueryFlowDto) {
    const qb = this.stockRepo.createQueryBuilder('s').orderBy('s.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
    return qb.getMany();
  }

  async queryIndustries(dto: QueryFlowDto) {
    const qb = this.industryRepo.createQueryBuilder('i').orderBy('i.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  async querySectors(dto: QueryFlowDto) {
    const qb = this.sectorRepo.createQueryBuilder('s').orderBy('s.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  async queryMarket(dto: QueryFlowDto) {
    const qb = this.marketRepo.createQueryBuilder('m').orderBy('m.trade_date', 'ASC');
    if (dto.trade_date) {
      qb.where('m.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('m.trade_date >= :s AND m.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  /** 各维度最新已同步的交易日 */
  async getLatestDates() {
    const [stock, industry, sector, market] = await Promise.all([
      this.stockRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.industryRepo.createQueryBuilder('i').select('MAX(i.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.sectorRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.marketRepo.createQueryBuilder('m').select('MAX(m.trade_date)', 'max').getRawOne<{ max: string | null }>(),
    ]);
    return {
      stock: stock?.max ?? null,
      industry: industry?.max ?? null,
      sector: sector?.max ?? null,
      market: market?.max ?? null,
    };
  }
}
