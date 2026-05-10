import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { WatchlistItemEntity } from './watchlist-item.entity';

@Entity('watchlists')
export class WatchlistEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'user_id', type: 'character varying', nullable: true })
  userId: string;

  @OneToMany(() => WatchlistItemEntity, (item) => item.watchlist, { cascade: true })
  items: WatchlistItemEntity[];

  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
