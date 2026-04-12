import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity('strategy_types')
export class StrategyTypeEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // JSON Schema，描述该策略类型的参数字段、类型、默认值、标签
  @Column({ name: 'param_schema', type: 'jsonb' })
  paramSchema: object;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
