import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { WatchlistItemEntity } from './watchlist-item.entity';

@Entity('watchlists')
export class WatchlistEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @OneToMany(() => WatchlistItemEntity, (item) => item.watchlist, { cascade: true })
  items: WatchlistItemEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
