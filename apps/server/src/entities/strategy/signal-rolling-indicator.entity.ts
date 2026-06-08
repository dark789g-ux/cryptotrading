import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('signal_rolling_indicator')
@Unique('uq_signal_rolling_indicator_code_date', ['tsCode', 'tradeDate'])
@Index('idx_signal_rolling_indicator_code_date', ['tsCode', 'tradeDate'])
export class SignalRollingIndicatorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code' })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'pos_120', type: 'double precision', nullable: true })
  pos120: number | null;

  @Column({ name: 'pos_60', type: 'double precision', nullable: true })
  pos60: number | null;

  @Column({ name: 'close_ma60_ratio', type: 'double precision', nullable: true })
  closeMa60Ratio: number | null;

  @Column({ name: 'vol_ratio_60', type: 'double precision', nullable: true })
  volRatio60: number | null;

  @Column({ name: 'vol_ratio_120', type: 'double precision', nullable: true })
  volRatio120: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
