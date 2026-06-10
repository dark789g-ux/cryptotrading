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

  /** 0AMV 收盘序列的通达信式 MACD（12/26/9），sync 后全量重算落库；递推自序列首行起即有值，头部约 80 交易日未收敛 */
  @Column({ name: 'amv_dif', type: 'double precision', nullable: true })
  amvDif: number | null

  @Column({ name: 'amv_dea', type: 'double precision', nullable: true })
  amvDea: number | null

  /** MACD 柱 = 2×(DIF-DEA) */
  @Column({ name: 'amv_macd', type: 'double precision', nullable: true })
  amvMacd: number | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date
}
