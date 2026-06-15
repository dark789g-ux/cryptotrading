import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_daily_indicator — 美股标准技术指标（输入前复权 qfq 价）。
 *
 * 仅标准 TA 子集；不含 A 股专属的砖块图(brick*)/活跃市值(amv_*)（见 spec 03）。
 */
@Entity({ schema: 'raw', name: 'us_daily_indicator' })
@Unique(['ticker', 'tradeDate'])
export class UsDailyIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  ticker: string;

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
