import { Body, Controller, Get, Header, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { SyncFlowDto } from './dto/sync-flow.dto';
import { QueryMemberDto } from './dto/query-member.dto';

@Controller('money-flow/sync')
export class MoneyFlowSyncController {
  constructor(private readonly syncService: MoneyFlowSyncService) {}

  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() query: SyncFlowDto, @Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync(query);
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }

  @Post('members')
  @AdminOnly()
  syncMembers(@Body() dto: QueryMemberDto) {
    const dimension = dto.ts_code === 'sector' ? 'sector' : 'industry';
    return this.syncService.syncMembers(dimension);
  }
}
