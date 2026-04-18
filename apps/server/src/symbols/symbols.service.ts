import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SymbolEntity } from '../entities/symbol.entity';
import { KlineEntity } from '../entities/kline.entity';

export interface QuerySymbolsDto {
  interval: string;
  page: number;
  page_size: number;
  sort: { field: string; asc: boolean };
  q?: string;
  conditions?: { field: string; op: string; value: number }[];
  fields?: string[];
}

// 指标列名映射（CSV 字段名 → 实体列名）
const INDICATOR_COLUMNS: Record<string, string> = {
  DIF: 'dif', DEA: 'dea', MACD: 'macd',
  'KDJ.K': 'kdj_k', 'KDJ.D': 'kdj_d', 'KDJ.J': 'kdj_j',
  BBI: 'bbi', MA5: 'ma5', MA30: 'ma30', MA60: 'ma60', MA120: 'ma120', MA240: 'ma240',
  '10_quote_volume': 'quote_volume_10', atr_14: 'atr_14', loss_atr_14: 'loss_atr_14',
  low_9: 'low_9', high_9: 'high_9', stop_loss_pct: 'stop_loss_pct',
  risk_reward_ratio: 'risk_reward_ratio',
};

const OP_MAP: Record<string, string> = {
  gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', neq: '!=',
};

@Injectable()
export class SymbolsService {
  constructor(
    @InjectRepository(SymbolEntity)
    private readonly symbolRepo: Repository<SymbolEntity>,
    @InjectRepository(KlineEntity)
    private readonly klineRepo: Repository<KlineEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /** 返回全部交易对名称（轻量接口，仅扫描 DB） */
  async getNames(interval: string): Promise<string[]> {
    const rows = await this.klineRepo
      .createQueryBuilder('k')
      .select('DISTINCT k.symbol', 'symbol')
      .where('k.interval = :interval', { interval })
      .orderBy('symbol')
      .getRawMany();
    return rows.map((r) => r.symbol);
  }

  /** 返回指定 interval 下所有 klines 的最早/最新 open_time */
  async getDateRange(interval: string): Promise<{ min: string | null; max: string | null }> {
    const row = await this.klineRepo
      .createQueryBuilder('k')
      .select('MIN(k.open_time)', 'min')
      .addSelect('MAX(k.open_time)', 'max')
      .where('k.interval = :interval', { interval })
      .getRawOne<{ min: Date | null; max: Date | null }>();
    return {
      min: row?.min ? new Date(row.min).toISOString() : null,
      max: row?.max ? new Date(row.max).toISOString() : null,
    };
  }

  /** 返回 klines 表指标列名（给前端动态渲染用） */
  getKlineColumns(): string[] {
    return Object.keys(INDICATOR_COLUMNS);
  }

  /** 分页查询标的（支持指标筛选、排序） */
  async querySymbols(dto: QuerySymbolsDto) {
    const {
      interval, page, page_size, sort, q = '',
      conditions = [],
    } = dto;

    // 前端 camelCase 字段名 → DB 列名
    const SORT_COL_MAP: Record<string, string> = {
      symbol: 'k.symbol',
      close: 'k.close',
      ma5: 'k.ma5',
      ma30: 'k.ma30',
      ma60: 'k.ma60',
      kdjJ: 'k.kdj_j',
      riskRewardRatio: 'k.risk_reward_ratio',
      stopLossPct: 'k.stop_loss_pct',
      openTime: 'k.open_time',
    };

    let sql = `
      WITH latest AS (
        SELECT symbol, MAX(open_time) AS max_time
        FROM klines
        WHERE interval = $1
        GROUP BY symbol
      )
      SELECT
        k.symbol,
        k.close,
        k.ma5,
        k.ma30,
        k.ma60,
        k.kdj_j AS "kdjJ",
        k.risk_reward_ratio AS "riskRewardRatio",
        k.stop_loss_pct AS "stopLossPct",
        k.open_time AS "openTime"
      FROM klines k
      JOIN latest ON k.symbol = latest.symbol AND k.open_time = latest.max_time AND k.interval = $1
      JOIN symbols s ON s.symbol = k.symbol
      WHERE s.is_excluded = false`;

    const params: any[] = [interval];
    let pi = 2;

    if (q) {
      sql += ` AND k.symbol ILIKE $${pi}`;
      params.push(`%${q}%`);
      pi++;
    }

    for (const cond of conditions.slice(0, 10)) {
      const col = INDICATOR_COLUMNS[cond.field];
      const op = OP_MAP[cond.op];
      if (!col || !op) continue;
      sql += ` AND k.${col} ${op} $${pi}`;
      params.push(cond.value);
      pi++;
    }

    // 计总数
    const countSql = `SELECT COUNT(*) FROM (${sql}) sub`;
    const countResult = await this.dataSource.query(countSql, params);
    const total = parseInt(countResult[0].count, 10);

    // 排序
    const sortCol = SORT_COL_MAP[sort.field] ?? 'k.symbol';
    sql += ` ORDER BY ${sortCol} ${sort.asc ? 'ASC' : 'DESC'} NULLS LAST`;

    // 分页
    const offset = (page - 1) * page_size;
    sql += ` LIMIT $${pi} OFFSET $${pi + 1}`;
    params.push(page_size, offset);

    const items = await this.dataSource.query(sql, params);

    return { items, total, page, page_size };
  }

  /** 更新 sync_enabled / is_excluded */
  async patchSymbol(symbol: string, patch: Partial<Pick<SymbolEntity, 'syncEnabled' | 'isExcluded'>>) {
    await this.symbolRepo.update({ symbol }, patch);
    return this.symbolRepo.findOne({ where: { symbol } });
  }

  /** 批量 upsert symbols（同步时使用） */
  async upsertSymbols(
    symbols: { symbol: string; baseAsset: string; quoteAsset: string }[],
    excludedSet: Set<string>,
  ) {
    for (const s of symbols) {
      await this.symbolRepo.upsert(
        {
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          isActive: true,
          isExcluded: excludedSet.has(s.symbol),
        },
        ['symbol'],
      );
    }
  }
}
