import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StrategyConditionItem } from '../../../../entities/strategy/strategy-condition.entity';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';
import { DerivedFieldRegistry } from '../../../../strategy-conditions/derived-field-registry';

@Injectable()
export class ExitSignalLoader {
  private readonly logger = new Logger(ExitSignalLoader.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
    private readonly registry: DerivedFieldRegistry,
  ) {}

  async fetchExitSignalHits(
    tsCode: string,
    dates: string[],
    exitConditions: unknown[],
  ): Promise<Set<string>> {
    if (dates.length === 0 || !exitConditions || exitConditions.length === 0) {
      return new Set();
    }
    const conditions = exitConditions as StrategyConditionItem[];

    // ── Phase 1: 拆分条件，用 sqlConds 走 SQL ─────────────────────────────
    const { sqlConds, recompConds } = this.registry.split(conditions);

    // sqlConds 为空且含 recompConds：用粗筛(q.vol > 0)减少候选集
    let effectiveSqlConds = sqlConds;
    if (sqlConds.length === 0 && recompConds.length > 0) {
      this.logger.warn(
        `exitConditions 全为现算字段，对 tsCode=${tsCode} 使用粗筛 q.vol > 0。` +
          `建议至少配一个 SQL 条件。`,
      );
      effectiveSqlConds = [
        { field: 'volume', operator: 'gt', value: 0 },
      ];
    }

    const where = this.queryBuilder.buildAShareQuery(effectiveSqlConds);
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

    if (recompConds.length === 0) {
      return new Set(rows.map((r) => r.tradeDate));
    }

    // ── Phase 2: 对 Phase 1 命中日期做内存重算过滤 ────────────────────────
    // ExitSignalLoader 只处理单个 tsCode，逐日逐条 recompCond 重算+求值。
    // 不传 siblingResults（exitConditions 一般不用 compareField 做跨字段比较；
    // 如果将来需要，可在此注入）。
    if (recompConds.some((c) => c.compareField)) {
      this.logger.warn(
        'exitConditions 含 compareMode=field 的现算字段,当前 ExitSignalLoader 不支持 sibling 注入,条件可能误判。见文档 §5.3',
      );
    }
    const hitDates = rows.map((r) => r.tradeDate);
    const keepDates = new Set<string>();

    for (const tradeDate of hitDates) {
      let allPass = true;
      for (const cond of recompConds) {
        const recomputer = this.registry.resolve(cond)!;
        const snapshots = await recomputer.recomputeLatest(
          [tsCode],
          tradeDate,
          cond,
        );
        const snap = snapshots.get(tsCode);
        if (!snap || !recomputer.evaluate(cond, snap)) {
          allPass = false;
          break;
        }
      }
      if (allPass) keepDates.add(tradeDate);
    }

    return keepDates;
  }
}
