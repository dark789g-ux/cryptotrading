import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
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

  @Post(':id/symbols')
  addSymbol(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { symbol?: string },
  ) {
    const symbol = (body.symbol ?? '').trim();
    if (!symbol) throw new ConflictException('symbol 不能为空');
    return this.watchlistsService.addSymbol(user.id, id, symbol);
  }

  @Delete(':id/symbols/:symbol')
  removeSymbol(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Param('symbol') symbol: string,
  ) {
    return this.watchlistsService.removeSymbol(user.id, id, decodeURIComponent(symbol));
  }

  @Get(':id/quotes')
  getQuotes(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Query('interval') interval: string = '1h',
    @Query('page') page: string = '1',
    @Query('page_size') pageSize: string = '20',
    @Query('sort') sortJson?: string,
  ) {
    const sort = sortJson ? JSON.parse(sortJson) : undefined;
    return this.watchlistsService.getWatchlistQuotes(
      user.id,
      id,
      interval,
      parseInt(page, 10),
      parseInt(pageSize, 10),
      sort,
    );
  }

  @Put('reorder')
  reorderWatchlists(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { ids: string[] },
  ) {
    return this.watchlistsService.reorderWatchlists(user.id, body.ids);
  }

  @Put(':id/reorder')
  reorderItems(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { symbols: string[] },
  ) {
    return this.watchlistsService.reorderItems(user.id, id, body.symbols);
  }

  @Post(':id/import-from-index')
  importFromIndex(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { indexCode?: string },
  ) {
    const indexCode = (body.indexCode ?? '').trim();
    if (!indexCode) throw new ConflictException('indexCode 不能为空');
    return this.watchlistsService.importFromIndex(user.id, id, indexCode);
  }
}
