import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { SymbolsService, QuerySymbolsDto } from './symbols.service';

@Controller('symbols')
export class SymbolsController {
  constructor(private readonly symbolsService: SymbolsService) {}

  /** GET /api/symbols/names?interval= */
  @Get('names')
  getNames(@Query('interval') interval: string = '1d') {
    return this.symbolsService.getNames(interval);
  }

  /** GET /api/symbols/date-range?interval= */
  @Get('date-range')
  getDateRange(@Query('interval') interval: string = '1d') {
    return this.symbolsService.getDateRange(interval);
  }

  /** GET /api/symbols/kline-columns */
  @Get('kline-columns')
  getKlineColumns() {
    return this.symbolsService.getKlineColumns();
  }

  /** POST /api/symbols/query */
  @Post('query')
  querySymbols(@Body() dto: QuerySymbolsDto) {
    return this.symbolsService.querySymbols(dto);
  }

  /** PATCH /api/symbols/:symbol */
  @Patch(':symbol')
  @AdminOnly()
  patchSymbol(
    @Param('symbol') symbol: string,
    @Body() body: { syncEnabled?: boolean; isExcluded?: boolean },
  ) {
    return this.symbolsService.patchSymbol(symbol, {
      syncEnabled: body.syncEnabled,
      isExcluded: body.isExcluded,
    });
  }
}
