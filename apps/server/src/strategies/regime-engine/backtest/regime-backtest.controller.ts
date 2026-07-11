import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { AdminOnly } from '../../../auth/decorators/admin-only.decorator';
import { RegimeBacktestService } from './regime-backtest.service';
import { CreateRegimeBacktestDto } from './dto/create-regime-backtest.dto';
import { UpdateRegimeBacktestDto } from './dto/update-regime-backtest.dto';

/** Legacy alias: /api/regime-engine/backtests */
@Controller('regime-engine/backtests')
export class RegimeBacktestController {
  constructor(private readonly service: RegimeBacktestService) {}

  @Post()
  @AdminOnly()
  create(@Body() dto: CreateRegimeBacktestDto) {
    return this.service.create(dto ?? ({} as CreateRegimeBacktestDto));
  }

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    const filter: { status?: string; keyword?: string } = {};
    if (status && status.trim()) filter.status = status.trim();
    if (keyword && keyword.trim()) filter.keyword = keyword.trim();
    return this.service.findAll(toInt(page, 1), toInt(pageSize, 20), filter);
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

  @Get(':id/daily-log')
  listDailyLog(@Param('id') id: string) {
    return this.service.listDailyLog(id);
  }

  @Get(':id/positions')
  listPositions(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('tsCode') tsCode?: string,
  ) {
    return this.service.listPositions(id, {
      page: toInt(page, 1),
      pageSize: toInt(pageSize, 50),
      sortBy,
      sortOrder,
      tsCode,
    });
  }

  @Get(':id/symbol-stats')
  listSymbolStats(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('tsCode') tsCode?: string,
  ) {
    return this.service.listSymbolStats(id, {
      page: toInt(page, 1),
      pageSize: toInt(pageSize, 50),
      sortBy,
      sortOrder,
      tsCode,
    });
  }

  @Get(':id/kline-chart')
  getKlineChart(
    @Param('id') id: string,
    @Query('tsCode') tsCode?: string,
    @Query('signalDate') signalDate?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    return this.service.getKlineChart(
      id,
      tsCode ?? '',
      signalDate ?? '',
      toInt(before, 100),
      toInt(after, 30),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @AdminOnly()
  update(@Param('id') id: string, @Body() dto: UpdateRegimeBacktestDto) {
    return this.service.update(id, dto ?? ({} as UpdateRegimeBacktestDto));
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
