import { Controller, Get, Post, Param, Body, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { BacktestService } from './backtest.service';

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

  /**
   * GET /api/backtest/start/:strategyId — SSE 推送回测进度
   * body: { symbols: string[] }
   */
  @Post('start/:strategyId')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  startBacktest(
    @Param('strategyId') strategyId: string,
    @Body() body: { symbols?: string[] },
    @Res() res: Response,
  ) {
    res.flushHeaders();
    const subject = this.backtestService.startBacktest(strategyId, body.symbols ?? []);
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }
}
