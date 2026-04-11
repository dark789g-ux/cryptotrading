import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { WatchlistItem } from './watchlist-item.entity';

@Entity('watchlists')
export class Watchlist {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: 0 })
  sortOrder: number;

  @OneToMany(() => WatchlistItem, item => item.watchlist, { cascade: true })
  items: WatchlistItem[];
}
