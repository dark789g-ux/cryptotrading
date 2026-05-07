import { Entity, Column, PrimaryGeneratedColumn, Index, Unique } from 'typeorm';

@Entity('klines')
@Unique(['symbol', 'interval', 'openTime'])
export class KlineEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  symbol: string;

  @Index()
  @Column()
  interval: string;

  @Index()
  @Column({ name: 'open_time', type: 'timestamptz' })
  openTime: Date;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  open: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  high: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  low: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  close: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  volume: string;

  @Column({ name: 'close_time', type: 'timestamptz', nullable: true })
  closeTime: Date;

  @Column({ name: 'quote_volume', type: 'numeric', precision: 30, scale: 10, nullable: true })
  quoteVolume: string;

  @Column({ type: 'bigint', nullable: true })
  trades: string;

  @Column({ name: 'taker_buy_base_vol', type: 'numeric', precision: 30, scale: 10, nullable: true })
  takerBuyBaseVol: string;

  @Column({ name: 'taker_buy_quote_vol', type: 'numeric', precision: 30, scale: 10, nullable: true })
  takerBuyQuoteVol: string;

  // 指标列
  @Column({ name: 'dif', type: 'double precision', nullable: true })
  dif: number;

  @Column({ name: 'dea', type: 'double precision', nullable: true })
  dea: number;

  @Column({ name: 'macd', type: 'double precision', nullable: true })
  macd: number;

  @Column({ name: 'kdj_k', type: 'double precision', nullable: true })
  kdjK: number;

  @Column({ name: 'kdj_d', type: 'double precision', nullable: true })
  kdjD: number;

  @Column({ name: 'kdj_j', type: 'double precision', nullable: true })
  kdjJ: number;

  @Column({ name: 'bbi', type: 'double precision', nullable: true })
  bbi: number;

  @Column({ name: 'ma5', type: 'double precision', nullable: true })
  ma5: number;

  @Column({ name: 'ma30', type: 'double precision', nullable: true })
  ma30: number;

  @Column({ name: 'ma60', type: 'double precision', nullable: true })
  ma60: number;

  @Column({ name: 'ma120', type: 'double precision', nullable: true })
  ma120: number;

  @Column({ name: 'ma240', type: 'double precision', nullable: true })
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
}
