import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Watchlist } from './watchlist.entity';

@Entity('watchlist_items')
export class WatchlistItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tsCode: string;

  @Column({ nullable: true })
  note: string;

  @Column({ default: 0 })
  sortOrder: number;

  @ManyToOne(() => Watchlist, watchlist => watchlist.items)
  @JoinColumn({ name: 'watchlistId' })
  watchlist: Watchlist;
}
