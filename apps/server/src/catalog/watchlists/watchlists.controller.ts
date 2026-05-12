import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WatchlistsService } from './watchlists.service';
import { UpsertByNameDto } from './dto/upsert-by-name.dto';

type CurrentUserPayload = { id: string };

@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly watchlistsService: WatchlistsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.watchlistsService.listWatchlists(user.id);
  }

  @Get('index-list')
  listIndexOptions() {
    return this.watchlistsService.listIndexOptions();
  }

  @Post('upsert-by-name')
  upsertByName(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: UpsertByNameDto,
  ) {
    return this.watchlistsService.upsertByName(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.watchlistsService.getWatchlist(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: { name: string; symbols?: string[] }) {
    return this.watchlistsService.createWatchlist(user.id, body);
  }

  @Put('reorder')
  reorderWatchlists(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { ids: string[] },
  ) {
    return this.watchlistsService.reorderWatchlists(user.id, body.ids);
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
    let sort: unknown = undefined;
    if (sortJson) {
      try { sort = JSON.parse(sortJson); }
      catch { throw new BadRequestException('sort 参数不是合法 JSON'); }
    }
    return this.watchlistsService.getWatchlistQuotes(
      user.id,
      id,
      interval,
      parseInt(page, 10),
      parseInt(pageSize, 10),
      sort,
    );
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
