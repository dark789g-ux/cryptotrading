import {
  Entity, Column, PrimaryGeneratedColumn,
  CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { StrategyEntity } from './strategy.entity';

@Entity('backtest_runs')
export class BacktestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'strategy_id' })
  strategyId: string;

  @ManyToOne(() => StrategyEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'strategy_id' })
  strategy: StrategyEntity;

  @Column({ nullable: true })
  timeframe: string;

  @Column({ name: 'date_start', nullable: true })
  dateStart: string;

  @Column({ name: 'date_end', nullable: true })
  dateEnd: string;

  // 本次回测的标的列表
  @Column({ type: 'jsonb', nullable: true })
  symbols: string[];

  // 汇总统计（总收益率、胜率、最大回撤等）
  @Column({ type: 'jsonb', nullable: true })
  stats: object;

  // 回测时所用的完整策略配置快照
  @Column({ name: 'config_snapshot', type: 'jsonb', nullable: true })
  configSnapshot: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
