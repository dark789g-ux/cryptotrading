import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * signal-rolling-indicator.service.ts
 *
 * 预计算 5 个滚动指标（pos_120 / pos_60 / close_ma60_ratio / vol_ratio_60 / vol_ratio_120），
 * 复刻外部「底部放天量涨停」模板。窗口按 bar 根数（ROWS … PRECEDING），底部三项用 qfq、
 * 天量两项用原始 vol，每项按各自窗口 COUNT(*) 门控（不满 N 根 → NULL）。
 *
 * 口径基准（**逐字照搬**）：
 *   docs/superpowers/specs/2026-06-09-signal-rolling-indicators-design/02-data-model-and-sql.md
 * 列名已落 entities/raw/daily-quote.entity.ts 核实（ts_code/trade_date/qfq_low/qfq_high/qfq_close/vol）。
 */

/** 全量回填按 ts_code 分批，每批约 400 只（避免单条巨查询占满内存 / 长事务）。 */
const BACKFILL_BATCH = 400;

/** 全量回填返回结构。 */
export interface BackfillResult {
  tsCodeCount: number;
  batchCount: number;
}

/** 脏重算返回结构。 */
export interface RecalculateDirtyResult {
  dirtyCount: number;
}

@Injectable()
export class SignalRollingIndicatorService {
  private readonly logger = new Logger(SignalRollingIndicatorService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 构造窗口 upsert SQL（参数化）。核心即 spec 02 的「回填 SQL」。
   *
   * - tsCodeFilter=true：内层 raw.daily_quote 加 `ts_code = ANY($1::text[])`，把窗口限定到给定标的；
   * - dateFloor=true：**外层**（窗口算完后）加 `WHERE trade_date >= $N`，让窗口仍看到 dirty 日之前的
   *   全部历史（保证 120 根回看完整），只 upsert dirty 日及之后的行。
   *
   * 参数顺序：tsCodeFilter 占 $1（text[]），dateFloor 占其后的下一个占位符。
   */
  private buildWindowUpsertSql(opts: {
    tsCodeFilter: boolean;
    dateFloor: boolean;
  }): string {
    const innerWhere = opts.tsCodeFilter ? 'WHERE ts_code = ANY($1::text[])' : '';
    // dateFloor 占位符：有 tsCodeFilter 时是 $2，否则是 $1。
    const dateParam = opts.tsCodeFilter ? '$2' : '$1';
    const outerWhere = opts.dateFloor ? `WHERE trade_date >= ${dateParam}` : '';

    return `INSERT INTO signal_rolling_indicator
  (ts_code, trade_date, pos_120, pos_60, close_ma60_ratio, vol_ratio_60, vol_ratio_120)
SELECT ts_code, trade_date,
  CASE WHEN n120 = 120 THEN (qfq_close - low_120) / (high_120 - low_120 + 1e-10) END,
  CASE WHEN n60  = 60  THEN (qfq_close - low_60)  / (high_60  - low_60  + 1e-10) END,
  CASE WHEN n60  = 60  THEN qfq_close / NULLIF(ma60q, 0) END,
  CASE WHEN n60  = 60  THEN vol / (avgvol60  + 1) END,
  CASE WHEN n120 = 120 THEN vol / (avgvol120 + 1) END
FROM (
  SELECT ts_code, trade_date, qfq_close, vol,
    MIN(qfq_low)   OVER w120 AS low_120,
    MAX(qfq_high)  OVER w120 AS high_120,
    COUNT(*)       OVER w120 AS n120,
    AVG(vol)       OVER w120 AS avgvol120,
    MIN(qfq_low)   OVER w60  AS low_60,
    MAX(qfq_high)  OVER w60  AS high_60,
    COUNT(*)       OVER w60  AS n60,
    AVG(qfq_close) OVER w60  AS ma60q,
    AVG(vol)       OVER w60  AS avgvol60
  FROM raw.daily_quote
  ${innerWhere}
  WINDOW
    w120 AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 119 PRECEDING AND CURRENT ROW),
    w60  AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 59  PRECEDING AND CURRENT ROW)
) s
${outerWhere}
ON CONFLICT (ts_code, trade_date) DO UPDATE SET
  pos_120 = EXCLUDED.pos_120, pos_60 = EXCLUDED.pos_60,
  close_ma60_ratio = EXCLUDED.close_ma60_ratio,
  vol_ratio_60 = EXCLUDED.vol_ratio_60, vol_ratio_120 = EXCLUDED.vol_ratio_120,
  updated_at = now()`;
  }

  /**
   * 全量回填。取全市场 ts_code 后按 ~400 只一批跑窗口 upsert（无 date floor，重算全史）。
   * 这是重负载操作（A股全 history × 全市场），由 controller @AdminOnly 守护。
   */
  async backfillAll(): Promise<BackfillResult> {
    const codeRows = await this.dataSource.query<Array<{ ts_code: string }>>(
      `SELECT DISTINCT ts_code FROM raw.daily_quote ORDER BY ts_code`,
    );
    const tsCodes = codeRows.map((r) => r.ts_code).filter(Boolean);
    const tsCodeCount = tsCodes.length;

    if (tsCodeCount === 0) {
      this.logger.warn('backfillAll：raw.daily_quote 无任何 ts_code，跳过');
      return { tsCodeCount: 0, batchCount: 0 };
    }

    const batchCount = Math.ceil(tsCodeCount / BACKFILL_BATCH);
    const sql = this.buildWindowUpsertSql({ tsCodeFilter: true, dateFloor: false });

    this.logger.log(
      `backfillAll 开始：${tsCodeCount} 只标的，分 ${batchCount} 批（每批 ${BACKFILL_BATCH}）`,
    );

    let affectedTotal = 0;
    for (let i = 0; i < tsCodeCount; i += BACKFILL_BATCH) {
      const batchIndex = Math.floor(i / BACKFILL_BATCH) + 1;
      const batchTsCodes = tsCodes.slice(i, i + BACKFILL_BATCH);
      const result = await this.dataSource.query(sql, [batchTsCodes]);
      // node-postgres 对 INSERT…ON CONFLICT 返回 rowCount，但 typeorm dataSource.query 取不到统一值；
      // 退而求其次按返回数组长度估计（部分驱动返回受影响行数组为空，仅作进度参考）。
      const affected = Array.isArray(result) ? result.length : 0;
      affectedTotal += affected;
      this.logger.log(
        `backfillAll 进度：批 ${batchIndex}/${batchCount}（${batchTsCodes.length} 只），累计返回行 ${affectedTotal}`,
      );
    }

    this.logger.log(`backfillAll 完成：${tsCodeCount} 只 / ${batchCount} 批`);
    return { tsCodeCount, batchCount };
  }

  /**
   * 增量 / 脏重算。读 a_share_sync_states.signal_rolling_dirty_from_date 非空的标的，
   * 逐只跑窗口 upsert（窗口看该股全史、仅 upsert trade_date >= dirtyFrom），成功后清脏。
   *
   * @param tsCodes 可选限定（只重算这些标的的脏）；不传则全部脏标的。
   */
  async recalculateDirtyForSymbols(
    tsCodes?: string[],
  ): Promise<RecalculateDirtyResult> {
    let dirtyRows: Array<{ ts_code: string; dirty_from: string }>;
    if (tsCodes && tsCodes.length > 0) {
      const uniqueCodes = Array.from(new Set(tsCodes));
      dirtyRows = await this.dataSource.query(
        `SELECT ts_code, signal_rolling_dirty_from_date AS dirty_from
           FROM a_share_sync_states
          WHERE signal_rolling_dirty_from_date IS NOT NULL
            AND ts_code = ANY($1::text[])`,
        [uniqueCodes],
      );
    } else {
      dirtyRows = await this.dataSource.query(
        `SELECT ts_code, signal_rolling_dirty_from_date AS dirty_from
           FROM a_share_sync_states
          WHERE signal_rolling_dirty_from_date IS NOT NULL`,
      );
    }

    if (dirtyRows.length === 0) {
      this.logger.log('recalculateDirtyForSymbols：无脏标的，跳过');
      return { dirtyCount: 0 };
    }

    this.logger.log(
      `recalculateDirtyForSymbols 开始：${dirtyRows.length} 只脏标的`,
    );

    const sql = this.buildWindowUpsertSql({ tsCodeFilter: true, dateFloor: true });
    const cleared: string[] = [];

    for (const row of dirtyRows) {
      const tsCode = row.ts_code;
      const dirtyFrom = row.dirty_from;
      try {
        // 窗口看该股全史（tsCodeFilter 限到该股，不加 date 内层下界），仅 upsert trade_date >= dirtyFrom。
        await this.dataSource.query(sql, [[tsCode], dirtyFrom]);
        cleared.push(tsCode);
      } catch (err) {
        // 禁止静默吞错（data-integrity）：日志打印具体标的与错误，不清脏，留待下次重算。
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `recalculateDirtyForSymbols ${tsCode}（dirtyFrom=${dirtyFrom}）失败：${msg}`,
        );
        if (err instanceof Error && err.stack) this.logger.error(err.stack);
      }
    }

    // 只清成功重算的标的脏标记。
    if (cleared.length > 0) {
      await this.dataSource.query(
        `UPDATE a_share_sync_states
            SET signal_rolling_dirty_from_date = NULL
          WHERE ts_code = ANY($1::text[])`,
        [cleared],
      );
    }

    this.logger.log(
      `recalculateDirtyForSymbols 完成：${dirtyRows.length} 只脏标的，成功清脏 ${cleared.length} 只`,
    );
    return { dirtyCount: dirtyRows.length };
  }
}
