import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('a_share_filter_presets')
export class AShareFilterPresetEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column({ name: 'user_id', type: 'character varying', nullable: true })
  userId: string;

  @Column({ type: 'jsonb' })
  filters: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
