import { Controller, Get, Query, Param } from '@nestjs/common';
import { StocksService } from './stocks.service';
import { SearchStockDto } from './dto/search-stock.dto';
import { AdvancedFilterDto } from './dto/advanced-filter.dto';

@Controller('stocks')
export class StocksController {
  constructor(private readonly stocksService: StocksService) {}

  @Get()
  findAll(@Query() query: SearchStockDto) {
    return this.stocksService.findAll(query);
  }

  @Get('search')
  search(@Query('keyword') keyword: string) {
    return this.stocksService.search(keyword);
  }

  @Get('filter')
  advancedFilter(@Query() filter: AdvancedFilterDto) {
    return this.stocksService.advancedFilter(filter);
  }

  @Get(':tsCode')
  findOne(@Param('tsCode') tsCode: string) {
    return this.stocksService.findOne(tsCode);
  }

  @Get(':tsCode/prices')
  getPrices(
    @Param('tsCode') tsCode: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('period') period: 'day' | 'week' | 'month' = 'day',
  ) {
    return this.stocksService.getPrices(tsCode, startDate, endDate, period);
  }

  @Get(':tsCode/indicators')
  getIndicators(
    @Param('tsCode') tsCode: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.stocksService.getIndicators(tsCode, startDate, endDate);
  }
}
