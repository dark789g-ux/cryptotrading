import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('index_weight')
@Index(['indexCode', 'conCode', 'effectiveDate'])
export class IndexWeightEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'index_code', length: 20 })
  indexCode: string;

  @Column({ name: 'con_code', length: 20 })
  conCode: string;

  @Column({ name: 'effective_date', length: 8 })
  effectiveDate: string;

  @Column({ name: 'expire_date', length: 8, nullable: true })
  expireDate: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 10, nullable: true })
  weight: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
