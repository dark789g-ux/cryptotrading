import { Body, Controller, Get, Post } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { AddToScopeDto, RemoveFromScopeDto } from './dto/market-index-scope.dto';
import { MarketIndexScopeService } from './market-index-scope.service';

/**
 * 大盘宽基动态范围管理控制器。
 *
 * 路由前缀 `market-index-scope`（全局 /api）：
 * - GET  /api/market-index-scope/discover  发现候选（@AdminOnly，调 Tushare 有积分成本）
 * - GET  /api/market-index-scope           当前范围（读，无需 AdminOnly）
 * - POST /api/market-index-scope/add       加入范围（@AdminOnly）
 * - POST /api/market-index-scope/remove    移出范围（@AdminOnly）
 *
 * AuthGuard 已通过 APP_GUARD 全局注册，禁止在本 controller 加 @UseGuards(AuthGuard)。
 */
@Controller('market-index-scope')
export class MarketIndexScopeController {
  constructor(private readonly scopeService: MarketIndexScopeService) {}

  @Get('discover')
  @AdminOnly()
  discover() {
    return this.scopeService.discoverCandidates();
  }

  @Get()
  list() {
    return this.scopeService.getScope();
  }

  @Post('add')
  @AdminOnly()
  add(@Body() dto: AddToScopeDto) {
    return this.scopeService.addToScope(dto.tsCode, dto.name);
  }

  @Post('remove')
  @AdminOnly()
  remove(@Body() dto: RemoveFromScopeDto) {
    return this.scopeService.removeFromScope(dto.tsCode);
  }
}
