import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type RegimeKey = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface RegimeConfigEntry {
  /** 'trade' | 'flat' | 'unknown' */
  action: string;
  /** optional condition set or any extra config */
  [key: string]: unknown;
}

export type RegimeConfigMap = Record<RegimeKey, RegimeConfigEntry>;

@Entity('regime_strategy_config')
export class RegimeStrategyConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', unique: true })
  version: number;

  /** 'draft' | 'active' | 'archived' */
  @Column({ type: 'varchar', length: 10 })
  status: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'jsonb' })
  config: RegimeConfigMap;
}
