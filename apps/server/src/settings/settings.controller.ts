import { Controller, Get, Put, Body, Param } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /** GET /api/settings/excluded-symbols */
  @Get('excluded-symbols')
  getExcluded() {
    return this.settingsService.getExcludedSymbols();
  }

  /** PUT /api/settings/excluded-symbols */
  @Put('excluded-symbols')
  setExcluded(@Body() body: { symbols: string[] }) {
    return this.settingsService.setExcludedSymbols(body.symbols);
  }

  /** GET /api/settings/config */
  @Get('config')
  getAllConfigs() {
    return this.settingsService.getAllConfigs();
  }

  /** GET /api/settings/config/:key */
  @Get('config/:key')
  getConfig(@Param('key') key: string) {
    return this.settingsService.getConfig(key);
  }

  /** PUT /api/settings/config/:key */
  @Put('config/:key')
  setConfig(@Param('key') key: string, @Body() body: { value: unknown }) {
    return this.settingsService.setConfig(key, body.value);
  }
}
