import { Injectable } from '@nestjs/common';
import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { CalendarLoader } from './loaders/calendar.loader';
import { MarketSnapshotLoader } from './loaders/market-snapshot.loader';
import { SignalEnumerator } from './loaders/signal-enumerator';
import { WindowBuilder } from './window/window.builder';
import { RegimeBacktestCapital, RegimeBacktestInput } from './regime-backtest.types';

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
  }): Promise<RegimeBacktestInput> {
    const { regimeConfig, capital, dateStart, dateEnd } = params;

    const [globalCalendar, calendar] = await Promise.all([
      this.calendarLoader.load(null, null),
      this.calendarLoader.load(dateStart, dateEnd),
    ]);

    const marketSnapshots = await this.marketSnapshotLoader.load(
      dateStart,
      dateEnd,
      regimeConfig.marketIndex,
    );

    const signals = await this.signalEnumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      dateEnd,
    );

    const signalsByDate = await this.windowBuilder.build(signals, globalCalendar, dateEnd);

    return { regimeConfig, capital, calendar, marketSnapshots, signalsByDate };
  }
}

export { buildExitConfig } from './exit/exit-config.builder';
export type { RawSignal } from './types/backtest-data.types';
