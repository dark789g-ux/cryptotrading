import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TushareClientService, type TushareRow } from '../../market-data/a-shares/services/tushare-client.service';
import type {
  OvernightCommodityQuote,
  OvernightIndexQuote,
  OvernightPayload,
  OvernightStockQuote,
} from './overnight.types';

interface IndexTickerDef {
  name: string;
  /** Tushare index_global 的 TS 指数代码（如 'DJI' / 'IXIC' / 'SPX'） */
  tsCode: string;
}

interface StockTickerDef {
  name: string;
  /** Tushare us_daily 的股票代码（如 'NVDA'） */
  ticker: string;
}

/**
 * Stage0 静态拉取美股 / 中概 / 大宗商品 隔夜行情，spec §4.3 / §7 / §12。
 * - 美股指数走 Tushare `index_global`（6000 积分，含 DJI / IXIC / SPX）
 * - 美股个股走 Tushare `us_daily`（120 积分）
 * - 大宗商品 Tushare 暂无现成接口，返回空数组并 warn `[overnight_commodity_unsupported]`
 * - 整体 try/catch：失败时返回 null，让 SnapshotBuilder 跳过
 * - 配置开关 DAILY_REVIEW_OVERNIGHT_ENABLED='false' 时直接返回 null
 *
 * 注意：禁用 `.catch(() => [])` 静默吞错（CLAUDE.md 硬约束）；
 * 任何一档 ticker 失败都要 logger.warn 含 apiName + 完整 params。
 */
@Injectable()
export class OvernightMarketService {
  private readonly logger = new Logger(OvernightMarketService.name);

  // spec §4.3 列出的三档美股指数。ts_code 已对照 Tushare index_global 文档落实。
  private readonly usIndices: IndexTickerDef[] = [
    { name: '道琼斯工业指数', tsCode: 'DJI' },
    { name: '纳斯达克指数', tsCode: 'IXIC' },
    { name: '标普500指数', tsCode: 'SPX' },
  ];

  // 芯片股
  private readonly chipStocks: StockTickerDef[] = [
    { name: '英伟达', ticker: 'NVDA' },
    { name: '美光科技', ticker: 'MU' },
    { name: '英特尔', ticker: 'INTC' },
  ];

  // 中概股
  private readonly chinaConcepts: StockTickerDef[] = [
    { name: '阿里巴巴', ticker: 'BABA' },
  ];

  constructor(
    private readonly tushare: TushareClientService,
    private readonly config: ConfigService,
  ) {}

  async fetch(tradeDate: string): Promise<OvernightPayload | null> {
    const enabled = this.config.get<string>('DAILY_REVIEW_OVERNIGHT_ENABLED');
    if (enabled === 'false') {
      this.logger.log(`[overnight_disabled] DAILY_REVIEW_OVERNIGHT_ENABLED=false，跳过隔夜行情拉取 tradeDate=${tradeDate}`);
      return null;
    }

    try {
      const [usIndices, chipStocks, chinaConcepts, commodities] = await Promise.all([
        this.fetchUsIndices(tradeDate),
        this.fetchUsStocks(tradeDate, this.chipStocks),
        this.fetchUsStocks(tradeDate, this.chinaConcepts),
        this.fetchCommodities(tradeDate),
      ]);

      return { usIndices, chipStocks, chinaConcepts, commodities };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[overnight_fetch_failed] tradeDate=${tradeDate} err=${message}`);
      return null;
    }
  }

  private async fetchUsIndices(tradeDate: string): Promise<OvernightIndexQuote[]> {
    const results: OvernightIndexQuote[] = [];
    for (const def of this.usIndices) {
      const params = { ts_code: def.tsCode, trade_date: tradeDate };
      try {
        const rows = await this.tushare.query('index_global', params);
        const row = this.pickLatestRow(rows, tradeDate);
        if (!row) {
          this.logger.warn(
            `[overnight_partial] index_global 返回空 apiName=index_global params=${JSON.stringify(params)} ` +
              `name=${def.name}（可能无权限或当日数据未发布，返回部分字段）`,
          );
          continue;
        }
        results.push({
          name: def.name,
          close: this.num(row.close),
          pctChg: this.num(row.pct_chg),
          quotedAt: this.formatQuotedAt(row.trade_date ?? tradeDate),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[overnight_partial] index_global 抛错 apiName=index_global params=${JSON.stringify(params)} ` +
            `name=${def.name} err=${message}`,
        );
      }
    }
    return results;
  }

  private async fetchUsStocks(
    tradeDate: string,
    defs: StockTickerDef[],
  ): Promise<OvernightStockQuote[]> {
    const results: OvernightStockQuote[] = [];
    for (const def of defs) {
      const params = { ts_code: def.ticker, trade_date: tradeDate };
      try {
        const rows = await this.tushare.query('us_daily', params);
        const row = this.pickLatestRow(rows, tradeDate);
        if (!row) {
          this.logger.warn(
            `[overnight_partial] us_daily 返回空 apiName=us_daily params=${JSON.stringify(params)} ` +
              `name=${def.name}（可能无权限或当日数据未发布，返回部分字段）`,
          );
          continue;
        }
        // Tushare us_daily 涨跌幅字段名为 pct_change（与 index_global 的 pct_chg 不同）
        const pctChg = this.num(row.pct_change ?? row.pct_chg);
        results.push({
          ticker: def.ticker,
          pctChg,
          note: def.name,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[overnight_partial] us_daily 抛错 apiName=us_daily params=${JSON.stringify(params)} ` +
            `name=${def.name} err=${message}`,
        );
      }
    }
    return results;
  }

  private async fetchCommodities(tradeDate: string): Promise<OvernightCommodityQuote[]> {
    // TODO: 需补外部数据源——Tushare 当前对 WTI 原油 / 黄金现货等大宗商品无直接现成日线接口
    this.logger.warn(
      `[overnight_commodity_unsupported] tradeDate=${tradeDate} 大宗商品（WTI 原油 / 黄金）暂无 Tushare 接口，返回空数组`,
    );
    return [];
  }

  /**
   * 在 Tushare 返回的多行中选最接近 tradeDate 的一行：
   * 优先精确匹配，匹配不到时取按 trade_date 降序的第一行（覆盖隔夜美股因时差只有前一交易日数据的情形）。
   */
  private pickLatestRow(rows: TushareRow[], tradeDate: string): TushareRow | null {
    if (!rows || rows.length === 0) return null;
    const exact = rows.find((r) => String(r.trade_date) === tradeDate);
    if (exact) return exact;
    return [...rows].sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)))[0];
  }

  private num(value: string | number | null | undefined): number {
    if (value == null) return 0;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 把 Tushare 的 trade_date 'YYYYMMDD' 转为 UTC 墙钟 ISO 字符串。
   * 这里仅作展示用途，按 UTC 当日 00:00:00 输出（CLAUDE.md 时间规范）。
   */
  private formatQuotedAt(tradeDate: string | number | null): string {
    const s = String(tradeDate ?? '');
    if (/^\d{8}$/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`;
    }
    return new Date().toISOString();
  }
}
