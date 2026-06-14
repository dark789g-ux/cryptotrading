import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { QuantJobsService } from '../services/quant-jobs.service';
import { validateCreateJob } from '../dto/create-job.dto';
import { validateJobQuery } from '../dto/job-query.dto';
import { AdminGuard } from '../../../auth/admin.guard';
import type { RequestWithUser } from '../../../auth/shared/auth.types';

/**
 * `POST/GET /quant/jobs/*` 端点。
 *
 * 鉴权约束（CLAUDE.md）：
 *   AuthGuard 已通过 APP_GUARD 注册为全局守卫，本 Controller **禁止**再加 `@UseGuards(AuthGuard)`，
 *   否则 NestJS 会在当前模块上下文解析 Guard 依赖，未导入 AuthModule 时会启动报
 *   `Can't resolve dependencies`。
 *
 * SSE token 端点说明：
 *   `/quant/jobs/:id/sse-token` 仍受全局 AuthGuard 保护（用户已登录就能拿 token），
 *   真正面向浏览器 EventSource 的 SSE 流接口 (`/quant/jobs/:id/stream`) 见
 *   `quant-jobs-sse.controller.ts`（M2 阶段为 polling 占位，M4 升级到 PG LISTEN/NOTIFY）。
 */
@Controller('quant/jobs')
@UseGuards(AdminGuard)
export class QuantJobsController {
  constructor(private readonly svc: QuantJobsService) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: RequestWithUser) {
    if (!req.user) {
      // 全局 AuthGuard 理论上已挡住，但 SSE token 等场景的 ConfigService 路径不依赖 req.user，
      // 这里加一道防御以避免静默落 created_by=null。
      throw new UnauthorizedException('未登录');
    }
    const validated = validateCreateJob(body);
    const job = await this.svc.create(validated, req.user.id);
    return job;
  }

  @Get()
  list(@Query() query: Record<string, unknown>) {
    const dto = validateJobQuery(query ?? {});
    return this.svc.list(dto);
  }

  /**
   * 返回完整 entity（含 `warnings: WarningItem[]` 明细），用于 QuantJobs 详情页。
   *
   * 详细 schema 见 spec 04-frontend-backend.md §4.1.5；列表接口 (`GET /quant/jobs`)
   * 只暴露 `warnings_count` 不带明细，避免大量 warning 拖慢列表。
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    if (!id || typeof id !== 'string') {
      throw new BadRequestException('id 必填');
    }
    return this.svc.findOne(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    if (!id) throw new BadRequestException('id 必填');
    return this.svc.cancel(id);
  }

  /**
   * 手动发起草稿任务运行：draft → pending（M2 §6.3.3）。
   *
   * - 非草稿任务 → 409（仅草稿任务可发起运行）
   * - 任务不存在 → 404
   */
  @Post(':id/dispatch')
  dispatch(@Param('id') id: string) {
    if (!id) throw new BadRequestException('id 必填');
    return this.svc.dispatch(id);
  }

  /**
   * 为 SSE 流接口颁发一次性短期 token。
   *
   * 接口仍受全局 AuthGuard：用户必须已登录；token payload 锚定当前 user_id，
   * 5 分钟内过期（见 SSE_TOKEN_TTL_SECONDS）。
   */
  @Post(':id/sse-token')
  issueSseToken(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!id) throw new BadRequestException('id 必填');
    if (!req.user) {
      throw new UnauthorizedException('未登录');
    }
    return this.svc.issueSseToken(id, req.user.id);
  }
}
