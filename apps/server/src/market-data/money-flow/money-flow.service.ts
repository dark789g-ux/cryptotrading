import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { QueryFlowDto } from './dto/query-flow.dto';
import type {
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowLatestDates,
} from '@cryptotrading/shared-types';

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

  async queryStocks(dto: QueryFlowDto): Promise<MoneyFlowStockRow[]> {
    const qb = this.stockRepo.createQueryBuilder('s');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.orderBy('s.trade_date', 'ASC');
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    } else {
      qb.orderBy('s.net_amount', 'DESC');
    }
    return qb.getMany();
  }

  async queryIndustries(dto: QueryFlowDto): Promise<MoneyFlowIndustryRow[]> {
    const qb = this.industryRepo.createQueryBuilder('i');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.orderBy('i.trade_date', 'ASC');
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    } else {
      qb.orderBy('i.net_amount', 'DESC');
    }
    return qb.getMany();
  }

  async querySectors(dto: QueryFlowDto): Promise<MoneyFlowSectorRow[]> {
    const qb = this.sectorRepo.createQueryBuilder('s');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.orderBy('s.trade_date', 'ASC');
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    } else {
      qb.orderBy('s.net_amount', 'DESC');
    }
    return qb.getMany();
  }

  async queryMarket(dto: QueryFlowDto): Promise<MoneyFlowMarketRow[]> {
    const qb = this.marketRepo.createQueryBuilder('m').orderBy('m.trade_date', 'ASC');
    if (dto.trade_date) {
      qb.where('m.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('m.trade_date >= :s AND m.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  /** 各维度最新已同步的交易日 */
  async getLatestDates(): Promise<MoneyFlowLatestDates> {
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
