import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('a_share_daily_indicators')
@Unique(['tsCode', 'tradeDate'])
export class AShareDailyIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code' })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  dif: number;

  @Column({ type: 'double precision', nullable: true })
  dea: number;

  @Column({ type: 'double precision', nullable: true })
  macd: number;

  @Column({ name: 'kdj_k', type: 'double precision', nullable: true })
  kdjK: number;

  @Column({ name: 'kdj_d', type: 'double precision', nullable: true })
  kdjD: number;

  @Column({ name: 'kdj_j', type: 'double precision', nullable: true })
  kdjJ: number;

  @Column({ type: 'double precision', nullable: true })
  bbi: number;

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

  @Column({ name: 'quote_volume_10', type: 'double precision', nullable: true })
  quoteVolume10: number;

  @Column({ name: 'atr_14', type: 'double precision', nullable: true })
  atr14: number;

  @Column({ name: 'loss_atr_14', type: 'double precision', nullable: true })
  lossAtr14: number;

  @Column({ name: 'low_9', type: 'double precision', nullable: true })
  low9: number;

  @Column({ name: 'high_9', type: 'double precision', nullable: true })
  high9: number;

  @Column({ name: 'stop_loss_pct', type: 'double precision', nullable: true })
  stopLossPct: number;

  @Column({ name: 'risk_reward_ratio', type: 'double precision', nullable: true })
  riskRewardRatio: number;

  @Column({ type: 'double precision', nullable: true })
  brick: number;

  @Column({ name: 'brick_delta', type: 'double precision', nullable: true })
  brickDelta: number;

  @Column({ name: 'brick_xg', type: 'boolean', nullable: true })
  brickXg: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
