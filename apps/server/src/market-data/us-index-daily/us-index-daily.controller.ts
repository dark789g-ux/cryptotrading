import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UsIndexDailyService } from './us-index-daily.service';
import type { UsIndexQueryParams, UsIndexSyncBody } from './us-index-daily.types';

type CurrentUserPayload = { id: string };

const TRADE_DATE_RE = /^\d{8}$/;

@Controller('us-index-daily')
export class UsIndexDailyController {
  constructor(private readonly service: UsIndexDailyService) {}

  @Get()
  getKlines(@Query() params: UsIndexQueryParams) {
    if (!params.index_code) throw new BadRequestException('index_code 必填');
    if (!TRADE_DATE_RE.test(params.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(params.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    return this.service.getKlines(
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
  sync(@Body() body: UsIndexSyncBody, @CurrentUser() user: CurrentUserPayload) {
    return this.service.sync(body ?? {}, user?.id ?? null);
  }
}
