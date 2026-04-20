import {
  Entity, Column, PrimaryGeneratedColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { WatchlistEntity } from './watchlist.entity';

@Entity('watchlist_items')
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
}
