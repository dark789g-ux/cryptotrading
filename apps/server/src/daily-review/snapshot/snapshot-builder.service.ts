import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';
import type { IndexQuote, SnapshotPayload } from '../types/daily-review.types';
import { OvernightMarketService } from './overnight/overnight-market.service';
import { MacroCalendarService } from './macro/macro-calendar.service';
import { ReviewHistoryService } from './history/review-history.service';

const INDEX_LIST = [
  { tsCode: '000001.SH', name: '上证指数' },
  { tsCode: '399001.SZ', name: '深证成指' },
  { tsCode: '399006.SZ', name: '创业板指' },
  { tsCode: '000688.SH', name: '科创50' },
] as const;

@Injectable()
export class SnapshotBuilderService {
  private readonly logger = new Logger(SnapshotBuilderService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly tushare: TushareClientService,
    private readonly overnight: OvernightMarketService,
    private readonly macro: MacroCalendarService,
    private readonly history: ReviewHistoryService,
  ) {}

  async validate(tradeDate: string) {
    const [{ count }] = await this.ds.query(
      `SELECT COUNT(*)::int AS count FROM raw.daily_quote WHERE trade_date = $1`,
      [tradeDate],
    );
    if (count === 0) {
      throw new UnprocessableEntityException(
        `${tradeDate} 的 A 股日线数据尚未同步，请先到「数据同步」补齐`,
      );
    }
  }

  async aggregateUpdown(tradeDate: string) {
    const [row] = await this.ds.query(
      `SELECT
         SUM(CASE WHEN pct_chg::numeric  >  0 THEN 1 ELSE 0 END) AS up,
         SUM(CASE WHEN pct_chg::numeric  <  0 THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN pct_chg::numeric  =  0 THEN 1 ELSE 0 END) AS flat,
         SUM(CASE
           WHEN (ts_code LIKE '300%' OR ts_code LIKE '688%') AND pct_chg::numeric >= 19.9 THEN 1
           WHEN ts_code NOT LIKE '300%' AND ts_code NOT LIKE '688%' AND pct_chg::numeric >= 9.9 THEN 1
           ELSE 0 END) AS limit_up,
         SUM(CASE
           WHEN (ts_code LIKE '300%' OR ts_code LIKE '688%') AND pct_chg::numeric <= -19.9 THEN 1
           WHEN ts_code NOT LIKE '300%' AND ts_code NOT LIKE '688%' AND pct_chg::numeric <= -9.9 THEN 1
           ELSE 0 END) AS limit_down
       FROM raw.daily_quote
       WHERE trade_date = $1`,
      [tradeDate],
    );
    return {
      updownDist: {
        up: +row.up, down: +row.down, flat: +row.flat,
        limitUp: +row.limit_up, limitDown: +row.limit_down,
      },
      // 炸板数当前无字段，填 0，prompt 中已注明
      limitStats: { upCount: +row.limit_up, downCount: +row.limit_down, brokenCount: 0 },
    };
  }

  async aggregateSectors(tradeDate: string) {
    const industry = await this.ds.query(
      `SELECT name, pct_change::numeric AS pct_chg
         FROM index_daily_quotes WHERE category = 'sw' AND trade_date = $1
         ORDER BY pct_change::numeric DESC LIMIT 10`,
      [tradeDate],
    );
    const concept = await this.ds.query(
      `SELECT name, pct_change::numeric AS pct_chg
         FROM index_daily_quotes WHERE category = 'concept' AND trade_date = $1
         ORDER BY pct_change::numeric DESC LIMIT 10`,
      [tradeDate],
    );
    const map = (r: any) => ({ name: r.name, pctChg: +r.pct_chg });
    return { industryRank: industry.map(map), conceptRank: concept.map(map) };
  }

  async aggregateMoneyFlow(tradeDate: string) {
    const [market] = await this.ds.query(
      `SELECT net_amount::numeric AS net_in
         FROM money_flow_market WHERE trade_date = $1`,
      [tradeDate],
    );
    const topIn = await this.ds.query(
      `SELECT ts_code, name, net_amount::numeric AS net_in
         FROM money_flow_stocks WHERE trade_date = $1
         ORDER BY net_amount::numeric DESC LIMIT 20`,
      [tradeDate],
    );
    const topOut = await this.ds.query(
      `SELECT ts_code, name, net_amount::numeric AS net_in
         FROM money_flow_stocks WHERE trade_date = $1
         ORDER BY net_amount::numeric ASC LIMIT 20`,
      [tradeDate],
    );
    if (!market) {
      this.logger.warn(`[moneyflow_market_empty] trade_date=${tradeDate}`);
    }
    // DB 中 net_amount 单位为「万元」，统一换算为「元」交给 LLM（prompt 已约定单位为元）
    const map = (r: any) => ({ tsCode: r.ts_code, name: r.name, netIn: +r.net_in * 10000 });
    return {
      market: { netIn: +(market?.net_in ?? 0) * 10000 },
      stocksTopIn: topIn.map(map),
      stocksTopOut: topOut.map(map),
    };
  }

  async aggregateStrongAndVolume(tradeDate: string) {
    // 强势股：JOIN a_share_symbols 过滤 ST，JOIN raw.daily_basic 取 turnover_rate
    const strong = await this.ds.query(
      `SELECT q.ts_code, s.name, q.pct_chg::numeric AS pct_chg,
              m.turnover_rate::numeric AS turnover_rate
         FROM raw.daily_quote q
         JOIN a_share_symbols s ON s.ts_code = q.ts_code
         LEFT JOIN raw.daily_basic m ON m.ts_code = q.ts_code AND m.trade_date = q.trade_date
         WHERE q.trade_date = $1
           AND s.name NOT ILIKE '%ST%'
         ORDER BY q.pct_chg::numeric DESC LIMIT 20`,
      [tradeDate],
    );
    // 成交额 TOP
    const vol = await this.ds.query(
      `SELECT q.ts_code, s.name, q.amount::numeric AS amount, q.pct_chg::numeric AS pct_chg
         FROM raw.daily_quote q
         JOIN a_share_symbols s ON s.ts_code = q.ts_code
         WHERE q.trade_date = $1
         ORDER BY q.amount::numeric DESC LIMIT 20`,
      [tradeDate],
    );
    return {
      strongStocks: strong.map((r: any) => ({
        tsCode: r.ts_code, name: r.name, pctChg: +r.pct_chg,
        turnoverRate: r.turnover_rate != null ? +r.turnover_rate : undefined,
      })),
      // raw.daily_quote.amount 单位为「千元」（Tushare daily.amount 原值），统一换算为「元」
      volumeTop: vol.map((r: any) => ({ tsCode: r.ts_code, name: r.name, amount: +r.amount * 1000, pctChg: +r.pct_chg })),
    };
  }

  async fetchIndices(tradeDate: string): Promise<IndexQuote[]> {
    const results = await Promise.all(INDEX_LIST.map(async (idx) => {
      const rows = await this.tushare.query('index_daily', {
        ts_code: idx.tsCode,
        trade_date: tradeDate,
      });
      const row = rows[0];
      if (!row) {
        this.logger.warn(`[index_daily_empty] ts_code=${idx.tsCode} trade_date=${tradeDate}`);
        return { tsCode: idx.tsCode, name: idx.name, close: 0, pctChg: 0, amount: 0 };
      }
      // Tushare index_daily.amount 单位为「千元」，统一换算为「元」
      return {
        tsCode: idx.tsCode, name: idx.name,
        close: +row.close, pctChg: +row.pct_chg, amount: +row.amount * 1000,
      };
    }));
    return results;
  }

  async buildSnapshot(tradeDate: string): Promise<SnapshotPayload> {
    await this.validate(tradeDate);
    // 三个新数据源（overnight / macroCalendar / previousReviewSummary）承诺内部 try/catch
    // 不抛异常，统一 Promise.all 并行触发；返回 null 时不影响主流程。
    const [indices, ud, sec, mf, sv, overnight, macroCalendar, previousReviewSummary] =
      await Promise.all([
        this.fetchIndices(tradeDate),
        this.aggregateUpdown(tradeDate),
        this.aggregateSectors(tradeDate),
        this.aggregateMoneyFlow(tradeDate),
        this.aggregateStrongAndVolume(tradeDate),
        this.overnight.fetch(tradeDate),
        this.macro.fetchToday(tradeDate),
        this.history.previousSummary(1),
      ]);
    this.logger.log(
      `[snapshot_built] tradeDate=${tradeDate} indices=${indices.length} ` +
        `strongStocks=${sv.strongStocks.length} overnight=${overnight ? 'yes' : 'no'} ` +
        `macro=${macroCalendar ? 'yes' : 'no'} history=${previousReviewSummary ? 'yes' : 'no'}`,
    );
    return {
      indices,
      ...ud,
      ...sec,
      moneyFlow: mf,
      ...sv,
      generatedAt: new Date().toISOString(),
      overnight,
      macroCalendar,
      previousReviewSummary,
    };
  }
}
