import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../auth/decorators/current-user.decorator';
import { PreferencesService, isValidTableId } from './preferences.service';

type CurrentUserPayload = { id: string };

@Controller('preferences')
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  @Get('columns/:tableId')
  getTableColumns(@CurrentUser() user: CurrentUserPayload, @Param('tableId') tableId: string) {
    if (!isValidTableId(tableId)) {
      throw new BadRequestException(`unknown tableId: ${tableId}`);
    }
    return this.preferencesService.getTableColumns(user.id, tableId);
  }

  @Put('columns/:tableId')
  saveTableColumns(
    @CurrentUser() user: CurrentUserPayload,
    @Param('tableId') tableId: string,
    @Body() body: { table?: unknown; split?: unknown },
  ) {
    if (!isValidTableId(tableId)) {
      throw new BadRequestException(`unknown tableId: ${tableId}`);
    }
    return this.preferencesService.saveTableColumns(user.id, tableId, body);
  }
}
