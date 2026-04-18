import { Controller, Get, Post, Param, Body, HttpCode, Query, NotFoundException } from '@nestjs/common';
import { BacktestService } from './backtest.service';

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
