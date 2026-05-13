import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AShareSymbolEntity } from '../../../entities/a-share/a-share-symbol.entity';
import { MoneyFlowStockEntity } from '../../../entities/money-flow/money-flow-stock.entity';
import { ThsMemberStockEntity } from '../../../entities/money-flow/ths-member-stock.entity';
import {
  TushareClientService,
  type TushareRow,
} from '../../../market-data/a-shares/services/tushare-client.service';
import {
  ToolArgError,
  type LookupStockResult,
  type StockTopListEntry,
  type ToolHandler,
} from '../tool-types';

/**
 * lookup_stock（spec § 5.1）
 *
 * 入参：tsCode: string（如 "601138.SH"）
 * 出参：{ basic, recentFlow, concepts, topListEntries }
 *
 * 数据源：
 * - basic / concepts ← `a_share_symbols` + `ths_member_stocks`（个股 → 概念名）
 *   a_share_symbols 无 market_cap 列，basic.marketCap 暂置 null（保留字段，避免 LLM 误以为接口失败）
 * - recentFlow ← `money_flow_stocks`（按 trade_date DESC 近 20 行聚合 last5d/last20d 净流入；
 *   todayRank 用最近一日全市场净流入排名）
 * - topListEntries ← Tushare `top_list`（近 5 个 distinct trade_date，per-stock 过滤）
 *
 * 关键约束：
 * - A 股 trade_date 是 YYYYMMDD 字符串，禁 `new Date(trade_date)`（CLAUDE.md）
 * - DB 取出的 numeric 列在 TypeORM 中是字符串，需 safeNumber 转
 * - Tushare 返回空（含 data=null/items=[]）TushareClientService 内部已 warn；
 *   handler 不再额外 warn，直接降级为空数组
 */
@Injectable()
export class LookupStockHandler implements ToolHandler {
  readonly name = 'lookup_stock';
  private readonly logger = new Logger(LookupStockHandler.name);

  /** 近 N 个 trade_date 用作 recentFlow 聚合窗口 */
  private static readonly RECENT_FLOW_DAYS = 20;
  /** topListEntries 取该股近 N 个交易日的上榜记录 */
  private static readonly TOP_LIST_RECENT_DAYS = 5;

  constructor(
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectRepository(MoneyFlowStockEntity)
    private readonly moneyFlowStockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberStockRepo: Repository<ThsMemberStockEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  async call(args: Record<string, unknown>): Promise<LookupStockResult> {
    const tsCode = this.parseTsCode(args.tsCode);

    const [symbol, recentFlowRows, conceptRows] = await Promise.all([
      this.symbolRepo.findOne({ where: { tsCode } }),
      this.moneyFlowStockRepo
        .createQueryBuilder('m')
        .where('m.ts_code = :tsCode', { tsCode })
        .orderBy('m.trade_date', 'DESC')
        .take(LookupStockHandler.RECENT_FLOW_DAYS)
        .getMany(),
      // ths_member_stocks: con_code = 个股 ts_code → ts_code = 所属概念 ts_code
      // 二级 join 拿不到 con_name 的概念中文名，这里只回传 concept_ts_code，避免编造
      this.memberStockRepo
        .createQueryBuilder('mb')
        .where('mb.con_code = :tsCode', { tsCode })
        .getMany(),
    ]);

    const basic = {
      name: symbol?.name ?? tsCode,
      industry: symbol?.industry ?? null,
      area: symbol?.area ?? null,
      listDate: symbol?.listDate ?? null,
      // a_share_symbols 实体未携带市值列，保留字段但置 null
      marketCap: null as number | null,
    };

    const last5dNetIn = this.sumNet(recentFlowRows.slice(0, 5));
    const last20dNetIn = this.sumNet(recentFlowRows.slice(0, 20));
    const todayRank = await this.computeTodayRank(tsCode, recentFlowRows[0]?.tradeDate ?? null);

    const concepts = conceptRows
      .map((r) => r.tsCode)
      .filter((v, i, arr) => v && arr.indexOf(v) === i);

    const topListEntries = await this.fetchRecentTopList(tsCode);

    return {
      basic,
      recentFlow: { last5dNetIn, last20dNetIn, todayRank },
      concepts,
      topListEntries,
    };
  }

  private parseTsCode(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ToolArgError('missing required arg: tsCode (string, e.g. "601138.SH")');
    }
    return raw.trim();
  }

  private sumNet(rows: MoneyFlowStockEntity[]): number | null {
    if (!rows.length) return null;
    let sum = 0;
    let hasValue = false;
    for (const r of rows) {
      const v = this.safeNumber(r.netAmount);
      if (v !== null) {
        sum += v;
        hasValue = true;
      }
    }
    return hasValue ? sum : null;
  }

  /**
   * 当 tsCode 在 latestDate 当日资金流榜中的"主力净流入"排名（从 1 起）。
   * 用裸 SQL 跑 ROW_NUMBER 性能更稳；trade_date 用参数传入，避免 SQL 注入。
   */
  private async computeTodayRank(tsCode: string, latestDate: string | null): Promise<number | null> {
    if (!latestDate) return null;
    const rows: Array<{ rank: string | number }> = await this.moneyFlowStockRepo.query(
      `
      SELECT rank::int AS rank
      FROM (
        SELECT ts_code,
               ROW_NUMBER() OVER (ORDER BY net_amount DESC NULLS LAST) AS rank
        FROM money_flow_stocks
        WHERE trade_date = $1
      ) AS ranked
      WHERE ts_code = $2
      `,
      [latestDate, tsCode],
    );
    if (!rows.length) return null;
    const n = Number(rows[0].rank);
    return Number.isFinite(n) ? n : null;
  }

  private async fetchRecentTopList(tsCode: string): Promise<StockTopListEntry[]> {
    // Tushare top_list 必填 trade_date，不支持"近 N 日"直接查；
    // 这里以 money_flow_stocks 的最近 5 个 distinct trade_date 作为遍历集合（已是交易日）
    const dateRows: Array<{ trade_date: string }> = await this.moneyFlowStockRepo.query(
      `
      SELECT DISTINCT trade_date
      FROM money_flow_stocks
      ORDER BY trade_date DESC
      LIMIT $1
      `,
      [LookupStockHandler.TOP_LIST_RECENT_DAYS],
    );
    const dates = dateRows.map((r) => String(r.trade_date)).filter((d) => /^\d{8}$/.test(d));
    if (dates.length === 0) {
      this.logger.warn(
        `LookupStockHandler money_flow_stocks 无最近交易日（DB 空表？），跳过 top_list 查询。tsCode=${tsCode}`,
      );
      return [];
    }

    const all: StockTopListEntry[] = [];
    for (const tradeDate of dates) {
      const rows = await this.tushareClient.query('top_list', { trade_date: tradeDate, ts_code: tsCode });
      for (const row of rows) {
        all.push(this.mapTopListRow(row, tradeDate));
      }
    }
    return all;
  }

  private mapTopListRow(row: TushareRow, fallbackDate: string): StockTopListEntry {
    return {
      tradeDate: typeof row.trade_date === 'string' ? row.trade_date : fallbackDate,
      netAmount: this.safeNumber(row.net_amount),
      reason: typeof row.reason === 'string' ? row.reason : null,
    };
  }

  private safeNumber(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
