import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RegimeConfigMap, RegimeConfigEntry } from '../../../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../../../strategy-conditions/strategy-conditions.enumerator';
import { classifyRegime } from '../../regime.classifier';
import { MarketSnapshot } from '../../market-condition-evaluator';
import { RawSignal } from '../types/backtest-data.types';

@Injectable()
export class SignalEnumerator {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  async enumerate(
    calendar: string[],
    globalCalendar: string[],
    marketSnapshots: Map<string, MarketSnapshot>,
    regimeConfig: RegimeConfigMap,
    dateEnd: string,
  ): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];
    for (const d of calendar) {
      const snapshot = marketSnapshots.get(d);
      const regime = snapshot ? classifyRegime(snapshot, regimeConfig.quadrants) : 'unknown';
      if (regime === 'unknown') continue;

      const entry = regimeConfig.quadrants.find((q) => q.key === regime);
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
}
