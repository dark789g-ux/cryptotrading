import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RegimeConfigMap } from '../../../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../../../strategy-conditions/strategy-conditions.enumerator';
import { classifyRegime } from '../../regime.classifier';
import { MarketSnapshot } from '../../market-condition-evaluator';
import { RawSignal, RankedCandidate } from '../types/backtest-data.types';
import { assignRanks, rankValueSqlExpr, RankDir } from '../rank-select';
import { resolveSignalTestUniverse } from './universe-resolver';

@Injectable()
export class SignalEnumerator {
  private readonly logger = new Logger(SignalEnumerator.name);

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
  ): Promise<{ top1Signals: RawSignal[]; rankedAll: RankedCandidate[] }> {
    const top1Signals: RawSignal[] = [];
    const rankedAll: RankedCandidate[] = [];
    const signalUniverse = await resolveSignalTestUniverse(
      this.dataSource,
      regimeConfig.universe,
    );

    for (const d of calendar) {
      const snapshot = marketSnapshots.get(d);
      const regime = snapshot ? classifyRegime(snapshot, regimeConfig.quadrants) : 'unknown';
      if (regime === 'unknown') continue;

      const entry = regimeConfig.quadrants.find((q) => q.key === regime);
      if (!entry || entry.action !== 'trade') continue;

      const conditions = entry.entryConditions;
      if (!conditions || conditions.length === 0) continue;

      // fail-closed：缺 rankField 不静默当 none
      if (entry.rankField == null || entry.rankField === '') {
        this.logger.warn(
          `signalDate=${d} regime=${regime}: missing rankField, skip day`,
        );
        continue;
      }
      const rankField = entry.rankField;
      const rankDir: RankDir =
        entry.rankDir === 'asc' || entry.rankDir === 'desc' ? entry.rankDir : 'asc';
      const rankValueExpr = rankValueSqlExpr(rankField);

      const where = this.queryBuilder.buildAShareQuery(conditions);
      const { sql, params } = buildEnumerateQuery(where, d, signalUniverse, {
        rankValueExpr,
      });
      const rows = await this.dataSource.query<
        Array<{ tsCode: string; rankValue?: unknown }>
      >(sql, params);

      const sigIdx = globalCalendar.indexOf(d);
      const buyDate = sigIdx + 1 < globalCalendar.length ? globalCalendar[sigIdx + 1] : null;
      // 无 T+1 → 整日不产出（top1 与 rankedAll 都不进）
      if (!buyDate || buyDate > dateEnd) continue;

      const candidates = rows.map((r) => {
        let rankValue: number | null = null;
        if (r.rankValue != null) {
          const n = Number(r.rankValue);
          rankValue = Number.isNaN(n) ? null : n;
        }
        return { tsCode: r.tsCode, rankValue };
      });

      const ranked = assignRanks(candidates, rankDir, {
        mode: rankField === 'none' ? 'none' : 'value',
      });

      const exitMode = entry.exitMode ?? '';
      for (const r of ranked) {
        rankedAll.push({
          signalDate: d,
          buyDate,
          tsCode: r.tsCode,
          regime,
          exitMode,
          rank: r.rank,
          rankField,
          rankValue: r.rankValue,
        });
        if (r.rank === 1) {
          top1Signals.push({
            signalDate: d,
            buyDate,
            tsCode: r.tsCode,
            regime,
            entry,
          });
        }
      }
    }

    return { top1Signals, rankedAll };
  }
}
