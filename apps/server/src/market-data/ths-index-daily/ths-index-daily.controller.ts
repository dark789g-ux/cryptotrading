import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
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
}
