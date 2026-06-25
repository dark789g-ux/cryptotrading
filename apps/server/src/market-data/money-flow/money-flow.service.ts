import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';
import { QueryFlowDto, QueryCondition } from './dto/query-flow.dto';
import type {
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowLatestDates,
  MoneyFlowMemberRow,
  MoneyFlowIndexRow,
} from '@cryptotrading/shared-types';

/** 将金额字段从万元转换为亿元（÷10000），百分比字段保持不变 */
function toYi(row: Record<string, unknown>, amountKeys: string[]): Record<string, unknown> {
  for (const key of amountKeys) {
    const v = row[key];
    if (v != null && v !== '') row[key] = String(Number(v) / 10000);
  }
  return row;
}

const STOCK_AMOUNT_KEYS = ['netAmount', 'buyLgAmount', 'buyMdAmount', 'buySmAmount', 'netD5Amount'];
const INDUSTRY_AMOUNT_KEYS = ['netAmount', 'netBuyAmount', 'netSellAmount'];
const SECTOR_AMOUNT_KEYS = ['netAmount', 'netBuyAmount', 'netSellAmount'];
const MARKET_AMOUNT_KEYS = ['netAmount', 'buyLgAmount', 'buyMdAmount', 'buySmAmount'];

/** 行业资金流：前端字段名 → SQL 列（含表别名 `i`） */
const MONEY_FLOW_INDUSTRY_COL_MAP: Record<string, string> = {
  industry: 'i.industry',
  pct_change: 'i.pct_change',
  net_amount: 'i.net_amount',
  net_buy_amount: 'i.net_buy_amount',
  net_sell_amount: 'i.net_sell_amount',
};

/** 高级筛选操作符 → SQL 比较符 */
const OP_SQL_MAP: Record<string, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

@Injectable()
export class MoneyFlowService {
  private readonly logger = new Logger(MoneyFlowService.name);

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowThsIndustryEntity)
    private readonly thsIndustryRepo: Repository<MoneyFlowThsIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
    @InjectRepository(MoneyFlowIndexEntity)
    private readonly indexRepo: Repository<MoneyFlowIndexEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
  ) {}

  async queryStocks(dto: QueryFlowDto): Promise<MoneyFlowStockRow[]> {
    const qb = this.stockRepo.createQueryBuilder('s');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
    if (dto.limit) {
      qb.orderBy('s.trade_date', 'DESC').limit(Number(dto.limit));
    } else if (dto.ts_code) {
      qb.orderBy('s.trade_date', 'ASC');
    } else {
      qb.orderBy('s.net_amount', 'DESC');
    }
    return qb.getMany().then(rows => rows.map(r => toYi(r as unknown as Record<string, unknown>, STOCK_AMOUNT_KEYS) as unknown as MoneyFlowStockRow));
  }

  async queryIndustries(dto: QueryFlowDto): Promise<MoneyFlowIndustryRow[]> {
    const qb = this.industryRepo.createQueryBuilder('i');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    }

    // ---------- 服务端筛选 ----------
    if (dto.industry) {
      qb.andWhere('i.industry ILIKE :industryLike', { industryLike: `%${dto.industry}%` });
    }
    if (dto.pct_change_min != null) {
      qb.andWhere('i.pct_change >= :pctChangeMin', { pctChangeMin: dto.pct_change_min });
    }
    if (dto.pct_change_max != null) {
      qb.andWhere('i.pct_change <= :pctChangeMax', { pctChangeMax: dto.pct_change_max });
    }
    if (dto.net_amount_min != null) {
      qb.andWhere('i.net_amount >= :netAmountMin', { netAmountMin: dto.net_amount_min });
    }
    if (dto.net_buy_amount_min != null) {
      qb.andWhere('i.net_buy_amount >= :netBuyAmountMin', { netBuyAmountMin: dto.net_buy_amount_min });
    }
    if (dto.net_sell_amount_min != null) {
      qb.andWhere('i.net_sell_amount >= :netSellAmountMin', { netSellAmountMin: dto.net_sell_amount_min });
    }

    // ---------- 高级筛选 conditions ----------
    if (Array.isArray(dto.conditions) && dto.conditions.length > 0) {
      dto.conditions.forEach((cond: QueryCondition, idx: number) => {
        const col = MONEY_FLOW_INDUSTRY_COL_MAP[cond.field];
        if (!col) {
          this.logger.warn(`[queryIndustries] unknown condition field: ${cond.field}`);
          return;
        }
        const opSql = OP_SQL_MAP[cond.op];
        if (!opSql) {
          this.logger.warn(`[queryIndustries] unknown condition op: ${cond.op}`);
          return;
        }
        if (cond.valueType === 'field') {
          const compareCol = MONEY_FLOW_INDUSTRY_COL_MAP[cond.compareField];
          if (!compareCol) {
            this.logger.warn(`[queryIndustries] unknown condition compareField: ${cond.compareField}`);
            return;
          }
          qb.andWhere(`${col} ${opSql} ${compareCol}`);
        } else {
          const paramKey = `mfic${idx}`;
          qb.andWhere(`${col} ${opSql} :${paramKey}`, { [paramKey]: cond.value });
        }
      });
    }

    if (dto.limit) {
      qb.orderBy('i.trade_date', 'DESC').limit(Number(dto.limit));
    } else if (dto.ts_code) {
      qb.orderBy('i.trade_date', 'ASC');
    } else {
      qb.orderBy('i.net_amount', 'DESC');
    }
    return qb.getMany().then(rows => rows.map(r => toYi(r as unknown as Record<string, unknown>, INDUSTRY_AMOUNT_KEYS) as unknown as MoneyFlowIndustryRow));
  }

  async queryThsIndustries(dto: QueryFlowDto): Promise<MoneyFlowIndustryRow[]> {
    const qb = this.thsIndustryRepo.createQueryBuilder('i');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    }

    if (dto.industry) {
      qb.andWhere('i.industry ILIKE :industryLike', { industryLike: `%${dto.industry}%` });
    }
    if (dto.pct_change_min != null) {
      qb.andWhere('i.pct_change >= :pctChangeMin', { pctChangeMin: dto.pct_change_min });
    }
    if (dto.pct_change_max != null) {
      qb.andWhere('i.pct_change <= :pctChangeMax', { pctChangeMax: dto.pct_change_max });
    }
    if (dto.net_amount_min != null) {
      qb.andWhere('i.net_amount >= :netAmountMin', { netAmountMin: dto.net_amount_min });
    }
    if (dto.net_buy_amount_min != null) {
      qb.andWhere('i.net_buy_amount >= :netBuyAmountMin', { netBuyAmountMin: dto.net_buy_amount_min });
    }
    if (dto.net_sell_amount_min != null) {
      qb.andWhere('i.net_sell_amount >= :netSellAmountMin', { netSellAmountMin: dto.net_sell_amount_min });
    }

    if (Array.isArray(dto.conditions) && dto.conditions.length > 0) {
      dto.conditions.forEach((cond: QueryCondition, idx: number) => {
        const col = MONEY_FLOW_INDUSTRY_COL_MAP[cond.field];
        if (!col) {
          this.logger.warn(`[queryThsIndustries] unknown condition field: ${cond.field}`);
          return;
        }
        const opSql = OP_SQL_MAP[cond.op];
        if (!opSql) {
          this.logger.warn(`[queryThsIndustries] unknown condition op: ${cond.op}`);
          return;
        }
        if (cond.valueType === 'field') {
          const compareCol = MONEY_FLOW_INDUSTRY_COL_MAP[cond.compareField];
          if (!compareCol) {
            this.logger.warn(`[queryThsIndustries] unknown condition compareField: ${cond.compareField}`);
            return;
          }
          qb.andWhere(`${col} ${opSql} ${compareCol}`);
        } else {
          const paramKey = `mftic${idx}`;
          qb.andWhere(`${col} ${opSql} :${paramKey}`, { [paramKey]: cond.value });
        }
      });
    }

    if (dto.limit) {
      qb.orderBy('i.trade_date', 'DESC').limit(Number(dto.limit));
    } else if (dto.ts_code) {
      qb.orderBy('i.trade_date', 'ASC');
    } else {
      qb.orderBy('i.net_amount', 'DESC');
    }
    return qb.getMany().then(rows => rows.map(r => toYi(r as unknown as Record<string, unknown>, INDUSTRY_AMOUNT_KEYS) as unknown as MoneyFlowIndustryRow));
  }

  async querySectors(dto: QueryFlowDto): Promise<MoneyFlowSectorRow[]> {
    const qb = this.sectorRepo.createQueryBuilder('s');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
    if (dto.limit) {
      qb.orderBy('s.trade_date', 'DESC').limit(Number(dto.limit));
    } else if (dto.ts_code) {
      qb.orderBy('s.trade_date', 'ASC');
    } else {
      qb.orderBy('s.net_amount', 'DESC');
    }
    return qb.getMany().then(rows => rows.map(r => toYi(r as unknown as Record<string, unknown>, SECTOR_AMOUNT_KEYS) as unknown as MoneyFlowSectorRow));
  }

  async queryMarket(dto: QueryFlowDto): Promise<MoneyFlowMarketRow[]> {
    const qb = this.marketRepo.createQueryBuilder('m').orderBy('m.trade_date', 'ASC');
    if (dto.trade_date) {
      qb.where('m.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('m.trade_date >= :s AND m.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany().then(rows => rows.map(r => toYi(r as unknown as Record<string, unknown>, MARKET_AMOUNT_KEYS) as unknown as MoneyFlowMarketRow));
  }

  /** 个股维度的数据日期范围（min/max trade_date） */
  async getDateRange(): Promise<{ min: string | null; max: string | null }> {
    const result = await this.stockRepo
      .createQueryBuilder('s')
      .select('MIN(s.trade_date)', 'min')
      .addSelect('MAX(s.trade_date)', 'max')
      .getRawOne<{ min: string | null; max: string | null }>()
    return result ?? { min: null, max: null }
  }

  /** 各维度最新已同步的交易日 */
  async getLatestDates(): Promise<MoneyFlowLatestDates> {
    const [stock, industry, thsIndustry, sector, market, index] = await Promise.all([
      this.stockRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.industryRepo.createQueryBuilder('i').select('MAX(i.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.thsIndustryRepo.createQueryBuilder('t').select('MAX(t.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.sectorRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.marketRepo.createQueryBuilder('m').select('MAX(m.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.indexRepo.createQueryBuilder('i').select('MAX(i.trade_date)', 'max').getRawOne<{ max: string | null }>(),
    ]);
    return {
      stock: stock?.max ?? null,
      swIndustry: industry?.max ?? null,
      thsIndustry: thsIndustry?.max ?? null,
      sector: sector?.max ?? null,
      market: market?.max ?? null,
      index: index?.max ?? null,
    };
  }

  async queryIndices(dto: QueryFlowDto): Promise<MoneyFlowIndexRow[]> {
    const qb = this.indexRepo.createQueryBuilder('i')
      .leftJoin('ths_index_catalog', 'c', 'c.ts_code = i.ts_code')
      .addSelect('COALESCE(c.name, i.ts_code)', 'name');

    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    }
    if (dto.limit) {
      qb.orderBy('i.trade_date', 'DESC').limit(Number(dto.limit));
    } else if (dto.ts_code) {
      qb.orderBy('i.trade_date', 'ASC');
    } else {
      qb.orderBy('i.net_amount', 'DESC');
    }

    const rows = await qb.getRawMany<{
      i_id: string;
      i_ts_code: string;
      i_trade_date: string;
      name: string | null;
      i_net_amount: string | null;
      i_buy_lg_amount: string | null;
      i_buy_md_amount: string | null;
      i_buy_sm_amount: string | null;
    }>();

    const INDEX_AMOUNT_KEYS = ['netAmount', 'buyLgAmount', 'buyMdAmount', 'buySmAmount'];

    return rows.map((r) => {
      const raw: Record<string, unknown> = {
        id: r.i_id,
        tsCode: r.i_ts_code,
        tradeDate: r.i_trade_date,
        name: r.name,
        netAmount: r.i_net_amount,
        buyLgAmount: r.i_buy_lg_amount,
        buyMdAmount: r.i_buy_md_amount,
        buySmAmount: r.i_buy_sm_amount,
      };
      return toYi(raw, INDEX_AMOUNT_KEYS) as unknown as MoneyFlowIndexRow;
    });
  }

  async queryMembers(tsCode: string, tradeDate?: string): Promise<MoneyFlowMemberRow[]> {
    const qb = this.memberRepo
      .createQueryBuilder('m')
      .select('m.id', 'id')
      .addSelect('m.ts_code', 'tsCode')
      .addSelect('m.con_code', 'conCode')
      .addSelect('m.con_name', 'conName')
      .addSelect('m.is_new', 'isNew')
      .where('m.ts_code = :tsCode', { tsCode });

    if (tradeDate) {
      qb.leftJoin(
        'money_flow_stocks',
        'mfs',
        'mfs.ts_code = m.con_code AND mfs.trade_date = :tradeDate',
        { tradeDate },
      )
        .addSelect('mfs.pct_change', 'pctChange')
        .addSelect('mfs.net_amount', 'netAmount');
    }

    qb.orderBy('m.con_code', 'ASC');

    const rows = await qb.getRawMany<{
      tsCode: string;
      conCode: string;
      conName: string | null;
      isNew: string | null;
      pctChange?: string | null;
      netAmount?: string | null;
    }>();

    return rows.map<MoneyFlowMemberRow>((r) => {
      const pctRaw = tradeDate ? r.pctChange : null;
      const netRaw = tradeDate ? r.netAmount : null;
      const pctChange =
        pctRaw == null || pctRaw === '' ? null : Number(pctRaw);
      // net_amount 单位为"万元"，÷10000 转为"亿元"
      const netAmount =
        netRaw == null || netRaw === '' ? null : Number(netRaw) / 10000;
      return {
        tsCode: r.tsCode,
        conCode: r.conCode,
        conName: r.conName,
        isNew: r.isNew,
        pctChange: pctChange != null && Number.isFinite(pctChange) ? pctChange : null,
        netAmount: netAmount != null && Number.isFinite(netAmount) ? netAmount : null,
      };
    });
  }
}
