import { Controller, Get, Query } from '@nestjs/common';
import { IndexDailyService } from './index-daily.service';
import { QueryLatestDto } from './dto/latest.dto';
import { QueryKlineDto } from './dto/kline.dto';

/**
 * 行情表最新行情：GET /api/indices/latest
 * 前缀 'indices' 与 spec 接口清单对齐（行情表是「指数」视角）。
 */
@Controller('indices')
export class IndexLatestController {
  constructor(private readonly service: IndexDailyService) {}

  @Get('latest')
  latest(@Query() dto: QueryLatestDto) {
    return this.service.getLatest(dto);
  }
}

/**
 * K 线查询：GET /api/index-daily?ts_code=&start_date=&end_date=
 * 全 category（大盘/行业/概念）；旧 /ths-index-daily 薄封装仅 industry/concept。
 */
@Controller('index-daily')
export class IndexDailyController {
  constructor(private readonly service: IndexDailyService) {}

  @Get()
  kline(@Query() dto: QueryKlineDto) {
    return this.service.getKlines(dto);
  }
}
