import { Controller, Get, Post, Query } from '@nestjs/common'
import { OamvService } from './oamv.service'
import { AdminOnly } from '../../auth/decorators/admin-only.decorator'

@Controller('oamv')
export class OamvController {
  constructor(private readonly oamvService: OamvService) {}

  @Post('sync')
  @AdminOnly()
  async sync0amv() {
    const result = await this.oamvService.sync0amv()
    return { success: true, ...result }
  }

  @Get('data')
  async get0amvData(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 250
    return this.oamvService.get0amvData(daysNum)
  }
}
