/**
 * signal-stats.controller.ts
 *
 * REST 路由：基路由 /api/signal-tests（全局 /api 前缀由 main.ts 设定）。
 *
 * ⚠️ 路由声明顺序：静态段路由必须先于 /:id，避免被参数路由吞掉：
 *   GET /runs/:runId/trades 与 GET /runs/:runId/ret-histogram 必须在 GET /:id 之前声明。
 *
 * 鉴权：AuthGuard 已全局注册（APP_GUARD），不再重复加 @UseGuards。
 * 路由不依赖 req.user（signal_test 无 user_id 列），直接调 service。
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { SignalStatsService } from './signal-stats.service';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';
import { UpdateSignalTestDto } from './dto/update-signal-test.dto';

@Controller('signal-tests')
export class SignalStatsController {
  constructor(private readonly service: SignalStatsService) {}

  // ── 静态段路由：必须先于 /:id 声明 ──────────────────────────────────────

  /**
   * GET /api/signal-tests/runs/:runId/trades
   * 逐笔明细分页。?page=1&pageSize=50
   */
  @Get('runs/:runId/trades')
  listTrades(
    @Param('runId') runId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const p = parseInt(page ?? '1', 10);
    const ps = parseInt(pageSize ?? '50', 10);
    return this.service.listTrades(runId, p, ps);
  }

  /**
   * GET /api/signal-tests/runs/:runId/ret-histogram
   * 收益率分布直方图。?bins=25（可选，默认 25，clamp [5,60]）
   */
  @Get('runs/:runId/ret-histogram')
  getRetHistogram(
    @Param('runId') runId: string,
    @Query('bins') bins?: string,
  ) {
    const b = parseInt(bins ?? '25', 10);
    return this.service.getRetHistogram(runId, b);
  }

  // ── 集合路由 ─────────────────────────────────────────────────────────────

  /** POST /api/signal-tests 创建方案 */
  @Post()
  create(@Body() dto: CreateSignalTestDto) {
    return this.service.create(dto);
  }

  /** GET /api/signal-tests 方案列表 */
  @Get()
  findAll() {
    return this.service.findAll();
  }

  // ── 单体路由（/:id 之下的子路由先声明，再是 /:id 本身）──────────────────

  /**
   * POST /api/signal-tests/:id/run
   * 触发异步 run，立即返回 { runId }。
   */
  @Post(':id/run')
  triggerRun(@Param('id') id: string) {
    return this.service.triggerRun(id);
  }

  /**
   * GET /api/signal-tests/:id/run/progress
   * 当前/最近一次 run 进度。
   */
  @Get(':id/run/progress')
  getRunProgress(@Param('id') id: string) {
    return this.service.getRunProgress(id);
  }

  /**
   * GET /api/signal-tests/:id/runs
   * 历史运行聚合列表。
   */
  @Get(':id/runs')
  listRuns(@Param('id') id: string) {
    return this.service.listRuns(id);
  }

  /** GET /api/signal-tests/:id 方案详情 */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** PUT /api/signal-tests/:id 更新方案 */
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSignalTestDto) {
    return this.service.update(id, dto);
  }

  /** DELETE /api/signal-tests/:id 删除方案（级联 run/trade） */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
