import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUserParam as CurrentUser } from '../../auth/decorators/current-user.decorator';
import { KdjParamsDto, validateKdjParams } from '../klines/dto/kdj-params.dto';
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

  /**
   * POST /api/us-index-daily/recalc?index_code=...&start_date=YYYYMMDD&end_date=YYYYMMDD
   *
   * 按自定义 KDJ 参数（n/m1/m2）重算指数 K 线的 KDJ 三列，其余字段保持原值。
   * kdjParams 缺省或等于默认 9/3/3 时直接返回原始数据。
   */
  @Post('recalc')
  recalcKlines(
    @Query() params: UsIndexQueryParams,
    @Body() body: { kdjParams?: KdjParamsDto },
  ) {
    if (!params.index_code) throw new BadRequestException('index_code 必填');
    if (!TRADE_DATE_RE.test(params.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(params.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (params.start_date! > params.end_date!) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }

    const kdjParams = body.kdjParams != null ? validateKdjParams(body.kdjParams) : undefined;
    return this.service.recalcKlines(params.index_code, {
      startDate: params.start_date as string,
      endDate: params.end_date as string,
    }, kdjParams);
  }

  @Post('sync')
  @AdminOnly()
  sync(@Body() body: UsIndexSyncBody, @CurrentUser() user: CurrentUserPayload) {
    return this.service.sync(body ?? {}, user?.id ?? null);
  }
}
