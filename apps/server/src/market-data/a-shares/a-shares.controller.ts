import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ASharesFilterPresetsService } from './services/a-shares-filter-presets.service';
import { ASharesService, QueryASharesDto, SyncASharesDto } from './a-shares.service';

@Controller('a-shares')
export class ASharesController {
  constructor(
    private readonly aSharesService: ASharesService,
    private readonly filterPresetsService: ASharesFilterPresetsService,
  ) {}

  @Get('summary')
  getSummary() {
    return this.aSharesService.getSummary();
  }

  @Get('filter-options')
  getFilterOptions() {
    return this.aSharesService.getFilterOptions();
  }

  @Get('date-range')
  getDateRange() {
    return this.aSharesService.getDateRange();
  }

  @Get('filter-presets')
  listFilterPresets() {
    return this.filterPresetsService.list();
  }

  @Post('filter-presets')
  createFilterPreset(@Body() body: { name: string; filters: unknown }) {
    return this.filterPresetsService.create(body);
  }

  @Put('filter-presets/:id')
  updateFilterPreset(@Param('id') id: string, @Body() body: { name?: string; filters?: unknown }) {
    return this.filterPresetsService.update(id, body);
  }

  @Delete('filter-presets/:id')
  removeFilterPreset(@Param('id') id: string) {
    return this.filterPresetsService.remove(id);
  }

  @Get(':tsCode/klines')
  getKlines(
    @Param('tsCode') tsCode: string,
    @Query('limit') limit: string | undefined,
    @Query('priceMode') priceMode: 'qfq' | 'raw' | undefined,
  ) {
    return this.aSharesService.getKlines(tsCode, Number(limit), priceMode === 'raw' ? 'raw' : 'qfq');
  }

  @Post('query')
  query(@Body() body: QueryASharesDto) {
    return this.aSharesService.query(body);
  }

  @Post('sync')
  sync(@Body() body: SyncASharesDto) {
    return this.aSharesService.sync(body);
  }

  @Get('sync/run')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() query: SyncASharesDto, @Res() res: Response) {
    res.flushHeaders();
    const subject = this.aSharesService.startSync(query);
    const subscription = subject.subscribe({
      next: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      complete: () => {
        res.end();
      },
      error: () => {
        res.end();
      },
    });
    res.on('close', () => subscription.unsubscribe());
  }
}
