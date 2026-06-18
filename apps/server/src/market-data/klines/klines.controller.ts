import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { KlinesService } from './klines.service';
import { KdjParamsDto, validateKdjParams } from './dto/kdj-params.dto';

@Controller('klines')
export class KlinesController {
  constructor(private readonly klinesService: KlinesService) {}

  /** GET /api/klines/:symbol/:interval */
  @Get(':symbol/:interval')
  getKlines(
    @Param('symbol') symbol: string,
    @Param('interval') interval: string,
  ) {
    return this.klinesService.getKlines(symbol, interval);
  }

  /** POST /api/klines/:symbol/:interval/recalc */
  @Post(':symbol/:interval/recalc')
  recalcKlines(
    @Param('symbol') symbol: string,
    @Param('interval') interval: string,
    @Body() body: { kdjParams?: KdjParamsDto },
  ) {
    const kdjParams = body.kdjParams ? validateKdjParams(body.kdjParams) : undefined;
    return this.klinesService.recalcKlines(symbol, interval, kdjParams);
  }
}
