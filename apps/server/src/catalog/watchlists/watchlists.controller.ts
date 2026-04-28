import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WatchlistsService } from './watchlists.service';

type CurrentUserPayload = { id: string };

@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly watchlistsService: WatchlistsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.watchlistsService.listWatchlists(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.watchlistsService.getWatchlist(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: { name: string; symbols?: string[] }) {
    return this.watchlistsService.createWatchlist(user.id, body);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { name?: string; symbols?: string[] }) {
    return this.watchlistsService.updateWatchlist(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.watchlistsService.deleteWatchlist(user.id, id);
  }
}
