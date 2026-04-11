import { Controller, Post, Body } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post('run')
  run(@Body() dto: RunBacktestDto) {
    return this.backtestService.runBacktest(dto);
  }
}
