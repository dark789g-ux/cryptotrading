import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WatchlistsController } from './watchlists.controller';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([WatchlistEntity, WatchlistItemEntity])],
  controllers: [WatchlistsController],
  providers: [WatchlistsService, TushareClientService],
  exports: [WatchlistsService],
})
export class WatchlistsModule {}
