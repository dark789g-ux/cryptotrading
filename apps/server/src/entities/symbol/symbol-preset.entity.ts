import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { SymbolPresetItemEntity } from './symbol-preset-item.entity';

@Entity('symbol_presets')
export class SymbolPresetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'user_id', type: 'character varying', nullable: true })
  userId: string;

  @OneToMany(() => SymbolPresetItemEntity, (item) => item.preset, { cascade: true })
  items: SymbolPresetItemEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
