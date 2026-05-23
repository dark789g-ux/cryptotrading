import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { QuantQualityService } from '../services/quant-quality.service';
import { AdminGuard } from '../../../auth/admin.guard';
import {
  validateQualityByDateParam,
  validateQualityLevelQuery,
  validateQualityRecentQuery,
} from '../dto/quality-query.dto';

/**
 * `GET /quant/quality/*` 只读端点。
 *
 * 鉴权约束（CLAUDE.md）：
 *   AuthGuard 已通过 APP_GUARD 注册为全局守卫；本 Controller **禁止**再加 `@UseGuards(AuthGuard)`。
 *
 * 路由顺序：先声明字面量子路径 `recent`，再声明 `:date` 通配，避免 `recent` 被吞为 `date`。
 */
@Controller('quant/quality')
@UseGuards(AdminGuard)
export class QuantQualityController {
  constructor(private readonly svc: QuantQualityService) {}

  /** `GET /quant/quality/recent?days=&level=` */
  @Get('recent')
  async getRecent(@Query() query: Record<string, unknown>) {
    const dto = validateQualityRecentQuery(query ?? {});
    const items = await this.svc.getRecent(dto);
    return {
      days: dto.days,
      levels: dto.levels ?? null,
      items,
    };
  }

  /**
   * `GET /quant/quality/:date?level=warn,critical`
   *
   * - date：8 位数字串 YYYYMMDD（spec M3 §5）
   * - level（可选）：逗号分隔的 level 列表，与 recent 一致
   */
  @Get(':date')
  async getByDate(
    @Param('date') date: string,
    @Query() query: Record<string, unknown>,
  ) {
    const tradeDate = validateQualityByDateParam(date);
    const levels = validateQualityLevelQuery((query ?? {}).level);
    const items = await this.svc.getByDate(tradeDate, levels);
    return {
      trade_date: tradeDate,
      levels: levels ?? null,
      items,
    };
  }
}
