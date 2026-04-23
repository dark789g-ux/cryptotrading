import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { WatchlistsService } from './watchlists.service';

@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly watchlistsService: WatchlistsService) {}

  @Get()
  list() {
    return this.watchlistsService.listWatchlists();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.watchlistsService.getWatchlist(id);
  }

  @Post()
  create(@Body() body: { name: string; symbols?: string[] }) {
    return this.watchlistsService.createWatchlist(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; symbols?: string[] }) {
    return this.watchlistsService.updateWatchlist(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.watchlistsService.deleteWatchlist(id);
  }
}
