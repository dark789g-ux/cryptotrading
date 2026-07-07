/**
 * _shared/dataset-completeness.spec.ts
 *
 * 覆盖通用 helper 两个出口：
 *   - collectCompletenessErrors（POST 告警）四场景：actual<baseline 告警 /
 *     基准未落库跳过 / 完整不告警 / baseline 不按日期（etf_symbol tracked）。
 *   - isDatasetComplete（PRE 门控）回归：迁移 a-shares 三配置后行为不变
 *     （self / baseline 按日 / strictNonNullColumns / SQL 形状）。
 *
 * mock repo.query 按 SQL 内容分支返回，不连真 DB。
 */

import { collectCompletenessErrors, isDatasetComplete } from './dataset-completeness';
import type { DatasetCompletenessConfig } from './dataset-completeness';
import type { Repository } from 'typeorm';

// ── mock 工具 ──────────────────────────────────────────────────────────────────

type QueryCall = { sql: string; params: unknown[] };

/** 构造一个记录所有调用的 repo.query mock；按 sql 选择响应。 */
function makeRepoMock(selectResponse: (sql: string, params: unknown[]) => unknown[]): {
  repo: Repository<unknown>;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const query = (sql: string, params?: unknown): Promise<unknown> => {
    const p = params ?? [];
    calls.push({ sql, params: p as unknown[] });
    return Promise.resolve(selectResponse(sql, p as unknown[]));
  };
  return { repo: { query } as unknown as Repository<unknown>, calls };
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── collectCompletenessErrors（POST 告警）四场景 ─────────────────────────────

describe('collectCompletenessErrors - POST 告警', () => {
  const baselineDailyQuote: DatasetCompletenessConfig = {
    tableName: 'raw.money_flow_stocks',
    dateColumn: 'trade_date',
    baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
  };

  it('actual < baseline → 告警（携带 apiName + 完整参数）', async () => {
    // target: money_flow_stocks 当日 5184 行；baseline: daily_quote 当日 5517 行
    const { repo } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.money_flow_stocks')) {
        return [{ trade_date: '20260702', total: '5184' }];
      }
      if (sql.includes('FROM raw.daily_quote')) {
        return [{ trade_date: '20260702', total: '5517' }];
      }
      return [];
    });

    const errors = await collectCompletenessErrors(repo, baselineDailyQuote, ['20260702'], 'moneyflow_ths');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      '[moneyflow_ths_incomplete] 20260702 入库 5184 < 5517，疑似部分缺失',
    );
  });

  it('基准当日未落库（GROUP BY 缺键）→ 跳过不告警', async () => {
    // target 有 100 行；baseline 表该日完全没有行（GROUP BY 返回空数组）
    const { repo } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.money_flow_stocks')) {
        return [{ trade_date: '20260702', total: '100' }];
      }
      if (sql.includes('FROM raw.daily_quote')) {
        return []; // 基准当日未落库
      }
      return [];
    });

    const errors = await collectCompletenessErrors(repo, baselineDailyQuote, ['20260702'], 'moneyflow_ths');

    expect(errors).toEqual([]);
  });

  it('actual == baseline（完整）→ 不告警', async () => {
    const { repo } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.money_flow_stocks')) {
        return [{ trade_date: '20260702', total: '5517' }];
      }
      if (sql.includes('FROM raw.daily_quote')) {
        return [{ trade_date: '20260702', total: '5517' }];
      }
      return [];
    });

    const errors = await collectCompletenessErrors(repo, baselineDailyQuote, ['20260702'], 'moneyflow_ths');

    expect(errors).toEqual([]);
  });

  it('多日场景：actual < baseline 仅告警缺失日', async () => {
    const { repo } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.money_flow_stocks')) {
        return [
          { trade_date: '20260701', total: '5517' }, // 完整
          { trade_date: '20260702', total: '5184' }, // 缺失
        ];
      }
      if (sql.includes('FROM raw.daily_quote')) {
        return [
          { trade_date: '20260701', total: '5517' },
          { trade_date: '20260702', total: '5517' },
        ];
      }
      return [];
    });

    const errors = await collectCompletenessErrors(
      repo,
      baselineDailyQuote,
      ['20260701', '20260702'],
      'moneyflow_ths',
    );

    expect(errors).toEqual([
      '[moneyflow_ths_incomplete] 20260702 入库 5184 < 5517，疑似部分缺失',
    ]);
  });

  it('baseline 不按日期（etf_symbol.tracked）→ 全表标量均匀映射到每个 trade_date', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.fund_daily',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.etf_symbol', filter: 'tracked = true' }, // 无 dateColumn
    };
    const { repo, calls } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.fund_daily')) {
        return [
          { trade_date: '20260701', total: '900' },
          { trade_date: '20260702', total: '950' },
        ];
      }
      if (sql.includes('FROM raw.etf_symbol')) {
        // 全表标量：COUNT(*) 不按日期
        return [{ total: '1000' }];
      }
      return [];
    });

    const errors = await collectCompletenessErrors(
      repo,
      config,
      ['20260701', '20260702'],
      'fund_daily',
    );

    // baseline 全表 SQL 形状校验：不按日期，含 filter，无 ANY($1)
    const baselineCall = calls.find((c) => c.sql.includes('FROM raw.etf_symbol'));
    expect(baselineCall).toBeDefined();
    expect(baselineCall!.sql).not.toContain('= ANY($1)');
    expect(baselineCall!.sql).toContain('tracked = true');

    expect(errors).toEqual([
      '[fund_daily_incomplete] 20260701 入库 900 < 1000，疑似部分缺失',
      '[fund_daily_incomplete] 20260702 入库 950 < 1000，疑似部分缺失',
    ]);
  });

  it('baseline 不按日期且全表为空 → 全部跳过不告警', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.fund_daily',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.etf_symbol', filter: 'tracked = true' },
    };
    const { repo } = makeRepoMock((sql) => {
      if (sql.includes('FROM raw.fund_daily')) {
        return [{ trade_date: '20260701', total: '5' }];
      }
      if (sql.includes('FROM raw.etf_symbol')) {
        return [{ total: '0' }]; // 基准全表空
      }
      return [];
    });

    const errors = await collectCompletenessErrors(repo, config, ['20260701'], 'fund_daily');

    expect(errors).toEqual([]);
  });

  it('tradeDates 空 → 不查 DB 直接返回 []', async () => {
    const selectResponse = jest.fn().mockReturnValue([]);
    const { repo } = makeRepoMock((sql, p) => selectResponse(sql, p));

    const errors = await collectCompletenessErrors(repo, baselineDailyQuote, [], 'moneyflow_ths');

    expect(errors).toEqual([]);
    expect(selectResponse).not.toHaveBeenCalled();
  });

  it("baseline='self' → 容错返回 []（POST 对 self 无意义）", async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_quote',
      dateColumn: 'trade_date',
      baseline: 'self',
    };
    const { repo } = makeRepoMock(() => []);

    const errors = await collectCompletenessErrors(repo, config, ['20260702'], 'daily');

    expect(errors).toEqual([]);
  });

  it('target SQL 形状：参数化 ANY($1::text[])，GROUP BY trade_date', async () => {
    const { repo, calls } = makeRepoMock(() => []);

    await collectCompletenessErrors(repo, baselineDailyQuote, ['20260702'], 'moneyflow_ths');

    const targetCall = calls.find((c) => c.sql.includes('FROM raw.money_flow_stocks'));
    expect(targetCall).toBeDefined();
    const flat = squash(targetCall!.sql);
    expect(flat).toContain('= ANY($1::text[])');
    expect(flat).toContain('GROUP BY trade_date');
    expect(targetCall!.params).toEqual([['20260702']]);
  });
});

// ── isDatasetComplete（PRE 门控）回归 ─────────────────────────────────────────
// 覆盖 a-shares 三配置迁移后行为不变（self / 按日 baseline / strictNonNullColumns）。

describe('isDatasetComplete - PRE 门控', () => {
  const selfConfig: DatasetCompletenessConfig = {
    tableName: 'raw.daily_quote',
    dateColumn: 'trade_date',
    strictNonNullColumns: ['open', 'close'],
    baseline: 'self',
  };

  it('self + total>0 + 无 NULL → 完整(true)', async () => {
    const { repo } = makeRepoMock(() => [
      { __total: '5000', open__nulls: '0', close__nulls: '0' },
    ]);

    const ok = await isDatasetComplete(repo, selfConfig, '20260702');

    expect(ok).toBe(true);
  });

  it('self + total=0 → 不完整(false)', async () => {
    const { repo } = makeRepoMock(() => [
      { __total: '0', open__nulls: '0', close__nulls: '0' },
    ]);

    const ok = await isDatasetComplete(repo, selfConfig, '20260702');

    expect(ok).toBe(false);
  });

  it('self + strictNonNullColumns 有 NULL → 不完整(false)', async () => {
    const { repo } = makeRepoMock(() => [
      { __total: '5000', open__nulls: '3', close__nulls: '0' },
    ]);

    const ok = await isDatasetComplete(repo, selfConfig, '20260702');

    expect(ok).toBe(false);
  });

  it('按日 baseline + total < baseline → 不完整(false)', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_basic',
      dateColumn: 'trade_date',
      strictNonNullColumns: ['turnover_rate'],
      baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
    };
    const { repo } = makeRepoMock(() => [
      {
        __total: '4000',
        turnover_rate__nulls: '0',
        __baseline: '5000',
      },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(false);
  });

  it('按日 baseline + baseline=0（基准当日未落库）→ 不完整(false)', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_basic',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
    };
    const { repo } = makeRepoMock(() => [
      { __total: '100', __baseline: '0' },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(false);
  });

  it('按日 baseline + total>=baseline + 无 NULL → 完整(true)', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.adj_factor',
      dateColumn: 'trade_date',
      strictNonNullColumns: ['adj_factor'],
      baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
    };
    const { repo } = makeRepoMock(() => [
      {
        __total: '5000',
        adj_factor__nulls: '0',
        __baseline: '5000',
      },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(true);
  });

  it('不按日期 baseline（etf_symbol.tracked）+ total < baseline → 不完整(false)', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.fund_daily',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.etf_symbol', filter: 'tracked = true' },
    };
    const { repo } = makeRepoMock(() => [
      { __total: '900', __baseline: '1000' },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(false);
  });

  it('查询无返回行 → 不完整(false)', async () => {
    const { repo } = makeRepoMock(() => []);

    const ok = await isDatasetComplete(repo, selfConfig, '20260702');

    expect(ok).toBe(false);
  });

  it('SQL 形状：参数化 $1=trade_date，含 strictNonNullColumns FILTER + baseline 子查询', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_basic',
      dateColumn: 'trade_date',
      strictNonNullColumns: ['turnover_rate', 'total_mv'],
      baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
    };
    const { repo, calls } = makeRepoMock(() => [
      { __total: '0', turnover_rate__nulls: '0', total_mv__nulls: '0', __baseline: '0' },
    ]);

    await isDatasetComplete(repo, config, '20260702');

    expect(calls).toHaveLength(1);
    const flat = squash(calls[0].sql);
    // 行级硬约束 FILTER
    expect(flat).toContain('COUNT(*) FILTER (WHERE turnover_rate IS NULL) AS "turnover_rate__nulls"');
    expect(flat).toContain('COUNT(*) FILTER (WHERE total_mv IS NULL) AS "total_mv__nulls"');
    // baseline 子查询内联，参数化 $1
    expect(flat).toContain('(SELECT COUNT(*) FROM raw.daily_quote WHERE trade_date = $1) AS "__baseline"');
    // 主表 WHERE trade_date = $1
    expect(flat).toContain('FROM raw.daily_basic');
    expect(flat).toContain('WHERE trade_date = $1');
    expect(calls[0].params).toEqual(['20260702']);
  });

  it("baseline='self' → SQL 不含 baseline 子查询", async () => {
    const { repo, calls } = makeRepoMock(() => [
      { __total: '5000', open__nulls: '0', close__nulls: '0' },
    ]);

    await isDatasetComplete(repo, selfConfig, '20260702');

    const flat = squash(calls[0].sql);
    expect(flat).not.toContain('__baseline');
  });

  it('baseline 不按日期 → 子查询用 WHERE TRUE + filter，不 WHERE 日期', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.fund_daily',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.etf_symbol', filter: 'tracked = true' },
    };
    const { repo, calls } = makeRepoMock(() => [
      { __total: '1000', __baseline: '1000' },
    ]);

    await isDatasetComplete(repo, config, '20260702');

    const flat = squash(calls[0].sql);
    expect(flat).toContain(
      '(SELECT COUNT(*) FROM raw.etf_symbol WHERE TRUE AND tracked = true) AS "__baseline"',
    );
  });
});

describe('isDatasetComplete - toleranceRatio 容差', () => {
  const baselineConfigWithTolerance: DatasetCompletenessConfig = {
    tableName: 'raw.daily_quote',
    dateColumn: 'trade_date',
    baseline: { table: 'a_share_symbols', filter: "list_status = 'L'" },
    toleranceRatio: 0.05,
  };

  it('toleranceRatio=0.05, total 在容差内（96 >= 95）→ 完整(true)', async () => {
    const { repo } = makeRepoMock(() => [
      { __total: '96', __baseline: '100' },
    ]);

    const ok = await isDatasetComplete(repo, baselineConfigWithTolerance, '20260702');

    expect(ok).toBe(true);
  });

  it('toleranceRatio=0.05, total 低于容差线（94 < 95）→ 不完整(false)', async () => {
    const { repo } = makeRepoMock(() => [
      { __total: '94', __baseline: '100' },
    ]);

    const ok = await isDatasetComplete(repo, baselineConfigWithTolerance, '20260702');

    expect(ok).toBe(false);
  });

  it('不设 toleranceRatio（默认0），total 略低于 baseline → 不完整(false)', async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_basic',
      dateColumn: 'trade_date',
      baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
    };
    const { repo } = makeRepoMock(() => [
      { __total: '99', __baseline: '100' },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(false);
  });

  it("baseline='self' + toleranceRatio 无效，total>0 即完整(true)", async () => {
    const config: DatasetCompletenessConfig = {
      tableName: 'raw.daily_quote',
      dateColumn: 'trade_date',
      baseline: 'self',
      toleranceRatio: 0.05,
    };
    const { repo } = makeRepoMock(() => [
      { __total: '1' },
    ]);

    const ok = await isDatasetComplete(repo, config, '20260702');

    expect(ok).toBe(true);
  });
});
