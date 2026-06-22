import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUserParam as CurrentUser } from '../auth/decorators/current-user.decorator';
import { PreferencesService } from './preferences.service';

type CurrentUserPayload = { id: string };

@Controller('preferences')
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  @Get('symbols-view')
  getSymbolsView(@CurrentUser() user: CurrentUserPayload) {
    return this.preferencesService.getSymbolsView(user.id);
  }

  @Put('symbols-view')
  saveSymbolsView(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { crypto: unknown; aShares: unknown; usStocks?: unknown; aSharesIndex?: unknown },
  ) {
    return this.preferencesService.saveSymbolsView(user.id, body);
  }
}
