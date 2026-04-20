import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { BacktestService, type RunSymbolMetricsQueryDto } from './backtest.service';

function parseSymbolMetricsBody(body: unknown): RunSymbolMetricsQueryDto {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('请求体无效');
  }
  const o = body as Record<string, unknown>;
  const ts = typeof o.ts === 'string' ? o.ts : '';
  if (!ts.trim()) throw new BadRequestException('ts 不能为空');

  const page = Math.max(1, parseInt(String(o.page ?? '1'), 10) || 1);
  const page_size = Math.min(50, Math.max(1, parseInt(String(o.page_size ?? '20'), 10) || 20));

  let sort: { field: string; asc: boolean } = { field: 'symbol', asc: true };
  const sortRaw = o.sort;
  if (sortRaw !== null && typeof sortRaw === 'object' && !Array.isArray(sortRaw)) {
    const s = sortRaw as Record<string, unknown>;
    const field = typeof s.field === 'string' && s.field.trim() ? s.field.trim() : 'symbol';
    const asc = s.asc !== false;
    sort = { field, asc };
  }

  const q = typeof o.q === 'string' ? o.q : '';

  let conditions: { field: string; op: string; value: number }[] | undefined;
  const condRaw = o.conditions;
  if (Array.isArray(condRaw)) {
    conditions = [];
    for (const c of condRaw.slice(0, 10)) {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) continue;
      const c0 = c as Record<string, unknown>;
      const field = typeof c0.field === 'string' ? c0.field : '';
      const op = typeof c0.op === 'string' ? c0.op : '';
      const valueRaw = c0.value;
      const value =
        typeof valueRaw === 'number'
          ? valueRaw
          : typeof valueRaw === 'string'
            ? Number(valueRaw)
            : NaN;
      if (!field || !op || !Number.isFinite(value)) continue;
      conditions.push({ field, op, value });
    }
  }

  const only_buy_on_bar = o.only_buy_on_bar === true;
  const only_sell_on_bar = o.only_sell_on_bar === true;
  const only_open_at_close = o.only_open_at_close === true;

  return {
    ts: ts.trim(),
    q,
    conditions,
    sort,
    page,
    page_size,
    only_buy_on_bar,
    only_sell_on_bar,
    only_open_at_close,
  };
}

function parseOptionalNumber(raw?: string): number | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  /** GET /api/backtest/runs/:strategyId — 历史回测列表 */
  @Get('runs/:strategyId')
  listRuns(@Param('strategyId') strategyId: string) {
    return this.backtestService.listRuns(strategyId);
  }

  /** GET /api/backtest/run/:runId — 单次回测详情 */
  @Get('run/:runId')
  getRun(@Param('runId') runId: string) {
    return this.backtestService.getRun(runId);
  }

  /** GET /api/backtest/progress/:strategyId — 轮询回测进度 */
  @Get('progress/:strategyId')
  getProgress(@Param('strategyId') strategyId: string) {
    return this.backtestService.getProgress(strategyId);
  }

  /** GET /api/backtest/runs/:runId/positions — 仓位记录（分页+排序） */
  @Get('runs/:runId/positions')
  async getRunPositions(
    @Param('runId') runId: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrderRaw?: string,
    @Query('symbol') symbol?: string,
    @Query('pnlMin') pnlMinRaw?: string,
    @Query('pnlMax') pnlMaxRaw?: string,
    @Query('returnPctMin') returnPctMinRaw?: string,
    @Query('returnPctMax') returnPctMaxRaw?: string,
    @Query('stopType') stopType?: string,
    @Query('entryStart') entryStart?: string,
    @Query('entryEnd') entryEnd?: string,
    @Query('closeStart') closeStart?: string,
    @Query('closeEnd') closeEnd?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeRaw ?? '10', 10) || 10));
    const sortOrder = (sortOrderRaw ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const res = await this.backtestService.getRunPositions(runId, {
      page,
      pageSize,
      sortBy,
      sortOrder,
      symbol,
      pnlMin: parseOptionalNumber(pnlMinRaw),
      pnlMax: parseOptionalNumber(pnlMaxRaw),
      returnPctMin: parseOptionalNumber(returnPctMinRaw),
      returnPctMax: parseOptionalNumber(returnPctMaxRaw),
      stopType,
      entryStart,
      entryEnd,
      closeStart,
      closeEnd,
    });
    if (!res) throw new NotFoundException(`回测运行 ${runId} 不存在`);
    return res;
  }

  /** GET /api/backtest/runs/:runId/symbols — 标的盈亏统计（分页+排序） */
  @Get('runs/:runId/symbols')
  async getRunSymbols(
    @Param('runId') runId: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrderRaw?: string,
    @Query('symbol') symbol?: string,
    @Query('totalPnlMin') totalPnlMinRaw?: string,
    @Query('totalPnlMax') totalPnlMaxRaw?: string,
    @Query('winRateMin') winRateMinRaw?: string,
    @Query('winRateMax') winRateMaxRaw?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeRaw ?? '10', 10) || 10));
    const sortOrder = (sortOrderRaw ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const res = await this.backtestService.getRunSymbols(runId, {
      page,
      pageSize,
      sortBy,
      sortOrder,
      symbol,
      totalPnlMin: parseOptionalNumber(totalPnlMinRaw),
      totalPnlMax: parseOptionalNumber(totalPnlMaxRaw),
      winRateMin: parseOptionalNumber(winRateMinRaw),
      winRateMax: parseOptionalNumber(winRateMaxRaw),
    });
    if (!res) throw new NotFoundException(`回测运行 ${runId} 不存在`);
    return res;
  }

  /** POST /api/backtest/runs/:runId/symbol-metrics/query — 指定 ts 上回测标的池指标快照 */
  @Post('runs/:runId/symbol-metrics/query')
  @HttpCode(200)
  async queryRunSymbolMetrics(@Param('runId') runId: string, @Body() body: unknown) {
    const dto = parseSymbolMetricsBody(body);
    const res = await this.backtestService.queryRunSymbolMetricsAtTs(runId, dto);
    if (!res) throw new NotFoundException(`回测运行 ${runId} 不存在`);
    return res;
  }

  /** POST /api/backtest/start/:strategyId — 启动回测（立即返回） */
  @Post('start/:strategyId')
  @HttpCode(200)
  startBacktest(
    @Param('strategyId') strategyId: string,
    @Body() body: { symbols?: string[] },
  ) {
    return this.backtestService.startBacktest(strategyId, body.symbols ?? []);
  }
}
