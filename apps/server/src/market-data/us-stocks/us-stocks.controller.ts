import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { KdjParamsDto, validateKdjParams } from '../klines/dto/kdj-params.dto';
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

  /**
   * POST /api/us-stocks/:ticker/klines/recalc?limit=...&priceMode=...&startDate=...&endDate=...
   *
   * 按自定义 KDJ 参数（n/m1/m2）重算个股 K 线的 KDJ 三列，其余字段保持原值。
   * kdjParams 缺省或等于默认 9/3/3 时直接返回原始数据。
   */
  @Post(':ticker/klines/recalc')
  recalcKlines(
    @Param('ticker') ticker: string,
    @Query('limit') limit: string | undefined,
    @Query('priceMode') priceMode: 'qfq' | 'raw' | undefined,
    @Query('startDate') startDate: string | undefined,
    @Query('endDate') endDate: string | undefined,
    @Body() body: { kdjParams?: KdjParamsDto },
  ) {
    const kdjParams = body.kdjParams != null ? validateKdjParams(body.kdjParams) : undefined;
    return this.usStocksService.recalcKlines(
      ticker,
      {
        limit: Number(limit),
        priceMode: priceMode === 'raw' ? 'raw' : 'qfq',
        startDate,
        endDate,
      },
      kdjParams,
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
