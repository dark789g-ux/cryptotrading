import { Controller, Get, Put, Body, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** GET /api/sync/preferences */
  @Get('preferences')
  getPreferences() {
    return this.syncService.getPreferences();
  }

  /** PUT /api/sync/preferences */
  @Put('preferences')
  savePreferences(@Body() body: { intervals: string[]; symbols: string[] }) {
    return this.syncService.savePreferences(body);
  }

  /** GET /api/sync/run — SSE 推送同步进度 */
  @Get('run')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync();
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
