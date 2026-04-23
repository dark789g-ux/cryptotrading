import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('symbols')
export class SymbolEntity {
  @PrimaryColumn()
  symbol: string;

  @Column({ name: 'base_asset', nullable: true })
  baseAsset: string;

  @Column({ name: 'quote_asset', nullable: true })
  quoteAsset: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'sync_enabled', default: false })
  syncEnabled: boolean;

  @Column({ name: 'is_excluded', default: false })
  isExcluded: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
