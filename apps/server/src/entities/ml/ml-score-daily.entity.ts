import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `ml.scores_daily`：按 (trade_date, ts_code, model_version) 存的当日打分。
 *
 * - trade_date 为 char(8) YYYYMMDD（A 股规范，与 raw.daily_quote 一致）
 * - rank_in_day 避开 PG 关键字 `rank`（窗口函数同名会触发 parser 歧义）
 * - M2 仅声明只读 entity，read controller 留 M3
 */
@Entity({ schema: 'ml', name: 'scores_daily' })
@Index(['tradeDate', 'modelVersion', 'rankInDay'])
export class MlScoreDailyEntity {
  @PrimaryColumn({ name: 'trade_date', type: 'char', length: 8 })
  tradeDate: string;

  @PrimaryColumn({ name: 'ts_code', type: 'varchar', length: 16 })
  tsCode: string;

  @PrimaryColumn({ name: 'model_version', type: 'text' })
  modelVersion: string;

  @Column({ name: 'score', type: 'double precision' })
  score: number;

  @Column({ name: 'rank_in_day', type: 'integer' })
  rankInDay: number;
}
