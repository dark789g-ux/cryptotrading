/**
 * portfolio-sim.controller.ts
 *
 * REST 路由：基路由 /api/portfolio-sims（全局 /api 前缀由 main.ts 设定）。
 *
 * 鉴权：AuthGuard 已全局注册（APP_GUARD），不重复加 @UseGuards；写/读均加 @AdminOnly()
 * （走全局守卫 admin 检查，仿 regime-engine.controller）。
 *
 * 路由顺序：/:id 子路由（/:id/run 等）声明在 /:id 之前，避免被参数路由吞。
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { PortfolioSimService } from './portfolio-sim.service';
import { CreatePortfolioSimDto } from './dto/create-portfolio-sim.dto';
import { ListFillsQueryDto } from './dto/list-fills-query.dto';

@Controller('portfolio-sims')
@AdminOnly()
export class PortfolioSimController {
  constructor(private readonly service: PortfolioSimService) {}

  /** POST /api/portfolio-sims 新建方案，201 返实体。 */
  @Post()
  create(@Body() dto: CreatePortfolioSimDto) {
    return this.service.create(dto ?? ({} as CreatePortfolioSimDto));
  }

  /** GET /api/portfolio-sims 分页列表（created_at 倒序）。?page&pageSize */
  @Get()
  findAll(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = toInt(page, 1);
    const ps = toInt(pageSize, 20);
    return this.service.findAll(p, ps);
  }

  // ── /:id 子路由（先于 /:id 声明）──────────────────────────────────────────

  /** POST /api/portfolio-sims/:id/run 触发；per-id 互斥 409；源 run fail-fast。 */
  @Post(':id/run')
  triggerRun(@Param('id') id: string) {
    return this.service.triggerRun(id);
  }

  /** GET /api/portfolio-sims/:id/progress 进度。 */
  @Get(':id/progress')
  getProgress(@Param('id') id: string) {
    return this.service.getProgress(id);
  }

  /** GET /api/portfolio-sims/:id/daily 全量每日行（trade_date 升序）。 */
  @Get(':id/daily')
  listDaily(@Param('id') id: string) {
    return this.service.listDaily(id);
  }

  /**
   * GET /api/portfolio-sims/:id/fills 服务端分页 + 筛选 + 排序白名单。
   * ?page&pageSize&sortField&sortOrder&status&sourceLabel&skipReason&buyDateStart&buyDateEnd
   */
  @Get(':id/fills')
  listFills(@Param('id') id: string, @Query() q: ListFillsQueryDto) {
    const p = toInt(q.page, 1);
    const ps = toInt(q.pageSize, 50);
    return this.service.listFills(id, p, ps, {
      sortField: q.sortField,
      sortOrder: q.sortOrder,
      status: q.status,
      sourceLabel: q.sourceLabel,
      skipReason: q.skipReason,
      buyDateStart: q.buyDateStart,
      buyDateEnd: q.buyDateEnd,
    });
  }

  /** GET /api/portfolio-sims/:id 详情。 */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** DELETE /api/portfolio-sims/:id running 中 409；否则删（级联清 daily/fills）。 */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

/** 解析 query 整数，非法 / 缺省回落 fallback。 */
function toInt(s: string | undefined, fallback: number): number {
  if (s === undefined || s.trim() === '') return fallback;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}
