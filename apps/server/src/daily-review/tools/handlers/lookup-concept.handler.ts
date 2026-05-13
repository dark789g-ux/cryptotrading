import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowSectorEntity } from '../../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowIndustryEntity } from '../../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowStockEntity } from '../../../entities/money-flow/money-flow-stock.entity';
import { ThsMemberStockEntity } from '../../../entities/money-flow/ths-member-stock.entity';
import {
  ToolArgError,
  type ConceptConstituent,
  type LookupConceptResult,
  type ToolHandler,
} from '../tool-types';

/**
 * lookup_concept（spec § 5.1）
 *
 * 入参：conceptName: string（中文名，可能是概念或行业）
 * 出参：{ matchedName, todayPctChg, constituents: [{tsCode, name, pctChg, mainNetIn, isLeader}] }
 *
 * 实现策略：
 * - 概念优先（money_flow_sectors.name），未命中回退到行业（money_flow_industries.industry）
 * - 都未命中：返回空 constituents + matchedName=入参原值；不抛错（LLM 会改 query 重试）
 * - constituents 来源：ths_member_stocks join money_flow_stocks（同一交易日 = 概念最新交易日）
 *   - isLeader = 当天该概念内 mainNetIn 排名第 1
 * - 不在此处嵌入新闻检索（spec 明确）；LLM 需要催化信息时自行调 search_news
 */
@Injectable()
export class LookupConceptHandler implements ToolHandler {
  readonly name = 'lookup_concept';
  private readonly logger = new Logger(LookupConceptHandler.name);

  /** constituents 最多回传的成分股数（避免上下文过大） */
  private static readonly MAX_CONSTITUENTS = 30;

  constructor(
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
  ) {}

  async call(args: Record<string, unknown>): Promise<LookupConceptResult> {
    const conceptName = this.parseConceptName(args.conceptName);

    // 1) 概念优先：money_flow_sectors.name = conceptName，取最新 trade_date
    const sectorHit = await this.sectorRepo
      .createQueryBuilder('s')
      .where('s.name = :name', { name: conceptName })
      .orderBy('s.trade_date', 'DESC')
      .take(1)
      .getOne();

    if (sectorHit) {
      const constituents = await this.fetchConceptConstituents(sectorHit.tsCode);
      return {
        matchedName: sectorHit.sector,
        todayPctChg: this.safeNumber(sectorHit.pctChange),
        constituents,
      };
    }

    // 2) 行业兜底：money_flow_industries.industry = conceptName
    const industryHit = await this.industryRepo
      .createQueryBuilder('i')
      .where('i.industry = :name', { name: conceptName })
      .orderBy('i.trade_date', 'DESC')
      .take(1)
      .getOne();

    if (industryHit) {
      // 行业层面没有成分股映射（ths_member_stocks 是概念维度），constituents 留空但 matchedName + pctChg 返回
      this.logger.warn(
        `LookupConceptHandler conceptName=${JSON.stringify(conceptName)} 命中行业 industry=${industryHit.industry}，无成分股映射，constituents=[]`,
      );
      return {
        matchedName: industryHit.industry,
        todayPctChg: this.safeNumber(industryHit.pctChange),
        constituents: [],
      };
    }

    // 3) 全部未命中：合法降级，让 LLM 重试或改 query
    this.logger.warn(
      `LookupConceptHandler conceptName=${JSON.stringify(conceptName)} 在 money_flow_sectors / money_flow_industries 均未命中（合法空结果）。`,
    );
    return {
      matchedName: conceptName,
      todayPctChg: null,
      constituents: [],
    };
  }

  private parseConceptName(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ToolArgError('missing required arg: conceptName (string)');
    }
    return raw.trim();
  }

  /**
   * 拉成分股最新一日资金流：
   * 用裸 SQL join（ths_member_stocks.con_code = money_flow_stocks.ts_code）
   * 锁定该概念 ts_code 对应的成员，取最新 trade_date 的行。
   */
  private async fetchConceptConstituents(conceptTsCode: string): Promise<ConceptConstituent[]> {
    const rows: Array<{
      ts_code: string;
      name: string | null;
      pct_change: string | null;
      net_amount: string | null;
    }> = await this.stockRepo.query(
      `
      WITH latest AS (
        SELECT MAX(s.trade_date) AS trade_date
        FROM money_flow_stocks s
        INNER JOIN ths_member_stocks m ON m.con_code = s.ts_code
        WHERE m.ts_code = $1
      )
      SELECT s.ts_code, s.name, s.pct_change::text AS pct_change, s.net_amount::text AS net_amount
      FROM money_flow_stocks s
      INNER JOIN ths_member_stocks m ON m.con_code = s.ts_code
      INNER JOIN latest l ON l.trade_date = s.trade_date
      WHERE m.ts_code = $1
      ORDER BY s.net_amount DESC NULLS LAST
      LIMIT $2
      `,
      [conceptTsCode, LookupConceptHandler.MAX_CONSTITUENTS],
    );

    if (!rows.length) {
      this.logger.warn(
        `LookupConceptHandler conceptTsCode=${conceptTsCode} ths_member_stocks 或 money_flow_stocks 无对齐数据，constituents=[]`,
      );
      return [];
    }

    return rows.map((r, idx) => ({
      tsCode: String(r.ts_code),
      name: r.name ?? null,
      pctChg: this.safeNumber(r.pct_change),
      mainNetIn: this.safeNumber(r.net_amount),
      isLeader: idx === 0,
    }));
  }

  private safeNumber(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
