import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm'

@Entity('oamv_daily')
@Index(['tradeDate'], { unique: true })
export class OamvDailyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'trade_date', type: 'varchar', length: 8 })
  tradeDate: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  open: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  high: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  low: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  close: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date
}
