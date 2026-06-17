import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { KdjRecomputeService } from './kdj-recompute.service';
import { isKdjField, isCustomKdjParams, KdjParams } from './kdj-params';
import { evalKdjCondition } from './kdj-condition-eval';

/**
 * 自定义 KDJ 参数是否合法：n/m1/m2 均为整数且落在 [1, 99]。
 * 前端 n-input-number 已 min1/max99/precision0 约束，这是给 API 直连调用方的兜底
 * （后端不信前端）。非法则按 spec §8 回退 9/3/3（走预存列 SQL）。
 */
function isValidKdjParams(p: KdjParams): boolean {
  const inRange = (v: number) => Number.isInteger(v) && v >= 1 && v <= 99;
  return inRange(p.n) && inRange(p.m1) && inRange(p.m2);
}

@Injectable()
export class StrategyConditionsRunner {
  private readonly logger = new Logger(StrategyConditionsRunner.name);

  constructor(
    @InjectRepository(StrategyConditionRunEntity)
    private readonly runRepo: Repository<StrategyConditionRunEntity>,
    @InjectRepository(StrategyConditionHitEntity)
    private readonly hitRepo: Repository<StrategyConditionHitEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
    private readonly kdjRecompute: KdjRecomputeService,
  ) {}

  async executeRun(condition: StrategyConditionEntity, runId: string): Promise<void> {
    try {
      const total = await this.countTotalSymbols(condition.targetType);
      await this.runRepo.update(runId, { progressTotal: total });

      // A 股自定义 KDJ 重算的 as-of 日：与 scanBatch Phase 1 SQL 的对齐日同源
      // （raw.daily_indicator 最新交易日），保证命中集与重算口径严格一致。crypto 不需要。
      // 'YYYYMMDD' 字符串，禁止 new Date()。
      let asOf: string | undefined;
      if (condition.targetType === 'a-share') {
        const rows = await this.dataSource.query<Array<{ max: string | null }>>(
          `SELECT MAX(trade_date) AS max FROM raw.daily_indicator`,
        );
        asOf = rows[0]?.max ?? undefined;
      }

      const batchSize = 100;
      const allHits: Array<{ tsCode: string; name: string; matchedConditions: string[] }> = [];

      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = await this.scanBatch(condition, offset, batchSize, asOf);
        allHits.push(...batch);
        await this.runRepo.update(runId, {
          progressScanned: Math.min(offset + batchSize, total),
        });
      }

      if (allHits.length > 0) {
        const hitEntities = allHits.map(hit =>
          this.hitRepo.create({
            runId,
            tsCode: hit.tsCode,
            name: hit.name,
            matchedConditions: hit.matchedConditions,
          }),
        );
        await this.hitRepo.save(hitEntities);
      }

      await this.runRepo.update(runId, {
        status: 'completed',
        totalHits: allHits.length,
        completedAt: new Date(),
      });
    } catch (error: unknown) {
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async countTotalSymbols(targetType: string): Promise<number> {
    if (targetType === 'a-share') {
      const rows = await this.dataSource.query<Array<{ count: string }>>(`
        SELECT COUNT(*) FROM a_share_symbols WHERE list_status = 'L'
      `);
      return parseInt(rows[0].count, 10);
    } else {
      const rows = await this.dataSource.query<Array<{ count: string }>>(`
        SELECT COUNT(DISTINCT symbol) FROM klines WHERE interval = '1d'
      `);
      return parseInt(rows[0].count, 10);
    }
  }

  private async scanBatch(
    condition: StrategyConditionEntity,
    offset: number,
    limit: number,
    asOf?: string,
  ): Promise<Array<{ tsCode: string; name: string; matchedConditions: string[] }>> {
    const { conditions, targetType } = condition;
    if (conditions.length === 0) return [];

    const conditionDescriptions = conditions.map(c => {
      if (c.compareField) return `${c.field} ${c.operator} ${c.compareField}`;
      return `${c.field} ${c.operator} ${c.value}`;
    });

    // A 股两阶段：带自定义 KDJ 参数（≠9/3/3）的条件无法走预存列 SQL，需实时重算。
    // 把这类条件从 SQL 路径剔除（Phase 1 仅按 sqlConds 枚举/分页），再在内存里
    // 用重算结果按 recompConds 求交（AND），其余条件原样走 SQL。crypto 完全不变。
    if (targetType === 'a-share') {
      // 是否需要实时重算：KDJ 字段 + 自定义参数（≠9/3/3）+ 参数合法。
      // 非法 kdjParams（如 n=0 / 非整数 / 越界）按 spec §8 回退 9/3/3：warn 后归入
      // sqlConds，由 buildAShareQuery 映射到预存的 9/3/3 列（i.kdj_j 等）。
      const needsRecompute = (c: StrategyConditionItem): boolean => {
        if (!(isKdjField(c.field) && isCustomKdjParams(c.kdjParams))) return false;
        if (!isValidKdjParams(c.kdjParams as KdjParams)) {
          this.logger.warn(
            `非法自定义 KDJ 参数，回退 9/3/3：field=${c.field} ` +
              `kdjParams=${JSON.stringify(c.kdjParams)}`,
          );
          return false;
        }
        return true;
      };

      const recompConds = conditions.filter(c => needsRecompute(c));
      const sqlConds = conditions.filter(c => !needsRecompute(c));

      const where = this.queryBuilder.buildAShareQuery(sqlConds);
      const params: unknown[] = [...where.params];
      const limitPh = `$${params.length + 1}`;
      const offsetPh = `$${params.length + 2}`;
      params.push(limit, offset);
      const query = `
        SELECT s.ts_code as "tsCode", s.name
        FROM a_share_symbols s
        JOIN raw.daily_indicator i
          ON i.ts_code = s.ts_code
         AND i.trade_date = (SELECT MAX(trade_date) FROM raw.daily_indicator)
        LEFT JOIN raw.daily_quote q
          ON q.ts_code = s.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN raw.daily_basic m
          ON m.ts_code = s.ts_code AND m.trade_date = i.trade_date
        LEFT JOIN stock_amv_daily sa
          ON sa.ts_code = s.ts_code AND sa.trade_date = i.trade_date
        LEFT JOIN signal_rolling_indicator d
          ON d.ts_code = s.ts_code AND d.trade_date = i.trade_date
        WHERE s.list_status = 'L'
          AND ${where.sql}
        ORDER BY s.ts_code
        LIMIT ${limitPh} OFFSET ${offsetPh}
      `;

      const phase1 = await this.dataSource.query(query, params);
      const rows = (phase1 as Array<Record<string, unknown>>).map(row => ({
        tsCode: row.tsCode as string,
        name: row.name as string,
      }));

      if (recompConds.length === 0) {
        return rows.map(r => ({ ...r, matchedConditions: conditionDescriptions }));
      }

      // Phase 2：对 Phase 1 命中集，按 distinct KDJ 参数集各重算一次，再逐条 AND 求值。
      const tsCodes = rows.map(r => r.tsCode);
      const recompByKey = new Map<string, Map<string, { curr: { k: number; d: number; j: number }; prev: { k: number; d: number; j: number } | null }>>();
      for (const c of recompConds) {
        const p = c.kdjParams as KdjParams;
        const key = `${p.n}-${p.m1}-${p.m2}`;
        if (!recompByKey.has(key)) {
          // asOf 缺省（raw.daily_indicator 无数据）时按缺失处理：传 undefined 会让
          // recomputeLatest 的 trade_date <= $2 失配 → 空 Map → 全部 recompCond 不通过。
          const map = await this.kdjRecompute.recomputeLatest(tsCodes, asOf ?? '', p);
          recompByKey.set(key, map);
        }
      }

      const kept = rows.filter(r => {
        for (const c of recompConds) {
          const p = c.kdjParams as KdjParams;
          const key = `${p.n}-${p.m1}-${p.m2}`;
          const recomp = recompByKey.get(key)!.get(r.tsCode);
          // 该 tsCode 在重算结果里缺失（无 qfq 数据）→ 该 cond 不通过。
          if (!recomp || !evalKdjCondition(c, recomp)) return false;
        }
        return true;
      });

      return kept.map(r => ({ ...r, matchedConditions: conditionDescriptions }));
    }

    // crypto 分支不变：v1 加密仍走 9/3/3 SQL，不做 KDJ 实时重算。
    const where = this.queryBuilder.buildCryptoQuery(conditions);
    const params: unknown[] = [...where.params];
    const limitPh = `$${params.length + 1}`;
    const offsetPh = `$${params.length + 2}`;
    params.push(limit, offset);
    const query = `
        SELECT k.symbol as "tsCode", k.symbol as name
        FROM klines k
        WHERE k.interval = '1d'
          AND k.open_time = (
            SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
          )
          AND ${where.sql}
        ORDER BY k.symbol
        LIMIT ${limitPh} OFFSET ${offsetPh}
      `;

    const result = await this.dataSource.query(query, params);
    return (result as Array<Record<string, unknown>>).map(row => ({
      tsCode: row.tsCode as string,
      name: row.name as string,
      matchedConditions: conditionDescriptions,
    }));
  }
}
