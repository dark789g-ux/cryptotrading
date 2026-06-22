import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 统一 A 股指数日线行情（市场大盘 + 同花顺行业/概念）。
 *
 * 来源：
 *  - category='market'  → Tushare `index_daily`（000001.SH 等 8 个大盘）
 *  - category='industry' / 'concept' → Tushare `ths_daily`（原 ths_index_daily_quotes 迁移而来）
 *
 * 与旧 ThsIndexDailyQuoteEntity 的差异：
 *  - 去掉 `ths_` 前缀（统一表名）
 *  - 新增 `amount`（成交额千元，仅大盘有；行业/概念合法 NULL）
 *  - 新增 `category`（'market'|'industry'|'concept'，NOT NULL）
 *
 * - `vol_hand` 单位「手」，与 Tushare 原值一致（不换算；沿用旧列名避免重命名连锁）
 * - `total_mv_wan` / `float_mv_wan` 单位「万元」，由 Tushare 原值「元」÷ 10000 落库
 *
 * data-integrity 约束：
 *  - market 行：`total_mv_wan` / `float_mv_wan` / `turnover_rate` / `amount` 合法 NULL（指数无市值）
 *  - industry / concept 行：`total_mv_wan` / `float_mv_wan` / `turnover_rate` 硬约束非空
 *    （DB 层无法跨 category 表达条件 NOT NULL，由同步 fetcher + service 校验保证）
 */
@Entity('index_daily_quotes')
@Unique(['tsCode', 'tradeDate'])
@Index('idx_index_daily_quotes_category_tradedate', ['category', 'tradeDate'])
@Index('idx_index_daily_quotes_tscode_tradedate', ['tsCode', 'tradeDate'])
export class IndexDailyQuoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  open: number | null;

  @Column({ type: 'double precision', nullable: true })
  high: number | null;

  @Column({ type: 'double precision', nullable: true })
  low: number | null;

  @Column({ type: 'double precision', nullable: true })
  close: number | null;

  @Column({ name: 'pre_close', type: 'double precision', nullable: true })
  preClose: number | null;

  @Column({ type: 'double precision', nullable: true })
  change: number | null;

  @Column({ name: 'pct_change', type: 'double precision', nullable: true })
  pctChange: number | null;

  /** 成交量，单位「手」（Tushare 原始单位，不换算） */
  @Column({ name: 'vol_hand', type: 'double precision', nullable: true })
  volHand: number | null;

  /** 成交额，单位「千元」。仅大盘（index_daily）有；行业/概念（ths_daily）合法 NULL */
  @Column({ type: 'double precision', nullable: true })
  amount: number | null;

  /** 总市值，单位「万元」（Tushare 原值「元」÷ 10000）。仅行业/概念有 */
  @Column({ name: 'total_mv_wan', type: 'numeric', precision: 20, scale: 4, nullable: true })
  totalMvWan: string | null;

  /** 流通市值，单位「万元」（Tushare 原值「元」÷ 10000）。仅行业/概念有 */
  @Column({ name: 'float_mv_wan', type: 'numeric', precision: 20, scale: 4, nullable: true })
  floatMvWan: string | null;

  @Column({ name: 'turnover_rate', type: 'double precision', nullable: true })
  turnoverRate: number | null;

  /** 指数类别：'market' | 'industry' | 'concept' */
  @Column({ length: 8 })
  category: 'market' | 'industry' | 'concept';

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
