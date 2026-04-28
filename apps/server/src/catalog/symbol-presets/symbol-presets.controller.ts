import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SymbolPresetsService } from './symbol-presets.service';

type CurrentUserPayload = { id: string };

@Controller('symbol-presets')
export class SymbolPresetsController {
  constructor(private readonly service: SymbolPresetsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.service.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.service.get(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: { name: string; symbols?: string[] }) {
    return this.service.create(user.id, body);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { name?: string; symbols?: string[] }) {
    return this.service.update(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.service.remove(user.id, id);
  }
}
