import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 统一 A 股指数日线技术指标（市场大盘 + 同花顺行业/概念）。
 *
 * 与 raw.daily_indicator 的子集对齐：去掉个股交易专用项
 * （ATR / quote_volume_10 / stop_loss_pct / risk_reward_ratio / low_9 / high_9 / loss_atr_14），
 * 保留 MA / MACD / KDJ / BBI / BRICK。
 *
 * 与旧 ThsIndexDailyIndicatorEntity 的差异：去 `ths_` 前缀 + 新增 `category`。
 */
@Entity('index_daily_indicators')
@Unique(['tsCode', 'tradeDate'])
@Index('idx_index_daily_indicators_category_tradedate', ['category', 'tradeDate'])
@Index('idx_index_daily_indicators_tscode_tradedate', ['tsCode', 'tradeDate'])
export class IndexDailyIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  ma5: number | null;

  @Column({ type: 'double precision', nullable: true })
  ma30: number | null;

  @Column({ type: 'double precision', nullable: true })
  ma60: number | null;

  @Column({ type: 'double precision', nullable: true })
  ma120: number | null;

  @Column({ type: 'double precision', nullable: true })
  ma240: number | null;

  @Column({ type: 'double precision', nullable: true })
  dif: number | null;

  @Column({ type: 'double precision', nullable: true })
  dea: number | null;

  @Column({ type: 'double precision', nullable: true })
  macd: number | null;

  @Column({ name: 'kdj_k', type: 'double precision', nullable: true })
  kdjK: number | null;

  @Column({ name: 'kdj_d', type: 'double precision', nullable: true })
  kdjD: number | null;

  @Column({ name: 'kdj_j', type: 'double precision', nullable: true })
  kdjJ: number | null;

  @Column({ type: 'double precision', nullable: true })
  bbi: number | null;

  @Column({ type: 'double precision', nullable: true })
  brick: number | null;

  @Column({ name: 'brick_delta', type: 'double precision', nullable: true })
  brickDelta: number | null;

  @Column({ name: 'brick_xg', type: 'boolean', nullable: true })
  brickXg: boolean | null;

  @Column({ type: 'double precision', nullable: true })
  obv5d: number | null;

  @Column({ type: 'double precision', nullable: true })
  obv10d: number | null;

  @Column({ type: 'double precision', nullable: true })
  obv20d: number | null;

  /** 指数类别：'market' | 'industry' | 'concept' | 'sw'（申万行业指数） */
  @Column({ length: 8 })
  category: 'market' | 'industry' | 'concept' | 'sw';

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
