import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../../auth/admin.guard';
import { LabelsService } from './labels.service';
import { validateCreateLabel } from './dto/create-label.dto';
import { validateUpdateLabel } from './dto/update-label.dto';

/**
 * `GET / POST / PATCH /api/quant/labels/*` 端点。
 *
 * 鉴权约束（CLAUDE.md + spec 03-backend.md）：
 *   - 全局 AuthGuard 已通过 APP_GUARD 注册，本 controller **禁止**再加 `@UseGuards(AuthGuard)`
 *   - 类级 `@UseGuards(AdminGuard)` 把整个 `/quant/labels/*` 收口为 admin-only
 *
 * Endpoints（spec 03-backend.md）：
 *   GET   /api/quant/labels                           ?enabled=&base_type=  → { items }
 *   GET   /api/quant/labels/base-types                                       → { base_types, classify_modes }
 *   GET   /api/quant/labels/:id/:version                                     → { item }
 *   POST  /api/quant/labels                                                  → { item }
 *   PATCH /api/quant/labels/:id/:version                                     → { item }
 *
 * 注意路由顺序：`base-types` 静态路由必须**先于** `:id/:version` 动态路由声明，
 * 否则 NestJS 会把 "base-types" 解析为 :id 参数。
 */
@Controller('quant/labels')
@UseGuards(AdminGuard)
export class LabelsController {
  constructor(private readonly svc: LabelsService) {}

  /** `GET /quant/labels/base-types` —— 枚举值，供前端下拉 */
  @Get('base-types')
  getBaseTypes() {
    return this.svc.getBaseTypes();
  }

  /** `GET /quant/labels?enabled=true|false&base_type=fwd_ret` */
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const filter = parseListQuery(query ?? {});
    const items = await this.svc.list(filter);
    return { items };
  }

  /** `GET /quant/labels/:id/:version` */
  @Get(':id/:version')
  async findOne(@Param('id') id: string, @Param('version') version: string) {
    if (!id) throw new BadRequestException('id 必填');
    if (!version) throw new BadRequestException('version 必填');
    const item = await this.svc.findOne(id, version);
    return { item };
  }

  /** `POST /quant/labels` —— 新建标签定义（或新建版本） */
  @Post()
  async create(@Body() body: unknown) {
    const dto = validateCreateLabel(body);
    const item = await this.svc.create(dto);
    return { item };
  }

  /** `PATCH /quant/labels/:id/:version` —— 改展示元数据（语义字段不可改） */
  @Patch(':id/:version')
  async update(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    if (!id) throw new BadRequestException('id 必填');
    if (!version) throw new BadRequestException('version 必填');
    const dto = validateUpdateLabel(body);
    const item = await this.svc.update(id, version, dto);
    return { item };
  }
}

/**
 * 解析 list 查询串。
 *
 * - `enabled=true/false/1/0` → boolean；其它值抛 400
 * - `base_type` 非空字符串透传（DTO 层合法枚举由服务查 DB 确认，前端传未知值返回空列表）
 * - 其它未知 key 静默忽略（与本仓库其它 quant 查询风格一致）
 */
function parseListQuery(query: Record<string, unknown>): { enabled?: boolean; base_type?: string } {
  const out: { enabled?: boolean; base_type?: string } = {};

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

  if (typeof query.base_type === 'string' && query.base_type.length > 0) {
    out.base_type = query.base_type;
  }

  return out;
}
