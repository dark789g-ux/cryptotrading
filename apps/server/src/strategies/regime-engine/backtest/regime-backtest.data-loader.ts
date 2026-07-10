import { Injectable } from '@nestjs/common';
import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { CalendarLoader } from './loaders/calendar.loader';
import { MarketSnapshotLoader } from './loaders/market-snapshot.loader';
import { SignalEnumerator } from './loaders/signal-enumerator';
import { WindowBuilder } from './window/window.builder';
import { RegimeBacktestCapital, RegimeBacktestInput } from './regime-backtest.types';
import { RankedCandidate } from './types/backtest-data.types';

@Injectable()
export class RegimeBacktestDataLoader {
  constructor(
    private readonly calendarLoader: CalendarLoader,
    private readonly marketSnapshotLoader: MarketSnapshotLoader,
    private readonly signalEnumerator: SignalEnumerator,
    private readonly windowBuilder: WindowBuilder,
  ) {}

  async load(params: {
    regimeConfig: RegimeConfigMap;
    capital: RegimeBacktestCapital;
    dateStart: string;
    dateEnd: string;
  }): Promise<{ input: RegimeBacktestInput; rankedAll: RankedCandidate[] }> {
    const { regimeConfig, capital, dateStart, dateEnd } = params;

    const [globalCalendar, calendar] = await Promise.all([
      this.calendarLoader.load(null, null),
      this.calendarLoader.load(dateStart, dateEnd),
    ]);

    const marketSnapshots = await this.marketSnapshotLoader.load(
      regimeConfig,
      calendar,
      globalCalendar,
    );

    const { top1Signals, rankedAll } = await this.signalEnumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      dateEnd,
    );

    const signalsByDate = await this.windowBuilder.build(
      top1Signals,
      globalCalendar,
      dateEnd,
    );

    return {
      input: { regimeConfig, capital, calendar, marketSnapshots, signalsByDate },
      rankedAll,
    };
  }
}

export { buildExitConfig } from './exit/exit-config.builder';
export type { RawSignal, RankedCandidate } from './types/backtest-data.types';
