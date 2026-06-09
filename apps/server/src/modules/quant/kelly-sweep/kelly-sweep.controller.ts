import { Controller, Get, Param, Query } from '@nestjs/common';
import { KellySweepService } from './kelly-sweep.service';

/**
 * 凯利网格搜索结果查询接口（只读）。
 *
 * 基路由：`quant/kelly-sweep`（全局 `/api` 前缀 → `/api/quant/kelly-sweep`）。
 * 受全局 AuthGuard 保护（通过 APP_GUARD 注册，此处无需再加 @UseGuards）。
 *
 * 接口契约见 spec docs/superpowers/specs/2026-06-09-kelly-sweep-web-console-design/04-nestjs-api.md
 */
@Controller('quant/kelly-sweep')
export class KellySweepController {
  constructor(private readonly service: KellySweepService) {}

  /**
   * GET /api/quant/kelly-sweep/meta
   * 返回前端渲染表单所需的白名单常量（防前端硬编码漂移）。
   */
  @Get('meta')
  getMeta() {
    return this.service.getMeta();
  }

  /**
   * GET /api/quant/kelly-sweep/history?status=&page=&pageSize=
   * ml.jobs WHERE run_type='kelly_sweep' 列表，供历史下拉。
   * 注意：此路由必须在 /runs/:jobId/* 之前声明，否则 'history' 会被当作 jobId 匹配。
   */
  @Get('history')
  getHistory(
    @Query('status') status: string,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
  ) {
    return this.service.getHistory(status, page, pageSize);
  }

  /**
   * GET /api/quant/kelly-sweep/runs/:jobId/summary
   */
  @Get('runs/:jobId/summary')
  getSummary(@Param('jobId') jobId: string) {
    return this.service.getSummary(jobId);
  }

  /**
   * GET /api/quant/kelly-sweep/runs/:jobId/scatter?group=with_rs|no_rs
   * group 必填，只接受 'with_rs' 或 'no_rs'。
   */
  @Get('runs/:jobId/scatter')
  getScatter(@Param('jobId') jobId: string, @Query('group') group: string) {
    return this.service.getScatter(jobId, group);
  }

  /**
   * GET /api/quant/kelly-sweep/runs/:jobId/topk?group=&page=&pageSize=&sort=
   * is_topk 行分页，默认 kelly_valid DESC，含 CI。
   * group 必填。sort 格式：field 或 field:asc/field:desc（列名白名单化防注入）。
   */
  @Get('runs/:jobId/topk')
  getTopk(
    @Param('jobId') jobId: string,
    @Query('group') group: string,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('sort') sort: string,
  ) {
    return this.service.getTopk(jobId, group, page, pageSize, sort);
  }

  /**
   * GET /api/quant/kelly-sweep/runs/:jobId/rows/:rowId
   * 单行完整字段（详情弹窗）。注意：此路由必须在 /rows 之前声明，防止路由歧义。
   */
  @Get('runs/:jobId/rows/:rowId')
  getRow(@Param('jobId') jobId: string, @Param('rowId') rowId: string) {
    return this.service.getRow(jobId, rowId);
  }

  /**
   * GET /api/quant/kelly-sweep/runs/:jobId/rows?group=&page=&pageSize=&sort=
   * 全量行分页 + 排序。group 必填。
   */
  @Get('runs/:jobId/rows')
  getRows(
    @Param('jobId') jobId: string,
    @Query('group') group: string,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('sort') sort: string,
  ) {
    return this.service.getRows(jobId, group, page, pageSize, sort);
  }
}
