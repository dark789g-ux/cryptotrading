import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { AdminOnly } from '../../auth/decorators/admin-only.decorator'
import { ActiveMvService } from './active-mv.service'
import type { IndustryAmvSyncOptions, StockAmvSyncOptions } from './active-mv.types'

/**
 * 活跃市值（AMV）API。spec §7。全局 /api 前缀 + 全局 AuthGuard 已注册，
 * 本 controller **不**加 @UseGuards(AuthGuard)（见 nestjs 规则）。
 *
 * 路由顺序：静态 `signals` 必须排在动态 `:tsCode` 之前，否则 `signals` 会被当成 tsCode。
 */
@Controller('active-mv')
export class ActiveMvController {
  constructor(private readonly activeMvService: ActiveMvService) {}

  // ==== 个股 ====

  @Post('stock/sync')
  @AdminOnly()
  syncStock(@Body() body: StockAmvSyncOptions = {}) {
    return this.activeMvService.syncStock(body)
  }

  @Get('stock/signals')
  getStockSignals(@Query('tradeDate') tradeDate: string) {
    return this.activeMvService.getStockSignals(tradeDate)
  }

  @Get('stock/:tsCode')
  getStock(@Param('tsCode') tsCode: string, @Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 250
    return this.activeMvService.getStock(tsCode, daysNum)
  }

  // ==== 行业 ====

  @Post('industry/sync')
  @AdminOnly()
  syncIndustry(@Body() body: IndustryAmvSyncOptions = {}) {
    return this.activeMvService.syncIndustry(body)
  }

  @Get('industry/signals')
  getIndustrySignals(@Query('tradeDate') tradeDate: string) {
    return this.activeMvService.getIndustrySignals(tradeDate)
  }

  @Get('industry/:tsCode')
  getIndustry(@Param('tsCode') tsCode: string, @Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 250
    return this.activeMvService.getIndustry(tsCode, daysNum)
  }
}
