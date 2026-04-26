import { Body, Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ASharesService, QueryASharesDto, SyncASharesDto } from './a-shares.service';

@Controller('a-shares')
export class ASharesController {
  constructor(private readonly aSharesService: ASharesService) {}

  @Get('summary')
  getSummary() {
    return this.aSharesService.getSummary();
  }

  @Get('filter-options')
  getFilterOptions() {
    return this.aSharesService.getFilterOptions();
  }

  @Get(':tsCode/klines')
  getKlines(@Param('tsCode') tsCode: string, @Query('limit') limit: string | undefined) {
    return this.aSharesService.getKlines(tsCode, Number(limit));
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
