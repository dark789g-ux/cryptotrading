import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Stock } from './stock.entity';

@Entity('stock_prices')
@Index(['tsCode', 'tradeDate'])
export class StockPrice {
  @PrimaryColumn()
  tsCode: string;

  @PrimaryColumn()
  tradeDate: string;

  @Column('decimal', { precision: 10, scale: 2 })
  open: number;

  @Column('decimal', { precision: 10, scale: 2 })
  high: number;

  @Column('decimal', { precision: 10, scale: 2 })
  low: number;

  @Column('decimal', { precision: 10, scale: 2 })
  close: number;

  @Column('decimal', { precision: 15, scale: 2 })
  vol: number;  // 成交量（手）

  @Column('decimal', { precision: 15, scale: 2 })
  amount: number;  // 成交额（千元）

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  pctChg: number;  // 涨跌幅

  @ManyToOne(() => Stock, stock => stock.prices)
  @JoinColumn({ name: 'tsCode' })
  stock: Stock;
}
