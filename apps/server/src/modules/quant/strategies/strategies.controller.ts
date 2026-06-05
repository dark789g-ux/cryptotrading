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
import { QuantStrategiesService } from './strategies.service';
import { validateCreateStrategy } from './dto/create-strategy.dto';
import { validateUpdateStrategy } from './dto/update-strategy.dto';

/**
 * `GET / POST / PATCH /api/quant/strategies/*` 端点（出场策略定义管理）。
 *
 * 鉴权约束（CLAUDE.md + .claude/rules/nestjs.md + spec 04）：
 *   - 全局 AuthGuard 已通过 APP_GUARD 注册，本 controller **禁止**再加 `@UseGuards(AuthGuard)`
 *     （否则在本模块上下文解析 Guard 依赖 → Can't resolve dependencies）
 *   - 类级 `@UseGuards(AdminGuard)` 把整个 `/quant/strategies/*` 收口为 admin-only
 *
 * Endpoints（spec 04 §3）：
 *   GET   /api/quant/strategies                    ?enabled=true|false → { items }
 *   GET   /api/quant/strategies/exit-rule-types                        → { items }
 *   GET   /api/quant/strategies/:id/:version                           → { item }
 *   POST  /api/quant/strategies                                        → { item }
 *   PATCH /api/quant/strategies/:id/:version                           → { item }
 *
 * ⚠ 路由顺序：`exit-rule-types` 静态段必须**先于** `:id/:version` 动态路由声明，
 * 否则 NestJS 会把 "exit-rule-types" 解析为 :id（被参数路由吃掉）。
 *
 * 命名避碰：项目已有顶层 `apps/server/src/strategies/`（crypto 回测域）；本 controller
 * 路由前缀是 `quant/strategies`，service 是 `QuantStrategiesService`，互不冲突。
 */
@Controller('quant/strategies')
@UseGuards(AdminGuard)
export class StrategiesController {
  constructor(private readonly svc: QuantStrategiesService) {}

  /** `GET /quant/strategies/exit-rule-types` —— type 枚举 + params 元信息（供前端动态表单） */
  @Get('exit-rule-types')
  getExitRuleTypes() {
    return this.svc.getExitRuleTypes();
  }

  /** `GET /quant/strategies?enabled=true|false` */
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const filter = parseListQuery(query ?? {});
    const items = await this.svc.list(filter);
    return { items };
  }

  /** `GET /quant/strategies/:id/:version` */
  @Get(':id/:version')
  async findOne(@Param('id') id: string, @Param('version') version: string) {
    if (!id) throw new BadRequestException('id 必填');
    if (!version) throw new BadRequestException('version 必填');
    const item = await this.svc.findOne(id, version);
    return { item };
  }

  /** `POST /quant/strategies` —— 新建策略定义（或新建版本） */
  @Post()
  async create(@Body() body: unknown) {
    const dto = validateCreateStrategy(body);
    const item = await this.svc.create(dto);
    return { item };
  }

  /** `PATCH /quant/strategies/:id/:version` —— 改展示元数据（语义字段不可改 → 422） */
  @Patch(':id/:version')
  async update(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    if (!id) throw new BadRequestException('id 必填');
    if (!version) throw new BadRequestException('version 必填');
    const dto = validateUpdateStrategy(body);
    const item = await this.svc.update(id, version, dto);
    return { item };
  }
}

/**
 * 解析 list 查询串。
 *
 * - `enabled=true/false/1/0` → boolean；其它值抛 400
 * - 其它未知 key 静默忽略（与本仓库其它 quant 查询风格一致）
 */
function parseListQuery(query: Record<string, unknown>): { enabled?: boolean } {
  const out: { enabled?: boolean } = {};

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

  return out;
}
