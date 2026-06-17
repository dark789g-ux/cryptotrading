import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UsStocksService } from './us-stocks.service';
import { UsStocksSymbolsService } from './us-stocks-symbols.service';
import {
  UsOneClickSyncBody,
  UsStockQueryBody,
  UsStockSyncBody,
  UsStockTrackedUpdateBody,
} from './us-stocks.types';

type CurrentUserPayload = { id: string };

@Controller('us-stocks')
export class UsStocksController {
  constructor(
    private readonly usStocksService: UsStocksService,
    private readonly symbolsService: UsStocksSymbolsService,
  ) {}

  @Get('summary')
  getSummary() {
    return this.usStocksService.getSummary();
  }

  @Get('filter-options')
  getFilterOptions() {
    return this.usStocksService.getFilterOptions();
  }

  @Get('date-range')
  getDateRange() {
    return this.usStocksService.getDateRange();
  }

  @Get('symbols')
  listSymbols() {
    return this.symbolsService.listSymbols();
  }

  @Put('symbols/tracked')
  updateTracked(@Body() body: UsStockTrackedUpdateBody) {
    return this.symbolsService.updateTracked(body?.items ?? []);
  }

  @Get(':ticker/klines')
  getKlines(
    @Param('ticker') ticker: string,
    @Query('limit') limit: string | undefined,
    @Query('priceMode') priceMode: 'qfq' | 'raw' | undefined,
    @Query('startDate') startDate: string | undefined,
    @Query('endDate') endDate: string | undefined,
  ) {
    return this.usStocksService.getKlines(
      ticker,
      Number(limit),
      priceMode === 'raw' ? 'raw' : 'qfq',
      startDate || endDate ? { startDate, endDate } : undefined,
    );
  }

  @Post('query')
  query(@Body() body: UsStockQueryBody) {
    return this.usStocksService.query(body);
  }

  @Post('sync')
  @AdminOnly()
  sync(@Body() body: UsStockSyncBody, @CurrentUser() user: CurrentUserPayload) {
    return this.usStocksService.sync(body ?? {}, user?.id ?? null);
  }

  @Post('one-click-sync')
  @AdminOnly()
  oneClickSync(@Body() body: UsOneClickSyncBody, @CurrentUser() user: CurrentUserPayload) {
    return this.usStocksService.oneClickSync(body, user?.id ?? null);
  }
}
