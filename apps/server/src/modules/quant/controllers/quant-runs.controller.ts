import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { QuantRunsService } from '../services/quant-runs.service';
import { validateRunQuery } from '../dto/run-query.dto';

/**
 * `GET /quant/runs/*` 只读端点。
 *
 * 鉴权约束（CLAUDE.md）：
 *   AuthGuard 已通过 APP_GUARD 注册为全局守卫；本 Controller **禁止**再加 `@UseGuards(AuthGuard)`。
 */
@Controller('quant/runs')
export class QuantRunsController {
  constructor(private readonly svc: QuantRunsService) {}

  /** `GET /quant/runs?model_version=&sort_by=&page=&page_size=` */
  @Get()
  list(@Query() query: Record<string, unknown>) {
    const dto = validateRunQuery(query ?? {});
    return this.svc.list(dto);
  }

  /** `GET /quant/runs/:id` */
  @Get(':id')
  findOne(@Param('id') id: string) {
    if (!id || typeof id !== 'string') {
      throw new BadRequestException('id 必填');
    }
    return this.svc.findOne(id);
  }
}
