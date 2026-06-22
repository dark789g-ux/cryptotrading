import { Controller, Get, Query } from '@nestjs/common';
import { IndexCatalogQueryService } from './index-catalog-query.service';
import { QueryCatalogDto } from './dto/query-catalog.dto';

/**
 * 统一指数目录查询控制器。
 *
 * 路由前缀 `index-catalog`，配合 main.ts 全局 `/api` 前缀 →
 * `GET /api/index-catalog?category=&q=`
 *
 * 注：`index-catalog/sync` 子路径归 IndexCatalogSyncController，互不冲突。
 * AuthGuard 已通过 APP_GUARD 全局注册，查询路由只读无需 @AdminOnly。
 */
@Controller('index-catalog')
export class IndexCatalogController {
  constructor(private readonly queryService: IndexCatalogQueryService) {}

  @Get()
  findAll(@Query() dto: QueryCatalogDto) {
    return this.queryService.findAll(dto.category, dto.q);
  }
}
