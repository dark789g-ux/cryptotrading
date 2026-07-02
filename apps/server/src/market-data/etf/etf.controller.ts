/**
 * ETF 查询 controller。
 *
 * GET /api/etf/latest        — ETF 列表（远程分页）
 * GET /api/etf/fund-types    — 基金类型枚举（distinct fund_type）
 * GET /api/etf/kline         — 单只 ETF K 线 + 指标
 * GET /api/etf/pcf           — 单只 ETF PCF 成分股明细
 */
import { Controller, Get, Query } from '@nestjs/common';
import { EtfQueryService, QueryEtfKlineDto, QueryEtfLatestDto, QueryEtfPcfDto } from './etf-query.service';

@Controller('etf')
export class EtfController {
  constructor(private readonly queryService: EtfQueryService) {}

  @Get('latest')
  latest(@Query() dto: QueryEtfLatestDto) {
    return this.queryService.getLatest(dto);
  }

  @Get('fund-types')
  fundTypes() {
    return this.queryService.getFundTypes();
  }

  @Get('kline')
  kline(@Query() dto: QueryEtfKlineDto) {
    return this.queryService.getKlines(dto);
  }

  @Get('pcf')
  pcf(@Query() dto: QueryEtfPcfDto) {
    return this.queryService.getPcf(dto);
  }
}
