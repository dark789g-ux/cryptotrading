import {
  Entity, Column, PrimaryGeneratedColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { SymbolPresetEntity } from './symbol-preset.entity';

@Entity('symbol_preset_items')
export class SymbolPresetItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'preset_id' })
  presetId: string;

  @ManyToOne(() => SymbolPresetEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'preset_id' })
  preset: SymbolPresetEntity;

  @Column()
  symbol: string;
}
