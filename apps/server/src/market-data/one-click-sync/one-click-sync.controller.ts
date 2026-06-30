import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../../auth/shared/auth.types';
import { OneClickSyncOrchestratorService } from './one-click-sync-orchestrator.service';
import { CreateRunDto } from './dto/create-run.dto';

const YYYYMMDD_RE = /^\d{8}$/;

/**
 * 「一键同步」后端托管编排端点。
 *
 * AuthGuard 已全局注册（APP_GUARD），禁止再 @UseGuards(AuthGuard)（见 .claude/rules/nestjs.md）；
 * 仅 admin 可操作（@AdminOnly）。所有出参为 camelCase Run（OneClickSyncRunDto）。
 */
@Controller('one-click-sync')
export class OneClickSyncController {
  constructor(private readonly orchestrator: OneClickSyncOrchestratorService) {}

  /**
   * 开始一键同步。单飞：已有 running 则直接返回它（不新建）。
   * 新建与复用均返回 200 + Run（前端只读，不区分状态码）。
   */
  @Post('runs')
  @AdminOnly()
  @HttpCode(200)
  startRun(@Body() body: CreateRunDto, @CurrentUser() user?: CurrentUserType) {
    const startDate = body?.startDate ?? '';
    const endDate = body?.endDate ?? '';
    if (!YYYYMMDD_RE.test(startDate) || !YYYYMMDD_RE.test(endDate)) {
      throw new BadRequestException('startDate / endDate 必须为 8 位 YYYYMMDD');
    }
    if (startDate > endDate) {
      throw new BadRequestException('startDate 不能大于 endDate');
    }
    return this.orchestrator.startRun(startDate, endDate, user?.id ?? null);
  }

  /** 取当前活跃 run；无活跃则返回最近一条（供 onMounted 恢复）。 */
  @Get('runs/active')
  @AdminOnly()
  getActive() {
    return this.orchestrator.getActiveOrLatest();
  }

  /** 最近一次 status='success' 的 run（标题「最近成功」标签）。 */
  @Get('runs/latest-success')
  @AdminOnly()
  getLatestSuccess() {
    return this.orchestrator.getLatestSuccess();
  }

  /** 轮询单条进度。 */
  @Get('runs/:id')
  @AdminOnly()
  getRun(@Param('id') id: string) {
    return this.orchestrator.getRun(id);
  }

  /** 请求取消（置 cancel_requested=true；编排器在步骤间检查）。 */
  @Post('runs/:id/cancel')
  @AdminOnly()
  @HttpCode(200)
  cancelRun(@Param('id') id: string) {
    return this.orchestrator.cancelRun(id);
  }
}
