import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WindowQuote } from '../../core/exit-simulator';
import { toNum } from '../regime-backtest.helpers';

interface QuoteRow {
  trade_date: string;
  qfq_open: string | null;
  qfq_high: string | null;
  qfq_low: string | null;
  qfq_close: string | null;
  open: string | null;
  high: string | null;
}

interface LimitRow {
  trade_date: string;
  up_limit: string | null;
  down_limit: string | null;
}

@Injectable()
export class QuoteLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async fetchQuotes(tsCode: string, dates: string[]): Promise<Map<string, WindowQuote>> {
    const rows = await this.dataSource.query<QuoteRow[]>(
      `SELECT trade_date, qfq_open, qfq_high, qfq_low, qfq_close, open, high
         FROM raw.daily_quote WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, WindowQuote>();
    for (const r of rows) {
      map.set(r.trade_date, {
        qfqOpen: toNum(r.qfq_open),
        qfqClose: toNum(r.qfq_close),
        open: toNum(r.open),
        qfqHigh: toNum(r.qfq_high),
        qfqLow: toNum(r.qfq_low),
        high: toNum(r.high),
      });
    }
    return map;
  }

  async fetchLimits(tsCode: string, dates: string[]): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<LimitRow[]>(
      `SELECT trade_date, up_limit FROM raw.stk_limit WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.up_limit));
    return map;
  }

  async fetchDownLimits(tsCode: string, dates: string[]): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<LimitRow[]>(
      `SELECT trade_date, down_limit FROM raw.stk_limit WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.down_limit));
    return map;
  }
}
