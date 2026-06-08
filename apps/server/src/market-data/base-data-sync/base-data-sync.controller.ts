import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { BaseDataSyncService } from './base-data-sync.service';
import type { SyncDto, SyncEvent } from './base-data-sync.types';

const TRADE_DATE_RE = /^\d{8}$/;

@Controller('base-data')
export class BaseDataSyncController {
  constructor(private readonly syncService: BaseDataSyncService) {}

  /** SSE：按依赖顺序串行同步 trade_cal / stk_limit / suspend_d。→ /api/base-data/sync/run */
  @Get('sync/run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() dto: SyncDto, @Res() res: Response) {
    // guard：非法参数推 error 事件后结束（SSE 头已声明，flush 后写 error 事件）
    const startOk = TRADE_DATE_RE.test(dto.start_date ?? '');
    const endOk = TRADE_DATE_RE.test(dto.end_date ?? '');
    const orderOk = startOk && endOk && dto.start_date <= dto.end_date;
    if (!startOk || !endOk || !orderOk) {
      res.flushHeaders();
      const message = !startOk || !endOk
        ? 'start_date / end_date 必须为 8 位 YYYYMMDD'
        : 'start_date 不能大于 end_date';
      this.writeEvent(res, { type: 'error', message });
      res.end();
      return;
    }

    res.flushHeaders(); // ★必须在 subscribe 之前
    const subject = this.syncService.startSync(dto);
    const subscription = subject.subscribe({
      next: (event) => this.writeEvent(res, event),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }

  /** 三表库存日期范围。→ /api/base-data/range */
  @Get('range')
  @AdminOnly()
  getRange() {
    return this.syncService.getStoredRange();
  }

  private writeEvent(res: Response, event: SyncEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
