import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../auth/decorators/current-user.decorator';
import { PreferencesService, isValidTableId, isValidSyncScope, isValidKlinePrefsKey } from './preferences.service';

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

  @Get('sync-steps/:scope')
  getSyncSteps(@CurrentUser() user: CurrentUserPayload, @Param('scope') scope: string) {
    if (!isValidSyncScope(scope)) {
      throw new BadRequestException(`unknown sync-steps scope: ${scope}`);
    }
    return this.preferencesService.getSyncSteps(user.id, scope);
  }

  @Put('sync-steps/:scope')
  saveSyncSteps(
    @CurrentUser() user: CurrentUserPayload,
    @Param('scope') scope: string,
    @Body() body: { steps?: unknown },
  ) {
    if (!isValidSyncScope(scope)) {
      throw new BadRequestException(`unknown sync-steps scope: ${scope}`);
    }
    return this.preferencesService.saveSyncSteps(user.id, scope, body?.steps);
  }

  @Get('kline/:prefsKey')
  getKlinePrefs(@CurrentUser() user: CurrentUserPayload, @Param('prefsKey') prefsKey: string) {
    if (!isValidKlinePrefsKey(prefsKey)) {
      throw new BadRequestException(`unknown kline prefsKey: ${prefsKey}`);
    }
    return this.preferencesService.getKlinePrefs(user.id, prefsKey);
  }

  @Put('kline/:prefsKey')
  saveKlinePrefs(
    @CurrentUser() user: CurrentUserPayload,
    @Param('prefsKey') prefsKey: string,
    @Body() body: unknown,
  ) {
    if (!isValidKlinePrefsKey(prefsKey)) {
      throw new BadRequestException(`unknown kline prefsKey: ${prefsKey}`);
    }
    return this.preferencesService.saveKlinePrefs(user.id, prefsKey, body);
  }
}
