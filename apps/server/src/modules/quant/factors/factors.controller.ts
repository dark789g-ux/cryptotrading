import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../../auth/admin.guard';
import type { RequestWithUser } from '../../../auth/shared/auth.types';
import { FactorsService } from './factors.service';
import { validateUpdateFactor } from './dto/update-factor.dto';

/**
 * `GET / PATCH /api/quant/factors/*` 端点。
 *
 * 鉴权约束（CLAUDE.md + spec 03-backend.md）：
 *   - 全局 AuthGuard 已通过 APP_GUARD 注册，本 controller **禁止**再加 `@UseGuards(AuthGuard)`
 *   - 类级 `@UseGuards(AdminGuard)` 把整个 `/quant/factors/*` 收口为 admin-only
 *
 * Endpoints（spec 03-backend.md）：
 *   GET   /api/quant/factors                 ?enabled=&category=   → { items }
 *   GET   /api/quant/factors/categories                            → { items }
 *   PATCH /api/quant/factors/:id/:version                          → { item }
 *
 * **不做**的端点（spec 显式列出）：
 *   - POST /factors        前端不可新建（必须有 Python compute 类）
 *   - DELETE /factors      同上
 *   - POST /factors/:id/:v/toggle   PATCH {enabled} 可干同样事
 */
@Controller('quant/factors')
@UseGuards(AdminGuard)
export class FactorsController {
  constructor(private readonly svc: FactorsService) {}

  /** `GET /quant/factors?enabled=true|false&category=price` */
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const filter = parseListQuery(query ?? {});
    const items = await this.svc.listFactors(filter);
    return { items };
  }

  /** `GET /quant/factors/categories` —— distinct category 列表 */
  @Get('categories')
  async listCategories() {
    const items = await this.svc.listCategories();
    return { items };
  }

  /** `PATCH /quant/factors/:id/:version` */
  @Patch(':id/:version')
  async update(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: RequestWithUser,
  ) {
    if (!id) throw new BadRequestException('id 必填');
    if (!version) throw new BadRequestException('version 必填');
    if (!req.user) {
      // 理论上 AuthGuard + AdminGuard 已挡，这里防御兜底，避免 created/updated_by 落 null
      throw new UnauthorizedException('未登录');
    }
    const dto = validateUpdateFactor(body);
    const item = await this.svc.update(id, version, dto, req.user.id);
    return { item };
  }
}

/**
 * 解析 list 查询串。
 *
 * - `enabled=true/false/1/0` → boolean；其它值抛 400
 * - `category` 非空字符串透传（DB 端 `category` CHECK 已限定，service 直接查）
 * - 其它未知 key 静默忽略（与本仓库其它 quant 查询风格一致）
 */
function parseListQuery(query: Record<string, unknown>): { enabled?: boolean; category?: string } {
  const out: { enabled?: boolean; category?: string } = {};
  const raw = query.enabled;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (raw === true || raw === 'true' || raw === '1' || raw === 1) {
      out.enabled = true;
    } else if (raw === false || raw === 'false' || raw === '0' || raw === 0) {
      out.enabled = false;
    } else {
      throw new BadRequestException('enabled 必须为 true/false');
    }
  }
  if (typeof query.category === 'string' && query.category.length > 0) {
    out.category = query.category;
  }
  return out;
}
