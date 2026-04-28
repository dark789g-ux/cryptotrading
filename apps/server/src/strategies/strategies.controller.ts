import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../auth/decorators/current-user.decorator';
import { StrategiesService } from './strategies.service';

type CurrentUserPayload = { id: string };

@Controller('strategies')
export class StrategiesController {
  constructor(private readonly strategiesService: StrategiesService) {}

  /** GET /api/strategies/types */
  @Get('types')
  listTypes() {
    return this.strategiesService.listTypes();
  }

  /** GET /api/strategies */
  @Get()
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('sortField') sortField?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeRaw ?? '10', 10) || 10));
    return this.strategiesService.listStrategies(user.id, { sortField, sortOrder, page, pageSize });
  }

  /** GET /api/strategies/:id */
  @Get(':id')
  get(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.strategiesService.getStrategy(user.id, id);
  }

  /** POST /api/strategies */
  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: { name?: string; typeId: string; params?: object; symbols?: string[] }) {
    return this.strategiesService.createStrategy(user.id, body);
  }

  /** PUT /api/strategies/:id */
  @Put(':id')
  update(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { name?: string; params?: object; symbols?: string[] }) {
    return this.strategiesService.updateStrategy(user.id, id, body);
  }

  /** DELETE /api/strategies/:id */
  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.strategiesService.deleteStrategy(user.id, id);
  }
}
