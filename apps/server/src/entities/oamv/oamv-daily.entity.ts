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

  /** MA5（严格 SMA，不足5行为 null） */
  @Column({ name: 'ma5', type: 'double precision', nullable: true })
  ma5: number | null

  /** MA30（严格 SMA，不足30行为 null） */
  @Column({ name: 'ma30', type: 'double precision', nullable: true })
  ma30: number | null

  /** MA60（严格 SMA，不足60行为 null） */
  @Column({ name: 'ma60', type: 'double precision', nullable: true })
  ma60: number | null

  /** MA120（严格 SMA，不足120行为 null） */
  @Column({ name: 'ma120', type: 'double precision', nullable: true })
  ma120: number | null

  /** MA240（严格 SMA，不足240行为 null） */
  @Column({ name: 'ma240', type: 'double precision', nullable: true })
  ma240: number | null

  /** KDJ K 值（9日周期，初始种子 50） */
  @Column({ name: 'kdj_k', type: 'double precision', nullable: true })
  kdjK: number | null

  /** KDJ D 值 */
  @Column({ name: 'kdj_d', type: 'double precision', nullable: true })
  kdjD: number | null

  /** KDJ J 值 = 3K - 2D */
  @Column({ name: 'kdj_j', type: 'double precision', nullable: true })
  kdjJ: number | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date
}
