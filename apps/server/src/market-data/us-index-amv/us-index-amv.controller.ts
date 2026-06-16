import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UsIndexAmvService } from './us-index-amv.service';
import type { UsIndexAmvQueryParams, UsIndexAmvSyncBody } from './us-index-amv.types';

type CurrentUserPayload = { id: string };

const TRADE_DATE_RE = /^\d{8}$/;

/**
 * 美股指数活跃市值（AMV）只读查询 + 触发 controller。
 *
 * 全局已注册 AuthGuard（APP_GUARD），此处**禁** @UseGuards(AuthGuard)（.claude/rules/nestjs.md：
 * 重复加会让 NestJS 在本模块解析 Guard 依赖 → Can't resolve dependencies）。
 */
@Controller('us-index-amv')
export class UsIndexAmvController {
  constructor(private readonly service: UsIndexAmvService) {}

  @Get()
  getSeries(@Query() params: UsIndexAmvQueryParams) {
    if (!params.index_code) throw new BadRequestException('index_code 必填');
    if (!TRADE_DATE_RE.test(params.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(params.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    return this.service.getSeries(
      params.index_code,
      params.start_date as string,
      params.end_date as string,
    );
  }

  @Get('date-range')
  getDateRange(@Query('index_code') indexCode: string | undefined) {
    if (!indexCode) throw new BadRequestException('index_code 必填');
    return this.service.getDateRange(indexCode);
  }

  @Post('sync')
  @AdminOnly()
  sync(@Body() body: UsIndexAmvSyncBody, @CurrentUser() user: CurrentUserPayload) {
    return this.service.sync(body ?? {}, user?.id ?? null);
  }
}
