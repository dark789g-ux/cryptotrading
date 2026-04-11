import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Stock } from './stock.entity';

@Entity('indicators')
@Index(['tsCode', 'tradeDate'])
export class Indicator {
  @PrimaryColumn()
  tsCode: string;

  @PrimaryColumn()
  tradeDate: string;

  // MA 均线
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  ma5: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  ma10: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  ma20: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  ma60: number;

  // MACD
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  macdDif: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  macdDea: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  macdBar: number;

  // KDJ
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  kdjK: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  kdjD: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  kdjJ: number;

  // RSI
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  rsi6: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  rsi12: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  rsi24: number;

  // 布林带
  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  bollUpper: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  bollMid: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  bollLower: number;

  @ManyToOne(() => Stock, stock => stock.indicators)
  @JoinColumn({ name: 'tsCode' })
  stock: Stock;
}
