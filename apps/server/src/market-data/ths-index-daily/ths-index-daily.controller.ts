import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { KdjParamsDto, validateKdjParams } from '../klines/dto/kdj-params.dto';
import { ThsIndexDailyService } from './ths-index-daily.service';
import { ThsIndexDailyQueryDto } from './dto/query.dto';

const TRADE_DATE_RE = /^\d{8}$/;

@Controller('ths-index-daily')
export class ThsIndexDailyController {
  constructor(private readonly service: ThsIndexDailyService) {}

  @Get()
  async getKlines(@Query() dto: ThsIndexDailyQueryDto) {
    if (!dto.ts_code) throw new BadRequestException('ts_code 必填');
    if (!TRADE_DATE_RE.test(dto.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(dto.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (dto.start_date > dto.end_date) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }
    return this.service.getKlines(dto);
  }

  @Get('date-range')
  getDateRange() {
    return this.service.getDateRange();
  }

  /**
   * POST /api/ths-index-daily/recalc?ts_code=...&start_date=YYYYMMDD&end_date=YYYYMMDD
   *
   * 按自定义 KDJ 参数（n/m1/m2）重算同花顺指数 K 线的 KDJ 三列，其余字段保持原值。
   * kdjParams 缺省或等于默认 9/3/3 时直接返回原始数据。
   */
  @Post('recalc')
  recalcKlines(
    @Query() dto: ThsIndexDailyQueryDto,
    @Body() body: { kdjParams?: KdjParamsDto },
  ) {
    if (!dto.ts_code) throw new BadRequestException('ts_code 必填');
    if (!TRADE_DATE_RE.test(dto.start_date ?? '')) {
      throw new BadRequestException('start_date 必须为 8 位 YYYYMMDD');
    }
    if (!TRADE_DATE_RE.test(dto.end_date ?? '')) {
      throw new BadRequestException('end_date 必须为 8 位 YYYYMMDD');
    }
    if (dto.start_date > dto.end_date) {
      throw new BadRequestException('start_date 不能大于 end_date');
    }

    const kdjParams = body.kdjParams != null ? validateKdjParams(body.kdjParams) : undefined;
    return this.service.recalcKlines(dto, kdjParams);
  }
}
