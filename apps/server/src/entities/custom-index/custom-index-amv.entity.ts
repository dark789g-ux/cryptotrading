import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('custom_index_amv')
export class CustomIndexAmvEntity {
  @PrimaryColumn({ name: 'custom_index_id', type: 'uuid' })
  customIndexId: string;

  @PrimaryColumn({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  amv: number | null;

  @Column({ name: 'amv_ma5', type: 'double precision', nullable: true })
  amvMa5: number | null;

  @Column({ name: 'amv_ma10', type: 'double precision', nullable: true })
  amvMa10: number | null;

  @Column({ name: 'amv_ma20', type: 'double precision', nullable: true })
  amvMa20: number | null;

  @Column({ name: 'amv_ma30', type: 'double precision', nullable: true })
  amvMa30: number | null;

  @Column({ name: 'amv_ma60', type: 'double precision', nullable: true })
  amvMa60: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
