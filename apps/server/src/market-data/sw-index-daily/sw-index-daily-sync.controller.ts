import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { SwIndexDailySyncService } from './sw-index-daily-sync.service';
import { SwIndexDailySyncDto } from './dto/sync.dto';

const TRADE_DATE_RE = /^\d{8}$/;

/**
 * 申万行业指数日线同步。
 *
 * - GET /api/sw-index-daily/sync — 全量回填（admin），同步返回结果
 *   首次回填近 5 年：?start_date=20210101&end_date=<today>&syncMode=overwrite
 *
 * 注：one-click sync 的 sw 步骤走 DI 直接调 service.startSync()（进程内 Subject），
 * 不经 HTTP，故无需 SSE 端点（参考 step-runners.ts 的 ths 集成方式）。
 */
@Controller('sw-index-daily')
export class SwIndexDailySyncController {
  constructor(private readonly syncService: SwIndexDailySyncService) {}

  @Get('sync')
  @AdminOnly()
  async sync(@Query() dto: SwIndexDailySyncDto) {
    this.validateDto(dto);
    return this.syncService.sync(dto);
  }

  private validateDto(dto: SwIndexDailySyncDto): void {
    if (!TRADE_DATE_RE.test(dto.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(dto.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (dto.start_date > dto.end_date) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }
  }
}
