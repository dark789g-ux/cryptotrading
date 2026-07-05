import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketSnapshot, OamvSnapshot, IndexSnapshot } from '../../market-condition-evaluator';
import { OamvRow, IdxQuoteRow, IdxIndicatorRow } from '../types/backtest-data.types';
import { toNum } from '../regime-backtest.helpers';

@Injectable()
export class MarketSnapshotLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async load(
    dateStart: string,
    dateEnd: string,
    marketIndex: string,
  ): Promise<Map<string, MarketSnapshot>> {
    const [oamvRows, idxQuoteRows, idxIndicatorRows] = await Promise.all([
      this.loadOamvRows(dateStart, dateEnd),
      this.loadIdxQuoteRows(dateStart, dateEnd, marketIndex),
      this.loadIdxIndicatorRows(dateStart, dateEnd, marketIndex),
    ]);

    const snapshots = new Map<string, MarketSnapshot>();
    for (const r of oamvRows) {
      snapshots.set(r.trade_date, {
        oamv: this.rowToOamv(r),
        idx: null,
      });
    }
    for (const r of idxQuoteRows) {
      const s = snapshots.get(r.trade_date);
      if (!s) continue;
      s.idx = s.idx ?? ({} as IndexSnapshot);
      s.idx.quote = this.rowToIdxQuote(r);
    }
    for (const r of idxIndicatorRows) {
      const s = snapshots.get(r.trade_date);
      if (!s) continue;
      s.idx = s.idx ?? ({} as IndexSnapshot);
      s.idx.indicator = this.rowToIdxIndicator(r);
    }
    return snapshots;
  }

  private async loadOamvRows(dateStart: string, dateEnd: string): Promise<OamvRow[]> {
    return this.dataSource.query<OamvRow[]>(
      `SELECT trade_date, open, high, low, close, amv_dif, amv_dea, amv_macd,
              ma5, ma30, ma60, ma120, ma240, kdj_k, kdj_d, kdj_j
         FROM oamv_daily
        WHERE trade_date >= $1 AND trade_date <= $2
        ORDER BY trade_date ASC`,
      [dateStart, dateEnd],
    );
  }

  private async loadIdxQuoteRows(
    dateStart: string,
    dateEnd: string,
    marketIndex: string,
  ): Promise<IdxQuoteRow[]> {
    return this.dataSource.query<IdxQuoteRow[]>(
      `SELECT trade_date, open, high, low, close, pre_close, change, pct_change, vol_hand, amount
         FROM index_daily_quotes
        WHERE trade_date >= $1 AND trade_date <= $2 AND ts_code = $3 AND category = 'market'`,
      [dateStart, dateEnd, marketIndex],
    );
  }

  private async loadIdxIndicatorRows(
    dateStart: string,
    dateEnd: string,
    marketIndex: string,
  ): Promise<IdxIndicatorRow[]> {
    return this.dataSource.query<IdxIndicatorRow[]>(
      `SELECT trade_date, ma5, ma30, ma60, ma120, ma240, dif, dea, macd,
              kdj_k, kdj_d, kdj_j, bbi, brick, brick_delta, brick_xg
         FROM index_daily_indicators
        WHERE trade_date >= $1 AND trade_date <= $2 AND ts_code = $3 AND category = 'market'`,
      [dateStart, dateEnd, marketIndex],
    );
  }

  private rowToOamv(r: OamvRow): OamvSnapshot {
    return {
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      amvDif: toNum(r.amv_dif),
      amvDea: toNum(r.amv_dea),
      amvMacd: toNum(r.amv_macd),
      ma5: toNum(r.ma5),
      ma30: toNum(r.ma30),
      ma60: toNum(r.ma60),
      ma120: toNum(r.ma120),
      ma240: toNum(r.ma240),
      kdjK: toNum(r.kdj_k),
      kdjD: toNum(r.kdj_d),
      kdjJ: toNum(r.kdj_j),
    };
  }

  private rowToIdxQuote(r: IdxQuoteRow): IndexSnapshot['quote'] {
    return {
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      preClose: toNum(r.pre_close),
      change: toNum(r.change),
      pctChange: toNum(r.pct_change),
      volHand: toNum(r.vol_hand),
      amount: toNum(r.amount),
    };
  }

  private rowToIdxIndicator(r: IdxIndicatorRow): IndexSnapshot['indicator'] {
    return {
      ma5: toNum(r.ma5),
      ma30: toNum(r.ma30),
      ma60: toNum(r.ma60),
      ma120: toNum(r.ma120),
      ma240: toNum(r.ma240),
      dif: toNum(r.dif),
      dea: toNum(r.dea),
      macd: toNum(r.macd),
      kdjK: toNum(r.kdj_k),
      kdjD: toNum(r.kdj_d),
      kdjJ: toNum(r.kdj_j),
      bbi: toNum(r.bbi),
      brick: toNum(r.brick),
      brickDelta: toNum(r.brick_delta),
      brickXg: r.brick_xg ?? null,
    };
  }
}
