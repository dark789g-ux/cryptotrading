import { Controller, Get, Query } from '@nestjs/common';
import { MoneyFlowService } from './money-flow.service';
import { QueryFlowDto } from './dto/query-flow.dto';

@Controller('money-flow')
export class MoneyFlowController {
  constructor(private readonly moneyFlowService: MoneyFlowService) {}

  @Get('date-range')
  getDateRange() {
    return this.moneyFlowService.getDateRange();
  }

  @Get('latest-dates')
  getLatestDates() {
    return this.moneyFlowService.getLatestDates();
  }

  @Get('stocks')
  queryStocks(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryStocks(dto);
  }

  @Get('industries')
  queryIndustries(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryIndustries(dto);
  }

  @Get('sectors')
  querySectors(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.querySectors(dto);
  }

  @Get('market')
  queryMarket(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryMarket(dto);
  }
}
