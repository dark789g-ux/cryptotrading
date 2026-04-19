import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { SymbolPresetsService } from './symbol-presets.service';

@Controller('symbol-presets')
export class SymbolPresetsController {
  constructor(private readonly service: SymbolPresetsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() body: { name: string; symbols?: string[] }) {
    return this.service.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; symbols?: string[] }) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
