import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { BacktestRunEntity } from './backtest-run.entity';

/** 回测逐根 K 线快照记录，对应表 backtest_candle_logs */
@Entity('backtest_candle_logs')
@Index(['runId', 'barIdx'])
export class BacktestCandleLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 关联回测运行 ID */
  @Column({ name: 'run_id' })
  runId: string;

  @ManyToOne(() => BacktestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: BacktestRunEntity;

  /** 该 K 线在全局时间轴的序号（从 0 开始） */
  @Column({ name: 'bar_idx', type: 'int' })
  barIdx: number;

  /** K 线时间戳（UTC） */
  @Column({ type: 'timestamptz' })
  ts: Date;

  /** 该根 K 线开始时的组合净值 */
  @Column({ name: 'open_equity', type: 'numeric', precision: 20, scale: 4 })
  openEquity: string;

  /** 该根 K 线结束时的组合净值 */
  @Column({ name: 'close_equity', type: 'numeric', precision: 20, scale: 4 })
  closeEquity: string;

  /** 当前持仓数 */
  @Column({ name: 'pos_count', type: 'int' })
  posCount: number;

  /** 策略最大允许持仓数 */
  @Column({ name: 'max_positions', type: 'int' })
  maxPositions: number;

  /** 本根 K 线发生的入场记录（JSON 数组） */
  @Column({ name: 'entries_json', type: 'jsonb', default: () => "'[]'" })
  entriesJson: unknown[];

  /** 本根 K 线发生的出场记录（JSON 数组） */
  @Column({ name: 'exits_json', type: 'jsonb', default: () => "'[]'" })
  exitsJson: unknown[];

  /** 本根 K 线收盘后仍持有的标的 symbol 列表（与引擎 positions 一致） */
  @Column({ name: 'open_symbols_json', type: 'jsonb', default: () => "'[]'" })
  openSymbolsJson: string[];

  /** 当前是否处于冷却期 */
  @Column({ name: 'in_cooldown', type: 'boolean', default: false })
  inCooldown: boolean;

  /** 当前全局冷却期时长（根数），enableCooldown=false 时为 null */
  @Column({ name: 'cooldown_duration', type: 'int', nullable: true })
  cooldownDuration: number | null;

  /** 距冷却结束剩余根数，非冷却期为 0，enableCooldown=false 时为 null */
  @Column({ name: 'cooldown_remaining', type: 'int', nullable: true })
  cooldownRemaining: number | null;
}
