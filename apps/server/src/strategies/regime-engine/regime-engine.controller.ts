/**
 * regime-engine.controller.ts
 *
 * REST 路由：基路由 /api/regime-engine（全局 /api 前缀由 main.ts 设定）。
 *
 * 鉴权：AuthGuard 已全局注册（APP_GUARD），不再重复加 @UseGuards；
 * 写操作（建配置/激活/触发流水线）用 @AdminOnly() 元数据走全局守卫的 admin 检查。
 */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { RegimeEngineService } from './regime-engine.service';
import { CreateRegimeConfigDto, UpdateRegimeConfigDto } from './regime-engine.types';

@Controller('regime-engine')
export class RegimeEngineController {
  constructor(private readonly service: RegimeEngineService) {}

  /** GET /api/regime-engine/today 当前象限 + 生效配置摘要 + 最新一日清单 */
  @Get('today')
  getToday() {
    return this.service.getToday();
  }

  /** GET /api/regime-engine/picks?tradeDate=YYYYMMDD 指定日清单（含 flat/unknown 行） */
  @Get('picks')
  getPicks(@Query('tradeDate') tradeDate?: string) {
    return this.service.getPicks(tradeDate ?? '');
  }

  /** GET /api/regime-engine/configs 配置列表 */
  @Get('configs')
  listConfigs() {
    return this.service.listConfigs();
  }

  /** POST /api/regime-engine/configs 新建 draft 配置（admin） */
  @Post('configs')
  @AdminOnly()
  createConfig(@Body() dto: CreateRegimeConfigDto) {
    return this.service.createConfig(dto ?? ({} as CreateRegimeConfigDto));
  }

  /** POST /api/regime-engine/configs/:id/activate 激活配置（admin，事务内换防） */
  @Post('configs/:id/activate')
  @AdminOnly()
  activateConfig(@Param('id') id: string) {
    return this.service.activateConfig(id);
  }

  /** PATCH /api/regime-engine/configs/:id 更新 draft 配置（admin） */
  @Patch('configs/:id')
  @AdminOnly()
  updateConfig(@Param('id') id: string, @Body() dto: UpdateRegimeConfigDto) {
    return this.service.updateConfig(id, dto);
  }

  /** POST /api/regime-engine/run-daily 触发当日流水线（admin；body 可带 tradeDate 回算历史日） */
  @Post('run-daily')
  @AdminOnly()
  runDaily(@Body() body: { tradeDate?: string } = {}) {
    return this.service.runDaily(body?.tradeDate);
  }
}
