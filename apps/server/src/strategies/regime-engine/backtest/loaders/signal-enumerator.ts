import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RegimeConfigMap } from '../../../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../../../strategy-conditions/strategy-conditions.enumerator';
import { DerivedFieldRegistry } from '../../../../strategy-conditions/derived-field-registry';
import { classifyRegime } from '../../regime.classifier';
import { MarketSnapshot } from '../../market-condition-evaluator';
import { RawSignal, RankedCandidate } from '../types/backtest-data.types';
import { assignRanks, rankValueSqlExpr, RankDir } from '../rank-select';
import { resolveSignalTestUniverse } from './universe-resolver';
import {
  Phase1Row,
  phase2Recompute,
  phase2RankValue,
  fetchSqlFieldValues,
  findNeededSqlFields,
} from './signal-enumerator-phase2';

@Injectable()
export class SignalEnumerator {
  private readonly logger = new Logger(SignalEnumerator.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
    private readonly registry: DerivedFieldRegistry,
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

      // ── Phase 1: 拆分条件，用 sqlConds 走 SQL ───────────────────────────
      const { sqlConds, recompConds } = this.registry.split(conditions);

      // sqlConds 为空时用粗筛（q.vol > 0，保证候选集不爆炸）
      let effectiveSqlConds = sqlConds;
      if (sqlConds.length === 0 && recompConds.length > 0) {
        this.logger.warn(
          `signalDate=${d} regime=${regime}: entryConditions 全为现算字段，` +
            `使用粗筛 q.vol > 0 减少候选集。建议至少配一个 SQL 条件。`,
        );
        effectiveSqlConds = [
          { field: 'volume', operator: 'gt', value: 0 },
        ];
      }

      let rankValueExpr: string | null = null;
      try {
        rankValueExpr = rankValueSqlExpr(rankField);
      } catch {
        // rankField 不在 COL_MAP（可能是现算字段），Phase 2 补算
      }
      const where = this.queryBuilder.buildAShareQuery(effectiveSqlConds);
      const { sql, params } = buildEnumerateQuery(where, d, signalUniverse, {
        rankValueExpr,
      });
      const rows = await this.dataSource.query<Phase1Row[]>(sql, params);

      // ── Phase 2: 内存重算过滤 ──────────────────────────────────────────
      let filteredRows: Phase1Row[] = rows;
      if (recompConds.length > 0 && rows.length > 0) {
        // 查预算字段当日值（供 siblingResults 注入）
        const neededFields = findNeededSqlFields(recompConds);
        let sqlFieldValues: Map<string, Record<string, number>> | undefined;
        if (neededFields.size > 0) {
          const tsCodes = rows.map((r) => r.tsCode);
          sqlFieldValues = await fetchSqlFieldValues(
            tsCodes,
            d,
            [...neededFields],
            this.dataSource,
          );
        }
        filteredRows = await phase2Recompute(
          rows,
          recompConds,
          d,
          this.registry,
          this.dataSource,
          sqlFieldValues,
        );
      }

      // ── rankField 现算补算 ──────────────────────────────────────────────
      if (!rankValueExpr) {
        // rankField 不在 COL_MAP，可能是现算字段
        if (this.registry.resolve({ field: rankField } as any)) {
          filteredRows = await phase2RankValue(
            filteredRows,
            rankField,
            d,
            this.registry,
          );
        }
      }

      const sigIdx = globalCalendar.indexOf(d);
      const buyDate = sigIdx + 1 < globalCalendar.length ? globalCalendar[sigIdx + 1] : null;
      // 无 T+1 → 整日不产出（top1 与 rankedAll 都不进）
      if (!buyDate || buyDate > dateEnd) continue;

      const candidates = filteredRows.map((r) => {
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
