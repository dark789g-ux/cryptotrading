/**
 * portfolio-sim.loader-sql.spec.ts
 *
 * 装载层「多因子 SQL 构建 + factorValues 组装」纯逻辑单测（spec 06）。
 *
 * 覆盖范围（可纯逻辑断言的部分）：
 *   - collectFactorColumns：column/computed 翻译、同列去重、未命中 KEY warn+跳过。
 *   - buildJoinTables：同表只 JOIN 一次（signal_rolling_indicator 三列合并）。
 *   - buildSourceTradesSql：基础列固定、因子列 AS alias、ml_score DISTINCT ON 去重子查询、
 *     momentum 三表跨 daily_quote/daily_indicator、keys 空不 JOIN。
 *   - buildFactorValues：column 直取 / computed compute、null 置位、空 keys → undefined。
 *
 * ⚠️ 注意（database-sql.md 教训）：本测试只断言 SQL 字符串构建与 JS 侧组装逻辑；
 *    真实 JOIN 行数翻倍 / 水合是否正确，mock 验不出，必须真机集成验证（见 spec 09）。
 */

import {
  buildFactorValues,
  buildJoinTables,
  buildSourceTradesSql,
  collectFactorColumns,
  columnAliasFor,
} from './portfolio-sim.loader-sql';
import { RankFactorKey } from './portfolio-sim.types';

describe('collectFactorColumns', () => {
  it('单 column 因子（pos_120）→ 一列，schema 缺省 public，alias=f_pos_120', () => {
    const cols = collectFactorColumns(['pos_120']);
    expect(cols).toEqual([
      {
        schema: 'public',
        table: 'signal_rolling_indicator',
        column: 'pos_120',
        alias: 'f_pos_120',
      },
    ]);
  });

  it('带 schema 的 column 因子（circ_mv）→ schema=raw', () => {
    const cols = collectFactorColumns(['circ_mv']);
    expect(cols).toEqual([
      {
        schema: 'raw',
        table: 'daily_basic',
        column: 'circ_mv',
        alias: 'f_circ_mv',
      },
    ]);
  });

  it('computed 因子（momentum_60）→ 展开 3 needs，alias 用 needs 自带（mom_*）', () => {
    const cols = collectFactorColumns(['momentum_60']);
    expect(cols).toEqual([
      { schema: 'raw', table: 'daily_quote', column: 'qfq_close', alias: 'mom_close' },
      { schema: 'raw', table: 'daily_indicator', column: 'ma60', alias: 'mom_ma60' },
      { schema: 'raw', table: 'daily_indicator', column: 'atr_14', alias: 'mom_atr' },
    ]);
  });

  it('同 (schema,table,column) 不重复 SELECT（防御去重）', () => {
    // pos_120 出现两次 → 仅一列
    const cols = collectFactorColumns(['pos_120', 'pos_120']);
    expect(cols).toHaveLength(1);
  });

  it('未命中注册表的 KEY → onUnknown 回调 + 跳过（不进列集）', () => {
    const unknown: string[] = [];
    const cols = collectFactorColumns(
      ['pos_120', 'bogus_factor' as RankFactorKey],
      (k) => unknown.push(k),
    );
    expect(unknown).toEqual(['bogus_factor']);
    expect(cols).toHaveLength(1);
    expect(cols[0].column).toBe('pos_120');
  });

  it('空 keys → 空列集', () => {
    expect(collectFactorColumns([])).toEqual([]);
  });
});

describe('buildJoinTables（同表只 JOIN 一次）', () => {
  it('signal_rolling_indicator 三因子 → 一张表三列，joinAlias=j0', () => {
    const cols = collectFactorColumns(['pos_60', 'close_ma60_ratio', 'vol_ratio_60']);
    const tables = buildJoinTables(cols);
    expect(tables).toHaveLength(1);
    expect(tables[0].schema).toBe('public');
    expect(tables[0].table).toBe('signal_rolling_indicator');
    expect(tables[0].joinAlias).toBe('j0');
    expect(tables[0].columns.map((c) => c.column)).toEqual([
      'pos_60',
      'close_ma60_ratio',
      'vol_ratio_60',
    ]);
  });

  it('momentum_60 + risk_reward → daily_indicator 只 JOIN 一次（ma60+atr_14+risk_reward_ratio 合并）', () => {
    const cols = collectFactorColumns(['momentum_60', 'risk_reward']);
    const tables = buildJoinTables(cols);
    // daily_quote(j0) + daily_indicator(j1) 共 2 张表
    expect(tables).toHaveLength(2);
    const di = tables.find((t) => t.table === 'daily_indicator')!;
    expect(di.schema).toBe('raw');
    expect(di.columns.map((c) => c.column).sort()).toEqual([
      'atr_14',
      'ma60',
      'risk_reward_ratio',
    ]);
  });

  it('joinAlias 按出现顺序 j0/j1（确定性）', () => {
    const cols = collectFactorColumns(['pos_120', 'circ_mv']);
    const tables = buildJoinTables(cols);
    expect(tables.map((t) => t.joinAlias)).toEqual(['j0', 'j1']);
  });
});

describe('buildSourceTradesSql', () => {
  it('keys 空 → 不 JOIN，只取基础列', () => {
    const { sql, columns } = buildSourceTradesSql([]);
    expect(columns).toEqual([]);
    expect(sql).toContain('FROM signal_test_trade t');
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toContain('WHERE t.run_id = $1');
    // 基础 6 列齐全
    expect(sql).toContain('t.ts_code AS "tsCode"');
    expect(sql).toContain('t.signal_date AS "signalDate"');
    expect(sql).toContain('t.buy_date AS "buyDate"');
    expect(sql).toContain('t.exit_date AS "exitDate"');
    expect(sql).toContain('t.ret AS "ret"');
    expect(sql).toContain('t.hold_days AS "holdDays"');
  });

  it('单因子 pos_120 → LEFT JOIN signal_rolling_indicator 取 j0.pos_120 AS "f_pos_120"', () => {
    const { sql } = buildSourceTradesSql(['pos_120']);
    // public schema 显式前缀（确定性、合法 PG）
    expect(sql).toContain(
      'LEFT JOIN public.signal_rolling_indicator j0 ON j0.ts_code = t.ts_code AND j0.trade_date = t.signal_date',
    );
    expect(sql).toContain('j0.pos_120 AS "f_pos_120"');
    // 参数化：只用 $1，无前端字段名出现在 JOIN 拼接位（表/列均注册表常量）
    expect((sql.match(/\$1/g) || []).length).toBe(1);
  });

  it('多因子同表合并：三列只一个 LEFT JOIN signal_rolling_indicator', () => {
    const { sql } = buildSourceTradesSql([
      'pos_60',
      'close_ma60_ratio',
      'vol_ratio_60',
    ]);
    const joinCount = (
      sql.match(/LEFT JOIN public\.signal_rolling_indicator/g) || []
    ).length;
    expect(joinCount).toBe(1);
    expect(sql).toContain('j0.pos_60 AS "f_pos_60"');
    expect(sql).toContain('j0.close_ma60_ratio AS "f_close_ma60_ratio"');
    expect(sql).toContain('j0.vol_ratio_60 AS "f_vol_ratio_60"');
  });

  it('ml_score → DISTINCT ON 去重子查询（pin 每键最新模型，防行数翻倍）', () => {
    const { sql } = buildSourceTradesSql(['ml_score']);
    // 子查询去重：DISTINCT ON (trade_date, ts_code) + model_version DESC pin 最新
    expect(sql).toContain('SELECT DISTINCT ON (trade_date, ts_code)');
    expect(sql).toContain('FROM ml.scores_daily');
    expect(sql).toContain(
      'ORDER BY trade_date, ts_code, model_version DESC, rank_in_day ASC',
    );
    // 别名 alias 仍是 f_ml_score（取子查询的 score 列）
    expect(sql).toContain('.score AS "f_ml_score"');
  });

  it('momentum_60 三表 JOIN：daily_quote(qfq_close) + daily_indicator(ma60/atr_14)', () => {
    const { sql } = buildSourceTradesSql(['momentum_60']);
    expect(sql).toContain('LEFT JOIN raw.daily_quote');
    expect(sql).toContain('LEFT JOIN raw.daily_indicator');
    expect(sql).toContain('qfq_close AS "mom_close"');
    expect(sql).toContain('ma60 AS "mom_ma60"');
    expect(sql).toContain('atr_14 AS "mom_atr"');
  });

  it('未命中 KEY → onUnknown 触发，SQL 不含该 KEY 文本（不拼前端串）', () => {
    const unknown: string[] = [];
    const { sql } = buildSourceTradesSql(
      ['pos_120', 'evil); DROP TABLE--' as RankFactorKey],
      (k) => unknown.push(k),
    );
    expect(unknown).toEqual(['evil); DROP TABLE--']);
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('evil');
  });
});

describe('buildFactorValues', () => {
  it('空 keys → undefined', () => {
    expect(buildFactorValues([], {})).toBeUndefined();
  });

  it('column 因子直取（pg numeric=string）→ parseNumericString', () => {
    const out = buildFactorValues(['pos_120'], { f_pos_120: '0.42' })!;
    expect(out.pos_120).toBeCloseTo(0.42, 12);
  });

  it('column 因子（double=number）→ 直接取数', () => {
    const out = buildFactorValues(['circ_mv'], { f_circ_mv: 123.45 })!;
    expect(out.circ_mv).toBeCloseTo(123.45, 12);
  });

  it('column 因子 LEFT JOIN 未命中（null / 缺键）→ null', () => {
    expect(buildFactorValues(['pos_120'], { f_pos_120: null })!.pos_120).toBeNull();
    expect(buildFactorValues(['pos_120'], {})!.pos_120).toBeNull();
  });

  it('computed momentum_60：(close-ma60)/atr 手算', () => {
    // (12 - 10) / 4 = 0.5
    const out = buildFactorValues(['momentum_60'], {
      mom_close: '12',
      mom_ma60: '10',
      mom_atr: '4',
    })!;
    expect(out.momentum_60).toBeCloseTo(0.5, 12);
  });

  it('computed momentum_60：atr=0 → null（不 ÷0）', () => {
    const out = buildFactorValues(['momentum_60'], {
      mom_close: '12',
      mom_ma60: '10',
      mom_atr: '0',
    })!;
    expect(out.momentum_60).toBeNull();
  });

  it('computed momentum_60：任一输入 null → null', () => {
    expect(
      buildFactorValues(['momentum_60'], {
        mom_close: null,
        mom_ma60: '10',
        mom_atr: '4',
      })!.momentum_60,
    ).toBeNull();
    expect(
      buildFactorValues(['momentum_60'], {
        mom_close: '12',
        mom_ma60: null,
        mom_atr: '4',
      })!.momentum_60,
    ).toBeNull();
  });

  it('多因子同行组装：各因子独立取值（含 null 殿后语义留给引擎）', () => {
    const out = buildFactorValues(['pos_120', 'circ_mv', 'momentum_60'], {
      f_pos_120: '0.3',
      f_circ_mv: null, // 缺值
      mom_close: '11',
      mom_ma60: '10',
      mom_atr: '2',
    })!;
    expect(out.pos_120).toBeCloseTo(0.3, 12);
    expect(out.circ_mv).toBeNull();
    expect(out.momentum_60).toBeCloseTo(0.5, 12); // (11-10)/2
  });

  it('未命中注册表的 KEY → 跳过（不进 out）', () => {
    const out = buildFactorValues(
      ['pos_120', 'bogus' as RankFactorKey],
      { f_pos_120: '0.1' },
    )!;
    expect(out.pos_120).toBeCloseTo(0.1, 12);
    expect('bogus' in out).toBe(false);
  });
});

describe('columnAliasFor', () => {
  it('稳定别名 f_<key>', () => {
    expect(columnAliasFor('pos_120')).toBe('f_pos_120');
    expect(columnAliasFor('ml_score')).toBe('f_ml_score');
  });
});
