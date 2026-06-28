import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('custom_index_members')
@Unique(['versionId', 'conCode'])
@Index(['versionId'])
export class CustomIndexMemberEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'version_id', type: 'bigint' })
  versionId: string;

  @Column({ name: 'con_code', length: 20 })
  conCode: string;

  @Column({ type: 'numeric', precision: 20, scale: 10 })
  weight: string;
}
