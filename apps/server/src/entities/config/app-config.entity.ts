import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('app_config')
export class AppConfigEntity {
  @PrimaryColumn()
  key: string;

  @Column({ type: 'jsonb' })
  value: any;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
