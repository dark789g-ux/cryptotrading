import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { AdminOnly } from '../../../auth/decorators/admin-only.decorator';
import { RegimeBacktestService } from './regime-backtest.service';
import { CreateRegimeBacktestDto } from './dto/create-regime-backtest.dto';

@Controller('regime-engine/backtests')
export class RegimeBacktestController {
  constructor(private readonly service: RegimeBacktestService) {}

  @Post()
  @AdminOnly()
  create(@Body() dto: CreateRegimeBacktestDto) {
    return this.service.create(dto ?? ({} as CreateRegimeBacktestDto));
  }

  @Get()
  findAll(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.findAll(toInt(page, 1), toInt(pageSize, 20));
  }

  @Post(':id/run')
  @AdminOnly()
  triggerRun(@Param('id') id: string) {
    return this.service.triggerRun(id);
  }

  @Get(':id/progress')
  getProgress(@Param('id') id: string) {
    return this.service.getProgress(id);
  }

  @Get(':id/daily')
  listDaily(@Param('id') id: string) {
    return this.service.listDaily(id);
  }

  @Get(':id/trades')
  listTrades(@Param('id') id: string) {
    return this.service.listTrades(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Delete(':id')
  @AdminOnly()
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

function toInt(s: string | undefined, fallback: number): number {
  if (s === undefined || s.trim() === '') return fallback;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}
