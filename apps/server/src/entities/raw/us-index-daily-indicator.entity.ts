import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_index_indicator — 美股指数标准技术指标（17 列逐字对齐 raw.us_daily_indicator）。
 *
 * 整表照搬个股 17 列以最大化 calc_us_indicators / upsert_rows 复用；
 * ATR/low_9/high_9/stop_loss_pct/risk_reward_ratio 对「指数」语义略怪但无害，
 * 前端只渲染 MA/KDJ/MACD（见 spec 2026-06-16-us-index-subtab-design/01）。
 */
@Entity({ schema: 'raw', name: 'us_index_indicator' })
@Unique(['indexCode', 'tradeDate'])
export class UsIndexDailyIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'index_code' })
  indexCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  ma5: number;

  @Column({ type: 'double precision', nullable: true })
  ma30: number;

  @Column({ type: 'double precision', nullable: true })
  ma60: number;

  @Column({ type: 'double precision', nullable: true })
  ma120: number;

  @Column({ type: 'double precision', nullable: true })
  ma240: number;

  @Column({ type: 'double precision', nullable: true })
  bbi: number;

  @Column({ name: 'kdj_k', type: 'double precision', nullable: true })
  kdjK: number;

  @Column({ name: 'kdj_d', type: 'double precision', nullable: true })
  kdjD: number;

  @Column({ name: 'kdj_j', type: 'double precision', nullable: true })
  kdjJ: number;

  @Column({ type: 'double precision', nullable: true })
  dif: number;

  @Column({ type: 'double precision', nullable: true })
  dea: number;

  @Column({ type: 'double precision', nullable: true })
  macd: number;

  @Column({ name: 'atr_14', type: 'double precision', nullable: true })
  atr14: number;

  @Column({ name: 'low_9', type: 'double precision', nullable: true })
  low9: number;

  @Column({ name: 'high_9', type: 'double precision', nullable: true })
  high9: number;

  @Column({ name: 'stop_loss_pct', type: 'double precision', nullable: true })
  stopLossPct: number;

  @Column({ name: 'risk_reward_ratio', type: 'double precision', nullable: true })
  riskRewardRatio: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
