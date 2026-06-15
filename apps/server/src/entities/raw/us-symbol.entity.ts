import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * raw.us_symbol — 美股精选清单 + tracked 标记位。
 *
 * Python（CSV 播种 / P2 全名单同步）写 ticker/name/theme/stock_type，
 * NestJS 只改 tracked（见 spec 05）。
 */
@Entity({ schema: 'raw', name: 'us_symbol' })
@Unique(['ticker'])
export class UsSymbolEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  ticker: string;

  @Column({ nullable: true })
  name: string;

  @Column({ nullable: true })
  theme: string;

  @Column({ name: 'stock_type', nullable: true })
  stockType: string;

  @Index()
  @Column({ type: 'boolean', default: false })
  tracked: boolean;

  @Column({ name: 'list_date', length: 8, nullable: true })
  listDate: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
