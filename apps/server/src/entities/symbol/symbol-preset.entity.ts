import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { SymbolPresetItemEntity } from './symbol-preset-item.entity';

@Entity('symbol_presets')
export class SymbolPresetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @OneToMany(() => SymbolPresetItemEntity, (item) => item.preset, { cascade: true })
  items: SymbolPresetItemEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
