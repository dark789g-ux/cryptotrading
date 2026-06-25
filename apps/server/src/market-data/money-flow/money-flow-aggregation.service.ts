import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';

export type AggregationProgress = {
  phase: string;
  current: number;
  total: number;
  percent: number;
  message: string;
};

export type AggregationResult = {
  success: boolean;
  phase: string;
  affectedRows: number;
  errors: string[];
};

@Injectable()
export class MoneyFlowAggregationService {
  private readonly logger = new Logger(MoneyFlowAggregationService.name);

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowThsIndustryEntity)
    private readonly thsIndustryRepo: Repository<MoneyFlowThsIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowIndexEntity)
    private readonly indexRepo: Repository<MoneyFlowIndexEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
    @InjectRepository(IndexWeightEntity)
    private readonly indexWeightRepo: Repository<IndexWeightEntity>,
  ) {}

  /**
   * 五维度聚合总入口。
   * 按日期范围分批，5 个维度 Promise.all 并行执行。
   */
  async aggregateAll(
    startDate: string,
    endDate: string,
    onProgress?: (p: AggregationProgress) => void,
  ): Promise<AggregationResult[]> {
    const phases = [
      { key: 'sw_industry', label: '申万三级行业聚合', fn: this.aggregateSwIndustry.bind(this) },
      { key: 'ths_industry', label: '同花顺行业聚合', fn: this.aggregateThsIndustry.bind(this) },
      { key: 'ths_sector', label: '同花顺概念/板块聚合', fn: this.aggregateThsSector.bind(this) },
      { key: 'index', label: '宽基指数 PIT 聚合', fn: this.aggregateIndex.bind(this) },
      { key: 'market', label: '全市场大盘聚合', fn: this.aggregateMarket.bind(this) },
    ] as const;

    const total = phases.length;

    phases.forEach((phase, i) => {
      onProgress?.({
        phase: phase.label,
        current: i,
        total,
        percent: Math.round((i / total) * 100),
        message: `开始 ${phase.label}`,
      });
    });

    const results = await Promise.all(
      phases.map(async (phase, i) => {
        const errors: string[] = [];
        let affectedRows = 0;
        try {
          affectedRows = await phase.fn(startDate, endDate);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(`[${phase.label}] 失败: ${msg}`, e instanceof Error ? e.stack : undefined);
          errors.push(msg);
        }

        onProgress?.({
          phase: phase.label,
          current: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 100),
          message: `${phase.label} 完成，影响 ${affectedRows} 行`,
        });

        return {
          success: errors.length === 0,
          phase: phase.key,
          affectedRows,
          errors,
        };
      }),
    );

    return results;
  }

  /**
   * 申万三级行业聚合
   * 从 money_flow_stocks 按 sw_industry_l3_code 汇总 net_amount
   */
  async aggregateSwIndustry(startDate: string, endDate: string): Promise<number> {
    const sql = `
      INSERT INTO money_flow_industries (ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT s.sw_industry_l3_code AS ts_code,
             m.trade_date,
             c.name AS industry,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN a_share_symbols s ON s.ts_code = m.ts_code
      JOIN sw_index_catalog c ON c.ts_code = s.sw_industry_l3_code AND c.level = 3
      WHERE m.trade_date BETWEEN $1 AND $2
        AND s.sw_industry_l3_code IS NOT NULL
      GROUP BY s.sw_industry_l3_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `;
    const result = await this.industryRepo.query(sql, [startDate, endDate]);
    return this.extractAffectedRows(result);
  }

  /**
   * 同花顺行业聚合
   * 从 money_flow_stocks 按 ths_index_catalog.type = 'I' 汇总 net_amount
   */
  async aggregateThsIndustry(startDate: string, endDate: string): Promise<number> {
    const sql = `
      INSERT INTO money_flow_ths_industries (ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT t.ts_code,
             m.trade_date,
             c.name,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN ths_member_stocks t ON t.con_code = m.ts_code
      JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'I'
      WHERE m.trade_date BETWEEN $1 AND $2
      GROUP BY t.ts_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `;
    const result = await this.thsIndustryRepo.query(sql, [startDate, endDate]);
    return this.extractAffectedRows(result);
  }

  /**
   * 同花顺概念/板块聚合
   * 从 money_flow_stocks 按 ths_index_catalog.type = 'N' 汇总 net_amount
   */
  async aggregateThsSector(startDate: string, endDate: string): Promise<number> {
    const sql = `
      INSERT INTO money_flow_sectors (ts_code, trade_date, name, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT t.ts_code,
             m.trade_date,
             c.name,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN ths_member_stocks t ON t.con_code = m.ts_code
      JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'N'
      WHERE m.trade_date BETWEEN $1 AND $2
      GROUP BY t.ts_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `;
    const result = await this.sectorRepo.query(sql, [startDate, endDate]);
    return this.extractAffectedRows(result);
  }

  /**
   * 宽基指数 PIT 聚合
   * 按 index_weight 版本链表（effective_date <= trade_date <= expire_date）加权汇总
   */
  async aggregateIndex(startDate: string, endDate: string): Promise<number> {
    const sql = `
      INSERT INTO money_flow_index (ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount)
      SELECT w.index_code AS ts_code,
             m.trade_date,
             SUM(m.net_amount),
             SUM(m.buy_lg_amount),
             SUM(m.buy_md_amount),
             SUM(m.buy_sm_amount)
      FROM money_flow_stocks m
      JOIN index_weight w ON w.con_code = m.ts_code
      WHERE m.trade_date BETWEEN $1 AND $2
        AND w.effective_date <= m.trade_date
        AND (w.expire_date IS NULL OR w.expire_date >= m.trade_date)
      GROUP BY w.index_code, m.trade_date
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        buy_lg_amount = EXCLUDED.buy_lg_amount,
        buy_md_amount = EXCLUDED.buy_md_amount,
        buy_sm_amount = EXCLUDED.buy_sm_amount,
        updated_at = NOW()
    `;
    const result = await this.indexRepo.query(sql, [startDate, endDate]);
    return this.extractAffectedRows(result);
  }

  /**
   * 全市场大盘聚合
   * 直接汇总 money_flow_stocks 所有个股
   */
  async aggregateMarket(startDate: string, endDate: string): Promise<number> {
    const sql = `
      INSERT INTO money_flow_market (trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount)
      SELECT trade_date,
             SUM(net_amount),
             SUM(buy_lg_amount),
             SUM(buy_md_amount),
             SUM(buy_sm_amount)
      FROM money_flow_stocks
      WHERE trade_date BETWEEN $1 AND $2
      GROUP BY trade_date
      ON CONFLICT (trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        buy_lg_amount = EXCLUDED.buy_lg_amount,
        buy_md_amount = EXCLUDED.buy_md_amount,
        buy_sm_amount = EXCLUDED.buy_sm_amount,
        updated_at = NOW()
    `;
    const result = await this.marketRepo.query(sql, [startDate, endDate]);
    return this.extractAffectedRows(result);
  }

  /**
   * 从 PostgreSQL 原生 query 结果中提取 affected rows。
   * typeorm 的 query() 对 INSERT 返回 [undefined, count] 或 { command: 'INSERT', rowCount: n } 等格式。
   */
  private extractAffectedRows(result: unknown): number {
    if (result == null) return 0;
    if (Array.isArray(result)) {
      // typeorm raw query 通常返回 [rows, count] 或 [ResultSet]
      const first = result[0];
      if (first && typeof first === 'object' && 'rowCount' in first) {
        return Number((first as { rowCount: unknown }).rowCount) || 0;
      }
      if (typeof first === 'number') return first;
      return 0;
    }
    if (typeof result === 'object' && result !== null) {
      if ('rowCount' in result) return Number((result as { rowCount: unknown }).rowCount) || 0;
      if ('affected' in result) return Number((result as { affected: unknown }).affected) || 0;
    }
    if (typeof result === 'number') return result;
    return 0;
  }
}
