import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MoneyFlowService } from './money-flow.service';
import { QueryFlowDto } from './dto/query-flow.dto';
import { QueryMemberDto, TRADE_DATE_PATTERN } from './dto/query-member.dto';

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

  @Post('industries/query')
  queryIndustries(@Body() dto: QueryFlowDto) {
    return this.moneyFlowService.queryIndustries(dto);
  }

  @Post('ths-industries/query')
  queryThsIndustries(@Body() dto: QueryFlowDto) {
    return this.moneyFlowService.queryThsIndustries(dto);
  }

  @Get('sectors')
  querySectors(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.querySectors(dto);
  }

  @Get('market')
  queryMarket(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryMarket(dto);
  }

  @Get('indices')
  queryIndices(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryIndices(dto);
  }

  @Get('members')
  queryMembers(@Query() dto: QueryMemberDto) {
    if (dto.trade_date !== undefined && !TRADE_DATE_PATTERN.test(dto.trade_date)) {
      throw new BadRequestException('trade_date 必须为 8 位 YYYYMMDD');
    }
    return this.moneyFlowService.queryMembers(dto.ts_code, dto.trade_date);
  }
}
