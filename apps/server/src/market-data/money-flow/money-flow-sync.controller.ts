import { Body, Controller, Post } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { SyncFlowDto } from './dto/sync-flow.dto';

@Controller('money-flow/sync')
export class MoneyFlowSyncController {
  constructor(private readonly syncService: MoneyFlowSyncService) {}

  @Post('stocks')
  @AdminOnly()
  syncStocks(@Body() dto: SyncFlowDto) {
    return this.syncService.syncStocks(dto);
  }

  @Post('industries')
  @AdminOnly()
  syncIndustries(@Body() dto: SyncFlowDto) {
    return this.syncService.syncIndustries(dto);
  }

  @Post('sectors')
  @AdminOnly()
  syncSectors(@Body() dto: SyncFlowDto) {
    return this.syncService.syncSectors(dto);
  }

  @Post('market')
  @AdminOnly()
  syncMarket(@Body() dto: SyncFlowDto) {
    return this.syncService.syncMarket(dto);
  }
}
