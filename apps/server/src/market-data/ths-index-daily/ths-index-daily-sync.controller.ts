import { BadRequestException, Controller, Get, Header, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { ThsIndexDailySyncService } from './ths-index-daily-sync.service';
import { MarketIndexSyncService, MarketIndexSyncDto } from './market-index-sync.service';
import { ThsIndexDailySyncDto } from './dto/sync.dto';

const TRADE_DATE_RE = /^\d{8}$/;

@Controller('ths-index-daily/sync')
export class ThsIndexDailySyncController {
  constructor(
    private readonly syncService: ThsIndexDailySyncService,
    private readonly marketIndexSync: MarketIndexSyncService,
  ) {}

  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() dto: ThsIndexDailySyncDto, @Res() res: Response) {
    if (!TRADE_DATE_RE.test(dto.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(dto.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (dto.start_date > dto.end_date) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }
    res.flushHeaders();
    const subject = this.syncService.startSync(dto);
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }

  /** 大盘指数日线同步（index_daily，遍历 ths_index_catalog type='M' 动态范围，同步返回结果）。 */
  @Get('market')
  @AdminOnly()
  async runMarketSync(@Query() dto: MarketIndexSyncDto) {
    if (!TRADE_DATE_RE.test(dto.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(dto.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (dto.start_date > dto.end_date) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }
    return this.marketIndexSync.sync(dto);
  }
}
