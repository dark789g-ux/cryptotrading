import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { QuantScoresService } from '../services/quant-scores.service';
import {
  validateScoresCompareQuery,
  validateScoresDailyQuery,
  validateScoresListQuery,
  validateScoresTimeSeriesQuery,
} from '../dto/score-query.dto';

/**
 * `GET /quant/scores/*` 只读端点。
 *
 * 鉴权约束（CLAUDE.md）：
 *   AuthGuard 已通过 APP_GUARD 注册为全局守卫；本 Controller **禁止**再加 `@UseGuards(AuthGuard)`。
 */
@Controller('quant/scores')
export class QuantScoresController {
  constructor(private readonly svc: QuantScoresService) {}

  /**
   * 顶层列表（M3 spec §5 主端点）：
   *   `GET /quant/scores?trade_date=YYYYMMDD&model_version=...&top_k=&page=&page_size=&sort=rank_in_day,asc`
   *
   * 返回 `{ items: ScoreRow[]; total: number; trade_date; model_version }`，
   * 支持分页 + 排序（service 内经 FIELD_COL_MAP 翻译；未命中 warn+回退 rank_in_day ASC）。
   */
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const dto = validateScoresListQuery(query ?? {});
    return this.svc.listScores(dto);
  }

  /** 当日 Top-K：`GET /quant/scores/daily?trade_date=&model_version=&top_k=` */
  @Get('daily')
  async getDaily(@Query() query: Record<string, unknown>) {
    const dto = validateScoresDailyQuery(query ?? {});
    const items = await this.svc.getDailyTopK(dto);
    return {
      trade_date: dto.tradeDate,
      model_version: dto.modelVersion,
      top_k: dto.topK,
      items,
    };
  }

  /** 当前可用 model_version 列表（用于版本切换器）。 */
  @Get('model-versions')
  async listModelVersions() {
    const items = await this.svc.getModelVersions();
    return { items };
  }

  /** 多模型同日对比：`GET /quant/scores/compare?trade_date=&model_versions=v1,v2&top_k=` */
  @Get('compare')
  async compare(@Query() query: Record<string, unknown>) {
    const dto = validateScoresCompareQuery(query ?? {});
    const groups = await this.svc.compareModels(dto);
    return {
      trade_date: dto.tradeDate,
      top_k: dto.topK,
      groups,
    };
  }

  /**
   * 单股票评分时间序列：`GET /quant/scores/ts/:ts_code?model_version=&start=&end=`
   *
   * 注意：路由放在最后，避免 NestJS 把 `daily`/`model-versions`/`compare` 等子路径匹配到
   * `:ts_code` 参数上。
   */
  @Get('ts/:ts_code')
  async getTimeSeries(
    @Param('ts_code') tsCode: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!tsCode) {
      throw new BadRequestException('ts_code 必填');
    }
    const dto = validateScoresTimeSeriesQuery(tsCode, query ?? {});
    const items = await this.svc.getTimeSeries(dto);
    return {
      ts_code: dto.tsCode,
      model_version: dto.modelVersion,
      start: dto.start,
      end: dto.end,
      items,
    };
  }
}
