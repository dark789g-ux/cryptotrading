import { Controller, Get, Param } from '@nestjs/common';
import { KlinesService } from './klines.service';

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
}
