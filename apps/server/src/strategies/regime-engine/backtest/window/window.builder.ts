import { Injectable } from '@nestjs/common';
import {
  ExitConfig,
  SimulationInput,
  WindowQuote,
  buildHoldingDays,
  findLastIndexLE,
} from '../../core/exit-simulator';
import { attachMa5, collectRecentLows, MA5_PREHEAT_TRADING_DAYS } from '../regime-backtest.helpers';
import { SymbolMetaLoader } from '../loaders/symbol-meta.loader';
import { QuoteLoader } from '../loaders/quote.loader';
import { ExitSignalLoader } from '../loaders/exit-signal.loader';
import { buildExitConfig } from '../exit/exit-config.builder';
import { RegimeBacktestSignal } from '../regime-backtest.types';
import { RawSignal, SymbolMeta } from '../types/backtest-data.types';

interface Prelim {
  signal: RawSignal;
  buyIdx: number;
  windowDates: string[];
}

@Injectable()
export class WindowBuilder {
  constructor(
    private readonly symbolMetaLoader: SymbolMetaLoader,
    private readonly quoteLoader: QuoteLoader,
    private readonly exitSignalLoader: ExitSignalLoader,
  ) {}

  async build(
    signals: RawSignal[],
    globalCalendar: string[],
    dateEnd: string,
  ): Promise<Map<string, RegimeBacktestSignal[]>> {
    const signalsByDate = new Map<string, RegimeBacktestSignal[]>();
    if (signals.length === 0) return signalsByDate;

    const groups = this.groupByTsCode(signals);
    const tsCodes = Array.from(groups.keys());
    const symbolMap = await this.symbolMetaLoader.prefetchSymbolMap(tsCodes);

    for (const tsCode of tsCodes) {
      const groupSignals = groups.get(tsCode)!;
      const prelims = this.buildPrelims(groupSignals, globalCalendar, dateEnd);
      if (prelims.length === 0) continue;

      const meta = symbolMap.get(tsCode);
      const exitConfigs = this.buildExitConfigs(groupSignals);
      const { unionWindow, fetchWindow, needsExtFetch } = this.resolveWindows(
        prelims,
        globalCalendar,
        dateEnd,
        exitConfigs,
      );

      const quoteMap = await this.quoteLoader.fetchQuotes(tsCode, fetchWindow);
      const limitMap = await this.quoteLoader.fetchLimits(tsCode, fetchWindow);
      const downLimitMap = needsExtFetch
        ? await this.attachDownLimitAndMa5(tsCode, fetchWindow, quoteMap)
        : undefined;

      const hitSet = await this.resolveStrategyHits(exitConfigs, tsCode, unionWindow);
      const { effListIdx, hasListAnchor, delistDate } = this.resolveSymbolMeta(
        meta,
        globalCalendar,
      );

      for (const { signal, buyIdx, windowDates } of prelims) {
        const simInput = this.buildSimulationInput({
          tsCode,
          signal,
          buyIdx,
          windowDates,
          globalCalendar,
          quoteMap,
          limitMap,
          hitSet,
          downLimitMap,
          daysSinceList: hasListAnchor && effListIdx >= 0 ? buyIdx - effListIdx : null,
          delistDate,
          exitConfigs,
        });

        const arr = signalsByDate.get(signal.signalDate);
        const backtestSignal: RegimeBacktestSignal = {
          signalDate: signal.signalDate,
          buyDate: signal.buyDate,
          tsCode,
          simulationInput: simInput,
        };
        if (arr) arr.push(backtestSignal);
        else signalsByDate.set(signal.signalDate, [backtestSignal]);
      }
    }

    return signalsByDate;
  }

  private groupByTsCode(signals: RawSignal[]): Map<string, RawSignal[]> {
    const groups = new Map<string, RawSignal[]>();
    for (const sig of signals) {
      const arr = groups.get(sig.tsCode);
      if (arr) arr.push(sig);
      else groups.set(sig.tsCode, [sig]);
    }
    return groups;
  }

  private buildExitConfigs(groupSignals: RawSignal[]): Map<string, ExitConfig> {
    const exitConfigs = new Map<string, ExitConfig>();
    for (const sig of groupSignals) {
      if (!exitConfigs.has(sig.signalDate)) {
        exitConfigs.set(
          sig.signalDate,
          buildExitConfig(sig.entry.exitMode ?? null, sig.entry.exitParams ?? null),
        );
      }
    }
    return exitConfigs;
  }

  private buildPrelims(
    groupSignals: RawSignal[],
    globalCalendar: string[],
    dateEnd: string,
  ): Prelim[] {
    const prelims: Prelim[] = [];
    for (const sig of groupSignals) {
      const sigIdx = globalCalendar.indexOf(sig.signalDate);
      if (sigIdx < 0 || sigIdx + 1 >= globalCalendar.length) continue;
      const buyIdx = sigIdx + 1;
      const windowDates = globalCalendar.slice(buyIdx).filter((d) => d <= dateEnd);
      if (windowDates.length === 0) continue;
      prelims.push({ signal: sig, buyIdx, windowDates });
    }
    return prelims;
  }

  private resolveWindows(
    prelims: Prelim[],
    globalCalendar: string[],
    dateEnd: string,
    exitConfigs: Map<string, ExitConfig>,
  ): {
    unionWindow: string[];
    fetchWindow: string[];
    needsExtFetch: boolean;
  } {
    let minBuyIdx = prelims[0].buyIdx;
    for (const p of prelims) if (p.buyIdx < minBuyIdx) minBuyIdx = p.buyIdx;
    const unionWindow = globalCalendar.slice(minBuyIdx).filter((d) => d <= dateEnd);

    let maxLookback = 0;
    let needsExtFetch = false;
    for (const exit of exitConfigs.values()) {
      if (exit.mode === 'trailing_lock' || exit.mode === 'phase_lock') {
        needsExtFetch = true;
      }
      if (exit.mode === 'phase_lock') {
        maxLookback = Math.max(maxLookback, exit.lookback);
      }
    }

    const preheatDays = Math.max(MA5_PREHEAT_TRADING_DAYS, maxLookback);
    const extStartIdx = needsExtFetch
      ? Math.max(0, minBuyIdx - 1 - preheatDays)
      : minBuyIdx;
    const fetchWindow = needsExtFetch
      ? globalCalendar.slice(extStartIdx).filter((d) => d <= dateEnd)
      : unionWindow;

    return { unionWindow, fetchWindow, needsExtFetch };
  }

  private async attachDownLimitAndMa5(
    tsCode: string,
    fetchWindow: string[],
    quoteMap: Map<string, WindowQuote>,
  ): Promise<Map<string, number | null>> {
    attachMa5(fetchWindow, quoteMap);
    return this.quoteLoader.fetchDownLimits(tsCode, fetchWindow);
  }

  private async resolveStrategyHits(
    exitConfigs: Map<string, ExitConfig>,
    tsCode: string,
    unionWindow: string[],
  ): Promise<Set<string>> {
    let allExitConditions: unknown[] = [];
    for (const exit of exitConfigs.values()) {
      if (exit.mode === 'strategy') {
        const conditions = exit.exitConditions;
        if (conditions && conditions.length > 0) {
          allExitConditions = allExitConditions.concat(conditions);
        }
      }
    }
    if (allExitConditions.length === 0) return new Set();
    return this.exitSignalLoader.fetchExitSignalHits(tsCode, unionWindow, allExitConditions);
  }

  private resolveSymbolMeta(
    meta: SymbolMeta | undefined,
    globalCalendar: string[],
  ): {
    effListIdx: number;
    hasListAnchor: boolean;
    delistDate: string | null;
  } {
    let effListIdx = -1;
    let hasListAnchor = false;
    if (meta?.listDate) {
      hasListAnchor = true;
      const listIdx = globalCalendar.indexOf(meta.listDate);
      effListIdx = listIdx >= 0 ? listIdx : findLastIndexLE(globalCalendar, meta.listDate);
    }
    return { effListIdx, hasListAnchor, delistDate: meta?.delistDate ?? null };
  }

  private buildSimulationInput(ctx: {
    tsCode: string;
    signal: RawSignal;
    buyIdx: number;
    windowDates: string[];
    globalCalendar: string[];
    quoteMap: Map<string, WindowQuote>;
    limitMap: Map<string, number | null>;
    hitSet: Set<string>;
    downLimitMap: Map<string, number | null> | undefined;
    daysSinceList: number | null;
    delistDate: string | null;
    exitConfigs: Map<string, ExitConfig>;
  }): SimulationInput {
    const {
      tsCode,
      signal,
      buyIdx,
      windowDates,
      quoteMap,
      limitMap,
      hitSet,
      downLimitMap,
      daysSinceList,
      delistDate,
      exitConfigs,
    } = ctx;

    const sigExit = exitConfigs.get(signal.signalDate)!;
    const days = buildHoldingDays(
      windowDates,
      quoteMap,
      limitMap,
      hitSet,
      downLimitMap ? { downLimitMap } : undefined,
    );

    let signalHigh: number | undefined;
    if (sigExit.mode === 'trailing_lock') {
      const signalDateT = ctx.globalCalendar[buyIdx - 1];
      signalHigh = quoteMap.get(signalDateT)?.qfqHigh ?? undefined;
    }

    let recentLows: number[] | undefined;
    if (sigExit.mode === 'phase_lock') {
      recentLows = collectRecentLows(ctx.globalCalendar, buyIdx, quoteMap, sigExit.lookback);
    }

    return {
      tsCode,
      signalDate: signal.signalDate,
      days,
      daysSinceList,
      delistDate,
      signalHigh,
      recentLows,
      exit: sigExit,
    };
  }
}
