import { Column, Entity, PrimaryColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('user_preferences')
@Unique('uq_user_preferences_user_key', ['userId', 'key'])
export class UserPreferenceEntity {
  @PrimaryColumn({ type: 'character varying' })
  id: string;

  @Column({ name: 'user_id', type: 'character varying' })
  userId: string;

  @Column({ type: 'character varying' })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
