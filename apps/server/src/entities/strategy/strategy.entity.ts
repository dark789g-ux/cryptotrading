import {
  Entity, Column, PrimaryGeneratedColumn,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { StrategyTypeEntity } from './strategy-type.entity';

@Entity('strategies')
export class StrategyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'type_id' })
  typeId: string;

  @Column({ name: 'user_id', type: 'character varying', nullable: true })
  userId: string;

  @ManyToOne(() => StrategyTypeEntity)
  @JoinColumn({ name: 'type_id' })
  type: StrategyTypeEntity;

  // BacktestConfig 全部字段
  @Column({ type: 'jsonb' })
  params: object;

  // 上次选择的回测标的列表
  @Column({ type: 'jsonb', nullable: true })
  symbols: string[];

  @Column({ name: 'last_backtest_at', type: 'timestamptz', nullable: true })
  lastBacktestAt: Date;

  @Column({ name: 'last_backtest_return', type: 'double precision', nullable: true })
  lastBacktestReturn: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
