import { Controller, Get, Header, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { IndexCatalogSyncService } from './index-catalog-sync.service';

@Controller('index-catalog/sync')
export class IndexCatalogSyncController {
  constructor(private readonly syncService: IndexCatalogSyncService) {}

  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync();
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }
}
