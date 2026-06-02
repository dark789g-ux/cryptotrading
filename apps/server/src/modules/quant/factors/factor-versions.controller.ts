import { Controller, Get } from '@nestjs/common';
import { FactorsService } from './factors.service';

/**
 * `GET /api/quant/factor-versions` 只读端点。
 *
 * 供前端 `factor_version` 下拉枚举可用版本（spec 02-backend-passthrough.md#factor-versions-api）。
 *
 * 鉴权约束（CLAUDE.md）：
 *   - 全局 AuthGuard 已通过 APP_GUARD 注册，本 controller **禁止**再加 `@UseGuards(AuthGuard)`
 *   - 不加 AdminGuard：这是给普通用户创建训练任务时枚举版本用，非 admin-only
 *     （与 admin-only 的 `quant/factors` 管理端点不同，故拆为独立 controller，
 *      不挂在 `@Controller('quant/factors')` 下）
 *
 * 返回：`{ versions: string[] }`；空结果返回 `{ versions: [] }` 不报错（前端回退手输）。
 */
@Controller('quant/factor-versions')
export class FactorVersionsController {
  constructor(private readonly svc: FactorsService) {}

  /** `GET /quant/factor-versions` → `{ versions: string[] }`（DISTINCT enabled，升序） */
  @Get()
  async list(): Promise<{ versions: string[] }> {
    const versions = await this.svc.listFactorVersions();
    return { versions };
  }
}
