import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../../auth/admin.guard';
import { QuantFeatureSetsService } from './quant-feature-sets.service';

/**
 * `GET /api/quant/feature-sets` 已物化特征集列表端点。
 *
 * 鉴权约束（CLAUDE.md nestjs.md）：
 *   AuthGuard 已通过 APP_GUARD 注册为全局守卫，本 Controller **禁止**再加 `@UseGuards(AuthGuard)`，
 *   否则 NestJS 在当前模块上下文解析 Guard 依赖，未导入 AuthModule 时启动报
 *   `Can't resolve dependencies`。
 *
 * Endpoints（spec 03-backend-decoupling.md §"server：已备 feature_set 列表 API"）：
 *   GET /api/quant/feature-sets?materialized=true
 *     → [{ feature_set_id, factor_version, scheme, new_listing_min_days,
 *           label_name, label_version, coverage: [{start,end},...] }, ...]
 *
 * `materialized=true` 是当前唯一支持的参数；缺省或 false 时行为与 true 相同
 * （YAGNI：目前没有"列出全量未物化 fs"的需求）。
 */
@Controller('quant/feature-sets')
@UseGuards(AdminGuard)
export class QuantFeatureSetsController {
  constructor(private readonly svc: QuantFeatureSetsService) {}

  /** `GET /quant/feature-sets?materialized=true` */
  @Get()
  async list() {
    const items = await this.svc.listMaterialized();
    return { items };
  }
}
