import { Entity, PrimaryColumn, Column, OneToMany } from 'typeorm';
import { StockPrice } from './stock-price.entity';
import { Indicator } from './indicator.entity';

@Entity('stocks')
export class Stock {
  @PrimaryColumn()
  tsCode: string;  // Tushare 代码格式 000001.SZ

  @Column()
  symbol: string;  // 股票代码 000001

  @Column()
  name: string;

  @Column()
  area: string;

  @Column()
  industry: string;

  @Column()
  market: string;  // 主板/创业板/科创板

  @Column({ nullable: true })
  listDate: string;

  @OneToMany(() => StockPrice, price => price.stock)
  prices: StockPrice[];

  @OneToMany(() => Indicator, indicator => indicator.stock)
  indicators: Indicator[];
}
