import { Controller, Post } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { SignalRollingIndicatorService } from './signal-rolling-indicator.service';

/**
 * 滚动指标 API。全局 /api 前缀 + 全局 AuthGuard 已注册，
 * 本 controller **不**加 @UseGuards(AuthGuard)（见 nestjs 规则）。
 *
 * 全量回填是重负载管理操作，须 @AdminOnly() 守护，避免任意登录用户触发全市场回填。
 */
@Controller('signal-rolling-indicator')
export class SignalRollingIndicatorController {
  constructor(
    private readonly signalRollingService: SignalRollingIndicatorService,
  ) {}

  @Post('backfill')
  @AdminOnly()
  backfill() {
    return this.signalRollingService.backfillAll();
  }
}
