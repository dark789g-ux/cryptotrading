import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { AdminOnly } from '../../auth/decorators/admin-only.decorator'
import { ActiveMvService } from './active-mv.service'
import { assertSwIndexSuffix, parseAmvDaysAndRange } from './amv-query-params'
import type { StockAmvSyncOptions, SwIndexAmvSyncOptions, ThsIndexAmvSyncOptions } from './active-mv.types'

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

  // ==== 行业（type='I'） ====

  @Post('industry/sync')
  @AdminOnly()
  syncIndustry(@Body() body: ThsIndexAmvSyncOptions = {}) {
    return this.activeMvService.syncIndustry(body)
  }

  @Get('industry/signals')
  getIndustrySignals(@Query('tradeDate') tradeDate: string) {
    return this.activeMvService.getIndustrySignals(tradeDate)
  }

  @Get('industry/:tsCode')
  getIndustry(
    @Param('tsCode') tsCode: string,
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const { daysNum, range } = parseAmvDaysAndRange(days, startDate, endDate)
    return this.activeMvService.getIndustry(tsCode, daysNum, range)
  }

  // ==== 概念/板块（type='N'） ====

  @Post('concept/sync')
  @AdminOnly()
  syncConcept(@Body() body: ThsIndexAmvSyncOptions = {}) {
    return this.activeMvService.syncConcept(body)
  }

  // 路由顺序坑：静态 `signals` 必须排在动态 `:tsCode` 之前，否则会被当成 tsCode 吞掉。
  @Get('concept/signals')
  getConceptSignals(@Query('tradeDate') tradeDate: string) {
    return this.activeMvService.getConceptSignals(tradeDate)
  }

  @Get('concept/:tsCode')
  getConcept(
    @Param('tsCode') tsCode: string,
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const { daysNum, range } = parseAmvDaysAndRange(days, startDate, endDate)
    return this.activeMvService.getConcept(tsCode, daysNum, range)
  }

  // ==== 申万指数（.SI） ====

  @Post('sw/sync')
  @AdminOnly()
  syncSw(@Body() body: SwIndexAmvSyncOptions = {}) {
    return this.activeMvService.syncSw(body)
  }

  @Get('sw/:tsCode')
  getSw(
    @Param('tsCode') tsCode: string,
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    assertSwIndexSuffix(tsCode)
    const { daysNum, range } = parseAmvDaysAndRange(days, startDate, endDate)
    return this.activeMvService.getSw(tsCode, daysNum, range)
  }
}
