import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('regime_daily_pick')
export class RegimeDailyPickEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 8, name: 'trade_date' })
  tradeDate: string;

  /** 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'unknown' */
  @Column({ type: 'varchar', length: 8 })
  regime: string;

  @Column({ type: 'int', nullable: true, name: 'config_version' })
  configVersion: number | null;

  /** 'trade' | 'flat' | 'unknown' */
  @Column({ type: 'varchar', length: 8 })
  action: string;

  @Column({ type: 'varchar', length: 30, nullable: true, name: 'ts_code' })
  tsCode: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  name: string | null;

  @Column({ type: 'jsonb', nullable: true })
  snapshot: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
