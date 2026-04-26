import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('a_share_filter_presets')
export class AShareFilterPresetEntity {
  @PrimaryColumn()
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ type: 'jsonb' })
  filters: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
