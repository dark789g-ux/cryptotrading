import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('custom_index_daily_indicators')
@Unique(['customIndexId', 'tradeDate'])
@Index(['customIndexId', 'tradeDate'])
export class CustomIndexDailyIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'custom_index_id', type: 'uuid' })
  customIndexId: string;

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

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
