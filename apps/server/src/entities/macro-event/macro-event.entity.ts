import {
  Column, CreateDateColumn, Entity, Index,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// 宏观事件分类：货币 / 财政 / 经济数据 / 公司事件
export type MacroEventCategory = 'monetary' | 'fiscal' | 'data' | 'corporate';

// 重要性：低 / 中 / 高
export type MacroEventImportance = 'low' | 'mid' | 'high';

// 对应 spec § 4.2 macro_events 表
@Entity('macro_events')
export class MacroEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // 事件发生日历日（PG date 类型，无时区概念）
  @Index('idx_macro_events_date')
  @Column({ name: 'event_date', type: 'date' })
  eventDate: string;

  // 事件时间（time without time zone，nullable，全天事件可空）
  @Column({ name: 'event_time', type: 'time', nullable: true })
  eventTime: string | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 50 })
  category: MacroEventCategory;

  @Column({ type: 'varchar', length: 10 })
  importance: MacroEventImportance;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ name: 'source_url', type: 'varchar', length: 500, nullable: true })
  sourceUrl: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
