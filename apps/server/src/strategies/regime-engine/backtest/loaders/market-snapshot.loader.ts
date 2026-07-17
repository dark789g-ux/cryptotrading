import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AShareBasicSnapshot,
  AShareIndicatorSnapshot,
  AShareQuoteSnapshot,
  IndexIndicatorSnapshot,
  IndexQuoteSnapshot,
  IndexTargetSnapshot,
  MarketSnapshot,
  StockTargetSnapshot,
  TargetSnapshot,
} from '../../market-condition-evaluator';
import {
  RegimeConfigMap,
  collectMatchTargets,
} from '../../../../entities/strategy/regime-strategy-config.entity';
import { ASHARE_FIELD_COL_MAP } from '../../../../strategy-conditions/strategy-conditions.types';
import { isSingleWildcardQuadrant } from '../../regime.classifier';
import { toNum } from '../regime-backtest.helpers';

type DbValue = string | number | null;

interface IndexQuoteRow {
  trade_date: string;
  ts_code: string;
  open: DbValue;
  high: DbValue;
  low: DbValue;
  close: DbValue;
  pre_close: DbValue;
  change: DbValue;
  pct_change: DbValue;
  vol_hand: DbValue;
  amount: DbValue;
}

interface IndexIndicatorRow {
  trade_date: string;
  ts_code: string;
  ma5: DbValue;
  ma30: DbValue;
  ma60: DbValue;
  ma120: DbValue;
  ma240: DbValue;
  dif: DbValue;
  dea: DbValue;
  macd: DbValue;
  kdj_k: DbValue;
  kdj_d: DbValue;
  kdj_j: DbValue;
  bbi: DbValue;
  brick: DbValue;
  brick_delta: DbValue;
  brick_xg: boolean | null;
}

interface StockQuoteRow {
  trade_date: string;
  ts_code: string;
  open: DbValue;
  high: DbValue;
  low: DbValue;
  close: DbValue;
  volume: DbValue;
  amount: DbValue;
  pct_chg: DbValue;
}

interface StockIndicatorRow {
  trade_date: string;
  ts_code: string;
  macd_dif: DbValue;
  macd_dea: DbValue;
  macd_hist: DbValue;
  kdj_k: DbValue;
  kdj_d: DbValue;
  kdj_j: DbValue;
  bbi: DbValue;
  ma5: DbValue;
  ma30: DbValue;
  ma60: DbValue;
  ma120: DbValue;
  ma240: DbValue;
  atr14: DbValue;
  profit_loss_ratio: DbValue;
  roc10: DbValue;
  roc20: DbValue;
  roc60: DbValue;
  brick: DbValue;
  brick_delta: DbValue;
  brick_xg: boolean | null;
}

interface StockBasicRow {
  trade_date: string;
  ts_code: string;
  turnover_rate: DbValue;
  volume_ratio: DbValue;
  pe: DbValue;
  pe_ttm: DbValue;
  pb: DbValue;
  total_mv: DbValue;
  circ_mv: DbValue;
}

interface TargetSet {
  index: string[];
  stock: string[];
}

@Injectable()
export class MarketSnapshotLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async load(
    regimeConfig: RegimeConfigMap,
    calendar: string[],
    globalCalendar: string[],
  ): Promise<Map<string, MarketSnapshot>> {
    if (calendar.length === 0) {
      return new Map();
    }

    // 单象限空 match（通配）：不区分大盘环境，每日均填入最小 snapshot
    if (isSingleWildcardQuadrant(regimeConfig.quadrants)) {
      const wildcard = new Map<string, MarketSnapshot>();
      for (const date of calendar) {
        wildcard.set(date, { date, targets: new Map() });
      }
      return wildcard;
    }

    const targets = this.extractTargets(regimeConfig.quadrants);
    if (targets.index.length === 0 && targets.stock.length === 0) {
      return new Map();
    }

    const dateStart = calendar[0];
    const dateEnd = calendar[calendar.length - 1];
    const startIdx = globalCalendar.indexOf(dateStart);
    const prevCalendarDate = startIdx > 0 ? globalCalendar[startIdx - 1] : null;
    const loadStart = prevCalendarDate ?? dateStart;

    const [indexQuotes, indexIndicators, stockQuotes, stockIndicators, stockBasics] = await Promise.all([
      targets.index.length > 0
        ? this.loadIndexQuotes(targets.index, loadStart, dateEnd)
        : Promise.resolve<IndexQuoteRow[]>([]),
      targets.index.length > 0
        ? this.loadIndexIndicators(targets.index, loadStart, dateEnd)
        : Promise.resolve<IndexIndicatorRow[]>([]),
      targets.stock.length > 0
        ? this.loadStockQuotes(targets.stock, loadStart, dateEnd)
        : Promise.resolve<StockQuoteRow[]>([]),
      targets.stock.length > 0
        ? this.loadStockIndicators(targets.stock, loadStart, dateEnd)
        : Promise.resolve<StockIndicatorRow[]>([]),
      targets.stock.length > 0
        ? this.loadStockBasics(targets.stock, loadStart, dateEnd)
        : Promise.resolve<StockBasicRow[]>([]),
    ]);

    const indexParts = new Map<string, Map<string, Partial<IndexTargetSnapshot>>>();
    const stockParts = new Map<string, Map<string, Partial<StockTargetSnapshot>>>();

    for (const r of indexQuotes) {
      const dateMap = this.ensureMap(indexParts, r.trade_date);
      dateMap.set(r.ts_code, { ...dateMap.get(r.ts_code), quote: this.rowToIndexQuote(r) });
    }
    for (const r of indexIndicators) {
      const dateMap = this.ensureMap(indexParts, r.trade_date);
      dateMap.set(r.ts_code, { ...dateMap.get(r.ts_code), indicator: this.rowToIndexIndicator(r) });
    }
    for (const r of stockQuotes) {
      const dateMap = this.ensureMap(stockParts, r.trade_date);
      dateMap.set(r.ts_code, { ...dateMap.get(r.ts_code), quote: this.rowToStockQuote(r) });
    }
    for (const r of stockIndicators) {
      const dateMap = this.ensureMap(stockParts, r.trade_date);
      dateMap.set(r.ts_code, { ...dateMap.get(r.ts_code), indicator: this.rowToStockIndicator(r) });
    }
    for (const r of stockBasics) {
      const dateMap = this.ensureMap(stockParts, r.trade_date);
      dateMap.set(r.ts_code, { ...dateMap.get(r.ts_code), basic: this.rowToStockBasic(r) });
    }

    const allDateTargets = new Map<string, Map<string, TargetSnapshot>>();
    for (const date of new Set([...indexParts.keys(), ...stockParts.keys()])) {
      const targets = this.buildTargetsForDate(date, indexParts, stockParts);
      if (targets) {
        allDateTargets.set(date, targets);
      }
    }

    const result = new Map<string, MarketSnapshot>();
    for (const date of calendar) {
      const targets = allDateTargets.get(date);
      if (!targets) {
        continue;
      }
      const dateIdx = globalCalendar.indexOf(date);
      const prevDate = dateIdx > 0 ? globalCalendar[dateIdx - 1] : undefined;
      result.set(date, {
        date,
        targets,
        ...(prevDate ? { prevDate, prevTargets: allDateTargets.get(prevDate) } : {}),
      });
    }

    return result;
  }

  private buildTargetsForDate(
    date: string,
    indexParts: Map<string, Map<string, Partial<IndexTargetSnapshot>>>,
    stockParts: Map<string, Map<string, Partial<StockTargetSnapshot>>>,
  ): Map<string, TargetSnapshot> | undefined {
    const targets = new Map<string, TargetSnapshot>();

    const idxMap = indexParts.get(date);
    if (idxMap) {
      for (const [tsCode, parts] of idxMap) {
        targets.set(tsCode, {
          quote: parts.quote ?? emptyIndexQuote(),
          indicator: parts.indicator ?? emptyIndexIndicator(),
        });
      }
    }

    const stockMap = stockParts.get(date);
    if (stockMap) {
      for (const [tsCode, parts] of stockMap) {
        targets.set(tsCode, {
          quote: parts.quote ?? emptyStockQuote(),
          indicator: parts.indicator ?? emptyStockIndicator(),
          basic: parts.basic ?? emptyStockBasic(),
        });
      }
    }

    return targets.size > 0 ? targets : undefined;
  }

  private extractTargets(quadrants: RegimeConfigMap['quadrants']): TargetSet {
    const index = new Set<string>();
    const stock = new Set<string>();
    for (const q of quadrants ?? []) {
      const collected = collectMatchTargets(q.match ?? []);
      for (const t of collected.index) index.add(t);
      for (const t of collected.stock) stock.add(t);
    }
    return {
      index: Array.from(index),
      stock: Array.from(stock),
    };
  }

  private ensureMap<K, L, V>(map: Map<K, Map<L, V>>, key: K): Map<L, V> {
    if (!map.has(key)) {
      map.set(key, new Map<L, V>());
    }
    return map.get(key)!;
  }

  private loadIndexQuotes(targets: string[], start: string, end: string): Promise<IndexQuoteRow[]> {
    return this.dataSource.query<IndexQuoteRow[]>(
      `SELECT trade_date, ts_code,
              open, high, low, close, pre_close, change, pct_change, vol_hand, amount
         FROM index_daily_quotes
        WHERE ts_code = ANY($1) AND trade_date >= $2 AND trade_date <= $3`,
      [targets, start, end],
    );
  }

  private loadIndexIndicators(targets: string[], start: string, end: string): Promise<IndexIndicatorRow[]> {
    return this.dataSource.query<IndexIndicatorRow[]>(
      `SELECT trade_date, ts_code,
              ma5, ma30, ma60, ma120, ma240,
              dif, dea, macd,
              kdj_k, kdj_d, kdj_j,
              bbi, brick, brick_delta, brick_xg
         FROM index_daily_indicators
        WHERE ts_code = ANY($1) AND trade_date >= $2 AND trade_date <= $3`,
      [targets, start, end],
    );
  }

  private loadStockQuotes(targets: string[], start: string, end: string): Promise<StockQuoteRow[]> {
    const cols = this.buildStockQuoteSelect();
    return this.dataSource.query<StockQuoteRow[]>(
      `SELECT trade_date, ts_code, ${cols}
         FROM raw.daily_quote
        WHERE ts_code = ANY($1) AND trade_date >= $2 AND trade_date <= $3`,
      [targets, start, end],
    );
  }

  private loadStockIndicators(targets: string[], start: string, end: string): Promise<StockIndicatorRow[]> {
    const cols = this.buildStockIndicatorSelect();
    return this.dataSource.query<StockIndicatorRow[]>(
      `SELECT trade_date, ts_code, ${cols}
         FROM raw.daily_indicator
        WHERE ts_code = ANY($1) AND trade_date >= $2 AND trade_date <= $3`,
      [targets, start, end],
    );
  }

  private loadStockBasics(targets: string[], start: string, end: string): Promise<StockBasicRow[]> {
    const cols = this.buildStockBasicSelect();
    return this.dataSource.query<StockBasicRow[]>(
      `SELECT trade_date, ts_code, ${cols}
         FROM raw.daily_basic
        WHERE ts_code = ANY($1) AND trade_date >= $2 AND trade_date <= $3`,
      [targets, start, end],
    );
  }

  private buildStockQuoteSelect(): string {
    return Object.entries(ASHARE_FIELD_COL_MAP)
      .filter(([_, expr]) => expr.startsWith('q.'))
      .map(([field, expr]) => `${expr.slice(2)} AS "${field}"`)
      .join(', ');
  }

  private buildStockIndicatorSelect(): string {
    return Object.entries(ASHARE_FIELD_COL_MAP)
      .filter(([_, expr]) => expr.startsWith('i.'))
      .map(([field, expr]) => `${expr.slice(2)} AS "${field}"`)
      .join(', ');
  }

  private buildStockBasicSelect(): string {
    return Object.entries(ASHARE_FIELD_COL_MAP)
      .filter(([_, expr]) => expr.startsWith('m.'))
      .map(([field, expr]) => `${expr.slice(2)} AS "${field}"`)
      .join(', ');
  }

  private rowToIndexQuote(r: IndexQuoteRow): IndexQuoteSnapshot {
    return {
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      pre_close: toNum(r.pre_close),
      change: toNum(r.change),
      pct_change: toNum(r.pct_change),
      vol_hand: toNum(r.vol_hand),
      amount: toNum(r.amount),
    };
  }

  private rowToIndexIndicator(r: IndexIndicatorRow): IndexIndicatorSnapshot {
    return {
      ma5: toNum(r.ma5),
      ma30: toNum(r.ma30),
      ma60: toNum(r.ma60),
      ma120: toNum(r.ma120),
      ma240: toNum(r.ma240),
      dif: toNum(r.dif),
      dea: toNum(r.dea),
      macd: toNum(r.macd),
      kdj_k: toNum(r.kdj_k),
      kdj_d: toNum(r.kdj_d),
      kdj_j: toNum(r.kdj_j),
      bbi: toNum(r.bbi),
      brick: toNum(r.brick),
      brick_delta: toNum(r.brick_delta),
      brick_xg: r.brick_xg ?? null,
    };
  }

  private rowToStockQuote(r: StockQuoteRow): AShareQuoteSnapshot {
    return {
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      volume: toNum(r.volume),
      amount: toNum(r.amount),
      pct_chg: toNum(r.pct_chg),
    };
  }

  private rowToStockIndicator(r: StockIndicatorRow): AShareIndicatorSnapshot {
    return {
      macd_dif: toNum(r.macd_dif),
      macd_dea: toNum(r.macd_dea),
      macd_hist: toNum(r.macd_hist),
      kdj_j: toNum(r.kdj_j),
      kdj_k: toNum(r.kdj_k),
      kdj_d: toNum(r.kdj_d),
      bbi: toNum(r.bbi),
      ma5: toNum(r.ma5),
      ma30: toNum(r.ma30),
      ma60: toNum(r.ma60),
      ma120: toNum(r.ma120),
      ma240: toNum(r.ma240),
      atr14: toNum(r.atr14),
      profit_loss_ratio: toNum(r.profit_loss_ratio),
      roc10: toNum(r.roc10),
      roc20: toNum(r.roc20),
      roc60: toNum(r.roc60),
      brick: toNum(r.brick),
      brick_delta: toNum(r.brick_delta),
      brick_xg: r.brick_xg ?? null,
      amv_dif: null,
      amv_dea: null,
      amv_macd: null,
      pos_120: null,
      pos_60: null,
      close_ma60_ratio: null,
      vol_ratio_60: null,
      vol_ratio_120: null,
    };
  }

  private rowToStockBasic(r: StockBasicRow): AShareBasicSnapshot {
    return {
      turnover_rate: toNum(r.turnover_rate),
      volume_ratio: toNum(r.volume_ratio),
      pe: toNum(r.pe),
      pe_ttm: toNum(r.pe_ttm),
      pb: toNum(r.pb),
      total_mv: toNum(r.total_mv),
      circ_mv: toNum(r.circ_mv),
    };
  }
}

function emptyIndexQuote(): IndexQuoteSnapshot {
  return {
    open: null,
    high: null,
    low: null,
    close: null,
    pre_close: null,
    change: null,
    pct_change: null,
    vol_hand: null,
    amount: null,
  };
}

function emptyIndexIndicator(): IndexIndicatorSnapshot {
  return {
    ma5: null,
    ma30: null,
    ma60: null,
    ma120: null,
    ma240: null,
    dif: null,
    dea: null,
    macd: null,
    kdj_k: null,
    kdj_d: null,
    kdj_j: null,
    bbi: null,
    brick: null,
    brick_delta: null,
    brick_xg: null,
  };
}

function emptyStockQuote(): AShareQuoteSnapshot {
  return {
    open: null,
    high: null,
    low: null,
    close: null,
    volume: null,
    amount: null,
    pct_chg: null,
  };
}

function emptyStockIndicator(): AShareIndicatorSnapshot {
  return {
    macd_dif: null,
    macd_dea: null,
    macd_hist: null,
    kdj_j: null,
    kdj_k: null,
    kdj_d: null,
    bbi: null,
    ma5: null,
    ma30: null,
    ma60: null,
    ma120: null,
    ma240: null,
    atr14: null,
    profit_loss_ratio: null,
    roc10: null,
    roc20: null,
    roc60: null,
    brick: null,
    brick_delta: null,
    brick_xg: null,
    amv_dif: null,
    amv_dea: null,
    amv_macd: null,
    pos_120: null,
    pos_60: null,
    close_ma60_ratio: null,
    vol_ratio_60: null,
    vol_ratio_120: null,
  };
}

function emptyStockBasic(): AShareBasicSnapshot {
  return {
    turnover_rate: null,
    volume_ratio: null,
    pe: null,
    pe_ttm: null,
    pb: null,
    total_mv: null,
    circ_mv: null,
  };
}
