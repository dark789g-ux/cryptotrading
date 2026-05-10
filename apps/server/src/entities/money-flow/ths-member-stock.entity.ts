import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('ths_member_stocks')
@Unique(['tsCode', 'conCode'])
export class ThsMemberStockEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'con_code', length: 20 })
  conCode: string;

  @Column({ name: 'con_name', length: 50, nullable: true })
  conName: string | null;

  @Column({ name: 'is_new', length: 2, nullable: true })
  isNew: string | null;
}
