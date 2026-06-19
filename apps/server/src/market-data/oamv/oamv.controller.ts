import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { KdjParamsDto, validateKdjParams } from '../klines/dto/kdj-params.dto'
import { OamvService } from './oamv.service'
import { AdminOnly } from '../../auth/decorators/admin-only.decorator'

@Controller('oamv')
export class OamvController {
  constructor(private readonly oamvService: OamvService) {}

  @Get('date-range')
  getDateRange() {
    return this.oamvService.getDateRange()
  }

  @Post('sync')
  @AdminOnly()
  async sync0amv(
    @Body() body: { startDate?: string; endDate?: string; syncMode?: 'incremental' | 'overwrite' } = {},
  ) {
    const result = await this.oamvService.sync0amv(body)
    return { success: true, ...result }
  }

  // days：未选区间时取最近 N 条（面板默认"看近期象限"）；
  // startDate/endDate（YYYYMMDD）：工具栏日期选择器选了区间时按 trade_date 闭区间过滤，
  // 有区间则忽略 days（见 service）。
  @Get('data')
  async get0amvData(
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const daysNum = days ? parseInt(days, 10) : 250
    const range = startDate || endDate ? { startDate, endDate } : undefined
    return this.oamvService.get0amvData(daysNum, range)
  }

  /**
   * POST /api/oamv/recalc?days=...&startDate=...&endDate=...
   *
   * 按自定义 KDJ 参数（n/m1/m2）重算 0AMV 序列的 KDJ 三列，其余字段保持原值。
   * kdjParams 缺省或等于默认 9/3/3 时直接返回原始数据。
   */
  @Post('recalc')
  async recalcKlines(
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Body() body: { kdjParams?: KdjParamsDto } = {},
  ) {
    const daysNum = days ? parseInt(days, 10) : 250
    const range = startDate || endDate ? { startDate, endDate } : undefined
    const kdjParams = body.kdjParams != null ? validateKdjParams(body.kdjParams) : undefined
    return this.oamvService.recalcKlines(daysNum, range, kdjParams)
  }
}
