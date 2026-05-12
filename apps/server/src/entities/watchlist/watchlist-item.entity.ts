import {
  Entity, Column, PrimaryGeneratedColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { WatchlistEntity } from './watchlist.entity';

@Entity('watchlist_items')
@Unique('uq_watchlist_items_watchlist_symbol', ['watchlistId', 'symbol'])
export class WatchlistItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'watchlist_id' })
  watchlistId: string;

  @ManyToOne(() => WatchlistEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'watchlist_id' })
  watchlist: WatchlistEntity;

  @Column()
  symbol: string;

  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;
}
