import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../../entities/money-flow/money-flow-stock.entity';
import {
  TushareClientService,
  type TushareRow,
} from '../../../market-data/a-shares/services/tushare-client.service';
import {
  ToolArgError,
  type FetchTopListResult,
  type TopListEntry,
  type ToolHandler,
} from '../tool-types';

/**
 * fetch_top_list（spec § 5.1）
 *
 * mode='daily'     必填 tradeDate → 当日完整榜，调 Tushare top_list(trade_date)
 * mode='recent5d'  必填 tsCode    → 近 5 个交易日上榜历史，逐日调 top_list(trade_date, ts_code)
 *
 * Tushare 官方契约（文档已查）：
 *   接口名 top_list  必填 trade_date  可选 ts_code  积分 ≥2000
 *   字段：trade_date, ts_code, name, close, pct_change, turnover_rate, amount,
 *         l_sell, l_buy, l_amount, net_amount, net_rate, amount_rate, float_values, reason
 *
 * 注意：
 * - tradeDate 必须是 YYYYMMDD 字符串；禁止 `new Date(tradeDate)` 解析（CLAUDE.md A 股日期规范）
 * - "近 5 个交易日"用 money_flow_stocks 的 distinct trade_date 作为交易日集合
 * - 空返回（Tushare 数据未发布 / 该股当日未上榜）TushareClientService 已 warn，本 handler 不重复
 */
@Injectable()
export class FetchTopListHandler implements ToolHandler {
  readonly name = 'fetch_top_list';
  private readonly logger = new Logger(FetchTopListHandler.name);

  private static readonly RECENT_DAYS = 5;
  private static readonly TRADE_DATE_RE = /^\d{8}$/;

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly moneyFlowStockRepo: Repository<MoneyFlowStockEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  async call(args: Record<string, unknown>): Promise<FetchTopListResult> {
    const mode = this.parseMode(args.mode);

    if (mode === 'daily') {
      const tradeDate = this.parseTradeDate(args.tradeDate);
      const rows = await this.tushareClient.query('top_list', { trade_date: tradeDate });
      return {
        mode: 'daily',
        tradeDate,
        entries: rows.map((r) => this.mapRow(r, tradeDate)),
      };
    }

    // mode === 'recent5d'
    const tsCode = this.parseTsCode(args.tsCode);
    const dates = await this.fetchRecentTradeDates();
    if (dates.length === 0) {
      this.logger.warn(
        `FetchTopListHandler money_flow_stocks 无最近交易日（DB 空表？），recent5d 跳过。tsCode=${tsCode}`,
      );
      return { mode: 'recent5d', tsCode, entries: [], appearCount: 0 };
    }

    const entries: TopListEntry[] = [];
    const appearDates = new Set<string>();
    for (const tradeDate of dates) {
      const rows = await this.tushareClient.query('top_list', { trade_date: tradeDate, ts_code: tsCode });
      for (const row of rows) {
        const entry = this.mapRow(row, tradeDate);
        entries.push(entry);
        appearDates.add(entry.tradeDate);
      }
    }
    return { mode: 'recent5d', tsCode, entries, appearCount: appearDates.size };
  }

  private parseMode(raw: unknown): 'daily' | 'recent5d' {
    if (raw === 'daily' || raw === 'recent5d') return raw;
    throw new ToolArgError("missing required arg: mode ('daily' | 'recent5d')");
  }

  private parseTradeDate(raw: unknown): string {
    if (typeof raw !== 'string' || !FetchTopListHandler.TRADE_DATE_RE.test(raw)) {
      throw new ToolArgError(
        'missing required arg: tradeDate (string, format YYYYMMDD, e.g. "20260513")',
      );
    }
    return raw;
  }

  private parseTsCode(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ToolArgError('missing required arg: tsCode (string, e.g. "601138.SH")');
    }
    return raw.trim();
  }

  private async fetchRecentTradeDates(): Promise<string[]> {
    const rows: Array<{ trade_date: string }> = await this.moneyFlowStockRepo.query(
      `
      SELECT DISTINCT trade_date
      FROM money_flow_stocks
      ORDER BY trade_date DESC
      LIMIT $1
      `,
      [FetchTopListHandler.RECENT_DAYS],
    );
    return rows.map((r) => String(r.trade_date)).filter((d) => FetchTopListHandler.TRADE_DATE_RE.test(d));
  }

  private mapRow(row: TushareRow, fallbackDate: string): TopListEntry {
    return {
      tradeDate: typeof row.trade_date === 'string' ? row.trade_date : fallbackDate,
      tsCode: typeof row.ts_code === 'string' ? row.ts_code : '',
      name: typeof row.name === 'string' ? row.name : null,
      close: this.safeNumber(row.close),
      pctChange: this.safeNumber(row.pct_change),
      turnoverRate: this.safeNumber(row.turnover_rate),
      amount: this.safeNumber(row.amount),
      lBuy: this.safeNumber(row.l_buy),
      lSell: this.safeNumber(row.l_sell),
      lAmount: this.safeNumber(row.l_amount),
      netAmount: this.safeNumber(row.net_amount),
      netRate: this.safeNumber(row.net_rate),
      amountRate: this.safeNumber(row.amount_rate),
      floatValues: this.safeNumber(row.float_values),
      reason: typeof row.reason === 'string' ? row.reason : null,
    };
  }

  private safeNumber(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
