import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { StrategiesService } from './strategies.service';

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
    @Query('sortField') sortField?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ) {
    return this.strategiesService.listStrategies({ sortField, sortOrder });
  }

  /** GET /api/strategies/:id */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.strategiesService.getStrategy(id);
  }

  /** POST /api/strategies */
  @Post()
  create(@Body() body: { name?: string; typeId: string; params?: object; symbols?: string[] }) {
    return this.strategiesService.createStrategy(body);
  }

  /** PUT /api/strategies/:id */
  @Put(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; params?: object; symbols?: string[] }) {
    return this.strategiesService.updateStrategy(id, body);
  }

  /** DELETE /api/strategies/:id */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.strategiesService.deleteStrategy(id);
  }
}
