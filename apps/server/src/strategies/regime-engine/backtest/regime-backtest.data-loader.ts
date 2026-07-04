import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RegimeConfigMap, RegimeConfigEntry } from '../../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionsQueryBuilder } from '../../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../../strategy-conditions/strategy-conditions.enumerator';
import { classifyRegime } from '../regime.classifier';
import { ExitConfig, SimulationInput, WindowQuote, buildHoldingDays, findLastIndexLE } from '../core/exit-simulator';
import { RegimeOamvBar, RegimeBacktestCapital, RegimeBacktestSignal, RegimeBacktestInput } from './regime-backtest.types';
import { toNum, attachMa5, collectRecentLows, MA5_PREHEAT_TRADING_DAYS } from './regime-backtest.helpers';

interface RawSignal {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  regime: string;
  entry: RegimeConfigEntry;
}

@Injectable()
export class RegimeBacktestDataLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  async load(params: {
    regimeConfig: RegimeConfigMap;
    capital: RegimeBacktestCapital;
    dateStart: string;
    dateEnd: string;
  }): Promise<RegimeBacktestInput> {
    const { regimeConfig, capital, dateStart, dateEnd } = params;

    const [globalCalendar, calendar] = await Promise.all([
      this.loadSseCalendar(null, null),
      this.loadSseCalendar(dateStart, dateEnd),
    ]);

    const oamvDaily = await this.loadOamvDaily(dateStart, dateEnd);
    const signals = await this.enumerateSignals(calendar, globalCalendar, oamvDaily, regimeConfig, dateEnd);

    const signalsByDate = await this.buildWindows(signals, globalCalendar, dateEnd);

    return { regimeConfig, capital, calendar, oamvDaily, signalsByDate };
  }

  private async loadSseCalendar(dateStart: string | null, dateEnd: string | null): Promise<string[]> {
    let sql = `SELECT cal_date FROM raw.trade_cal WHERE exchange='SSE' AND is_open=1`;
    const params: unknown[] = [];
    if (dateStart) {
      params.push(dateStart);
      sql += ` AND cal_date >= $${params.length}`;
    }
    if (dateEnd) {
      params.push(dateEnd);
      sql += ` AND cal_date <= $${params.length}`;
    }
    sql += ` ORDER BY cal_date ASC`;
    const rows = await this.dataSource.query<Array<{ cal_date: string }>>(sql, params.length ? params : undefined);
    return rows.map((r) => r.cal_date);
  }

  private async loadOamvDaily(dateStart: string, dateEnd: string): Promise<Map<string, RegimeOamvBar>> {
    const rows = await this.dataSource.query<Array<{ trade_date: string; amv_dif: number | null; amv_dea: number | null; amv_macd: number | null }>>(
      `SELECT trade_date, amv_dif, amv_dea, amv_macd
         FROM oamv_daily
        WHERE trade_date >= $1 AND trade_date <= $2
        ORDER BY trade_date ASC`,
      [dateStart, dateEnd],
    );
    const map = new Map<string, RegimeOamvBar>();
    for (const r of rows) {
      map.set(r.trade_date, { amvDif: r.amv_dif, amvDea: r.amv_dea, amvMacd: r.amv_macd });
    }
    return map;
  }

  private async enumerateSignals(
    calendar: string[],
    globalCalendar: string[],
    oamvDaily: Map<string, RegimeOamvBar>,
    regimeConfig: RegimeConfigMap,
    dateEnd: string,
  ): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];
    for (const d of calendar) {
      const oamv = oamvDaily.get(d);
      const regime = oamv ? classifyRegime(oamv.amvDif, oamv.amvMacd) : 'unknown';
      if (regime === 'unknown') continue;

      const entry = regimeConfig[regime];
      if (!entry || entry.action !== 'trade') continue;

      const conditions = entry.entryConditions;
      if (!conditions || conditions.length === 0) continue;

      const where = this.queryBuilder.buildAShareQuery(conditions);
      const { sql, params } = buildEnumerateQuery(where, d, { type: 'all' });
      const rows = await this.dataSource.query<Array<{ tsCode: string }>>(sql, params);

      const sigIdx = globalCalendar.indexOf(d);
      const buyDate = sigIdx + 1 < globalCalendar.length ? globalCalendar[sigIdx + 1] : null;
      if (!buyDate || buyDate > dateEnd) continue;

      for (const r of rows) {
        signals.push({ signalDate: d, buyDate, tsCode: r.tsCode, regime, entry });
      }
    }
    return signals;
  }

  private async buildWindows(
    signals: RawSignal[],
    globalCalendar: string[],
    dateEnd: string,
  ): Promise<Map<string, RegimeBacktestSignal[]>> {
    const signalsByDate = new Map<string, RegimeBacktestSignal[]>();

    if (signals.length === 0) return signalsByDate;

    const groups = new Map<string, RawSignal[]>();
    for (const sig of signals) {
      const arr = groups.get(sig.tsCode);
      if (arr) arr.push(sig);
      else groups.set(sig.tsCode, [sig]);
    }

    const tsCodes = Array.from(groups.keys());
    const symbolMap = await this.prefetchSymbolMap(tsCodes);

    for (const tsCode of tsCodes) {
      const sym = symbolMap.get(tsCode);
      const groupSignals = groups.get(tsCode)!;

      const exitConfigs = new Map<string, ExitConfig>();
      for (const sig of groupSignals) {
        if (!exitConfigs.has(sig.signalDate)) {
          exitConfigs.set(sig.signalDate, buildExitConfig(sig.entry.exitMode ?? null, sig.entry.exitParams ?? null));
        }
      }

      interface Prelim {
        signal: RawSignal;
        buyIdx: number;
        windowDates: string[];
      }
      const prelims: Prelim[] = [];
      for (const sig of groupSignals) {
        const sigIdx = globalCalendar.indexOf(sig.signalDate);
        if (sigIdx < 0 || sigIdx + 1 >= globalCalendar.length) continue;
        const buyIdx = sigIdx + 1;
        const windowDates = globalCalendar.slice(buyIdx).filter((d) => d <= dateEnd);
        if (windowDates.length === 0) continue;
        prelims.push({ signal: sig, buyIdx, windowDates });
      }

      if (prelims.length === 0) continue;

      let minBuyIdx = prelims[0].buyIdx;
      for (const p of prelims) if (p.buyIdx < minBuyIdx) minBuyIdx = p.buyIdx;
      const unionWindow = globalCalendar.slice(minBuyIdx).filter((d) => d <= dateEnd);

      const exit = exitConfigs.values().next().value!;
      const isBandLock = exit.mode === 'trailing_lock';
      const isPhaseLock = exit.mode === 'phase_lock';
      const needsExtFetch = isBandLock || isPhaseLock;
      const lookback = isPhaseLock ? exit.lookback : 0;
      const preheatDays = Math.max(MA5_PREHEAT_TRADING_DAYS, lookback);
      const extStartIdx = needsExtFetch
        ? Math.max(0, minBuyIdx - 1 - preheatDays)
        : minBuyIdx;
      const fetchWindow = needsExtFetch
        ? globalCalendar.slice(extStartIdx).filter((d) => d <= dateEnd)
        : unionWindow;

      const quoteMap = await this.fetchQuotes(tsCode, fetchWindow);
      const limitMap = await this.fetchLimits(tsCode, fetchWindow);
      let downLimitMap: Map<string, number | null> | undefined;
      if (needsExtFetch) {
        attachMa5(fetchWindow, quoteMap);
        downLimitMap = await this.fetchDownLimits(tsCode, fetchWindow);
      }
      let hitSet = new Set<string>();
      if (exit.mode === 'strategy') {
        const exitConditions = (prelims[0].signal.entry.exitParams as Record<string, unknown> | null)?.exitConditions as unknown[] | undefined;
        if (exitConditions && exitConditions.length > 0) {
          hitSet = await this.fetchExitSignalHits(tsCode, unionWindow, exitConditions);
        }
      }

      let effListIdx = -1;
      let hasListAnchor = false;
      if (sym?.listDate) {
        hasListAnchor = true;
        const listIdx = globalCalendar.indexOf(sym.listDate);
        effListIdx = listIdx >= 0 ? listIdx : findLastIndexLE(globalCalendar, sym.listDate);
      }
      const delistDate = sym?.delistDate ?? null;

      for (const { signal, buyIdx, windowDates } of prelims) {
        const sigExit = exitConfigs.get(signal.signalDate)!;
        let daysSinceList: number | null = null;
        if (hasListAnchor && effListIdx >= 0) daysSinceList = buyIdx - effListIdx;
        const days = buildHoldingDays(
          windowDates,
          quoteMap,
          limitMap,
          hitSet,
          needsExtFetch ? { downLimitMap } : undefined,
        );

        let signalHigh: number | undefined;
        if (sigExit.mode === 'trailing_lock') {
          const signalDateT = globalCalendar[buyIdx - 1];
          signalHigh = quoteMap.get(signalDateT)?.qfqHigh ?? undefined;
        }
        let recentLows: number[] | undefined;
        if (sigExit.mode === 'phase_lock') {
          recentLows = collectRecentLows(globalCalendar, buyIdx, quoteMap, sigExit.lookback);
        }

        const simInput: SimulationInput = {
          tsCode,
          signalDate: signal.signalDate,
          days,
          daysSinceList,
          delistDate,
          signalHigh,
          recentLows,
          exit: sigExit,
        };

        const arr = signalsByDate.get(signal.signalDate);
        if (arr) arr.push({ signalDate: signal.signalDate, buyDate: signal.buyDate, tsCode, simulationInput: simInput });
        else signalsByDate.set(signal.signalDate, [{ signalDate: signal.signalDate, buyDate: signal.buyDate, tsCode, simulationInput: simInput }]);
      }
    }

    return signalsByDate;
  }

  private async prefetchSymbolMap(
    tsCodes: string[],
  ): Promise<Map<string, { listDate: string | null; delistDate: string | null }>> {
    const map = new Map<string, { listDate: string | null; delistDate: string | null }>();
    if (tsCodes.length === 0) return map;
    const rows = await this.dataSource.query<Array<{ ts_code: string; list_date: string | null; delist_date: string | null }>>(
      `SELECT ts_code, list_date, delist_date FROM a_share_symbols WHERE ts_code = ANY($1::text[])`,
      [tsCodes],
    );
    for (const r of rows) {
      map.set(r.ts_code, { listDate: r.list_date ?? null, delistDate: r.delist_date ?? null });
    }
    return map;
  }

  private async fetchQuotes(tsCode: string, dates: string[]): Promise<Map<string, WindowQuote>> {
    const rows = await this.dataSource.query<Array<{
      trade_date: string; qfq_open: string | null; qfq_high: string | null;
      qfq_low: string | null; qfq_close: string | null; open: string | null; high: string | null;
    }>>(
      `SELECT trade_date, qfq_open, qfq_high, qfq_low, qfq_close, open, high
         FROM raw.daily_quote WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, WindowQuote>();
    for (const r of rows) {
      map.set(r.trade_date, {
        qfqOpen: toNum(r.qfq_open), qfqClose: toNum(r.qfq_close),
        open: toNum(r.open), qfqHigh: toNum(r.qfq_high),
        qfqLow: toNum(r.qfq_low), high: toNum(r.high),
      });
    }
    return map;
  }

  private async fetchLimits(tsCode: string, dates: string[]): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<Array<{ trade_date: string; up_limit: string | null }>>(
      `SELECT trade_date, up_limit FROM raw.stk_limit WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.up_limit));
    return map;
  }

  private async fetchDownLimits(tsCode: string, dates: string[]): Promise<Map<string, number | null>> {
    const rows = await this.dataSource.query<Array<{ trade_date: string; down_limit: string | null }>>(
      `SELECT trade_date, down_limit FROM raw.stk_limit WHERE ts_code = $1 AND trade_date = ANY($2::text[])`,
      [tsCode, dates],
    );
    const map = new Map<string, number | null>();
    for (const r of rows) map.set(r.trade_date, toNum(r.down_limit));
    return map;
  }

  private async fetchExitSignalHits(
    tsCode: string,
    dates: string[],
    exitConditions: unknown[],
  ): Promise<Set<string>> {
    if (dates.length === 0 || !exitConditions || (exitConditions as unknown[]).length === 0) return new Set();
    const where = this.queryBuilder.buildAShareQuery(exitConditions as any[]);
    const params: unknown[] = [...where.params];
    const tsPh = `$${params.length + 1}`;
    const datesPh = `$${params.length + 2}`;
    params.push(tsCode, dates);
    const sql = `
      SELECT i.trade_date AS "tradeDate"
        FROM raw.daily_indicator i
        LEFT JOIN raw.daily_quote q ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN raw.daily_basic m ON m.ts_code = i.ts_code AND m.trade_date = i.trade_date
        LEFT JOIN stock_amv_daily sa ON sa.ts_code = i.ts_code AND sa.trade_date = i.trade_date
       WHERE i.ts_code = ${tsPh} AND i.trade_date = ANY(${datesPh}::text[]) AND ${where.sql}
    `;
    const rows = await this.dataSource.query<Array<{ tradeDate: string }>>(sql, params);
    return new Set(rows.map((r) => r.tradeDate));
  }
}

export function buildExitConfig(
  exitMode: string | null,
  exitParams: Record<string, unknown> | null,
): ExitConfig {
  const p = exitParams ?? {};
  switch (exitMode) {
    case 'fixed_n':
      return { mode: 'fixed_n', horizonN: (p.N as number) ?? 5 };
    case 'trailing_lock':
      return {
        mode: 'trailing_lock',
        maxHold: (p.maxHold as number) ?? undefined,
        stopRatio: (p.stopRatio as number) ?? 0.999,
        floorRatio: (p.floorRatio as number) ?? 0.999,
        floorEnabled: (p.floorEnabled as boolean) ?? true,
        ma5RequireDown: (p.ma5RequireDown as boolean) ?? true,
      };
    case 'strategy':
      return { mode: 'strategy', maxHold: (p.maxHold as number) ?? 10 };
    case 'phase_lock':
      return {
        mode: 'phase_lock',
        initFactor: (p.initFactor as number) ?? 0.999,
        lockFactor: (p.lockFactor as number) ?? 0.999,
        lookback: (p.lookback as number) ?? 10,
      };
    default:
      return { mode: 'fixed_n', horizonN: (p.N as number) ?? 5 };
  }
}
