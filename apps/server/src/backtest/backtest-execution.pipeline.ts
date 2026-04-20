import type { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest/backtest-trade.entity';
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { StrategyEntity } from '../entities/strategy/strategy.entity';
import { BacktestDataService } from './engine/data.service';
import { runBacktest } from './engine/engine';
import { calcStats, prepareReportData } from './engine/report';
import { BacktestConfig, DEFAULT_CONFIG, validateConfig } from './engine/models';
import type { BacktestProgress } from './backtest.types';

export interface BacktestPipelineContext {
  logger: Logger;
  runRepo: Repository<BacktestRunEntity>;
  tradeRepo: Repository<BacktestTradeEntity>;
  strategyRepo: Repository<StrategyEntity>;
  candleLogRepo: Repository<BacktestCandleLogEntity>;
  dataService: BacktestDataService;
  updateProgress: (strategyId: string, patch: Partial<BacktestProgress>) => void;
  finalizeProgress: (strategyId: string, patch: Partial<BacktestProgress>) => void;
}

export async function executeBacktestPipeline(
  ctx: BacktestPipelineContext,
  strategyId: string,
  symbols: string[],
): Promise<void> {
  try {
    const strategy = await ctx.strategyRepo.findOneBy({ id: strategyId });
    if (!strategy) {
      ctx.finalizeProgress(strategyId, { status: 'error', message: `策略 ${strategyId} 不存在` });
      return;
    }

    const params = (strategy.params ?? {}) as Partial<BacktestConfig>;
    const config: BacktestConfig = { ...DEFAULT_CONFIG, ...params };
    validateConfig(config);
    const targetSymbols = symbols.length ? symbols : (strategy.symbols ?? []);

    if (!targetSymbols.length) {
      ctx.finalizeProgress(strategyId, { status: 'error', message: '未选择任何交易对' });
      return;
    }

    ctx.updateProgress(strategyId, { phase: '加载 K 线数据', percent: 2 });

    const { data, backtestStart } = await ctx.dataService.loadKlines(
      targetSymbols,
      config.timeframe,
      config,
    );

    if (!data.size) {
      ctx.finalizeProgress(strategyId, { status: 'error', message: '无可用数据' });
      return;
    }

    let minTs: string | null = null;
    let maxTs: string | null = null;
    for (const [sym, df] of data) {
      const bstart = backtestStart.get(sym) ?? 0;
      if (bstart < df.length) {
        const first = String(df[bstart].open_time);
        if (!minTs || first < minTs) minTs = first;
      }
      if (df.length) {
        const last = String(df[df.length - 1].open_time);
        if (!maxTs || last > maxTs) maxTs = last;
      }
    }
    const startMs = minTs ? Date.parse(minTs.replace(' ', 'T') + 'Z') : 0;
    const endMs = maxTs ? Date.parse(maxTs.replace(' ', 'T') + 'Z') : 0;
    const spanMs = Math.max(1, endMs - startMs);

    ctx.updateProgress(strategyId, {
      phase: '运行回测引擎',
      startTs: minTs,
      endTs: maxTs,
      percent: 5,
    });

    const { trades, portfolioLog, posSnapshots, candleLog } = await runBacktest(
      data,
      backtestStart,
      config,
      (_current, _total, _pct, currentTs) => {
        const curMs = Date.parse(currentTs.replace(' ', 'T') + 'Z');
        const timePct = ((curMs - startMs) / spanMs) * 100;
        const overall = 5 + Math.max(0, Math.min(100, timePct)) * 0.85;
        ctx.updateProgress(strategyId, {
          phase: '运行回测引擎',
          percent: overall,
          currentTs,
        });
      },
    );

    ctx.updateProgress(strategyId, { phase: '计算统计指标', percent: 92 });
    const stats = calcStats(trades, portfolioLog, config.initialCapital, config.timeframe);
    const reportData = prepareReportData(trades, portfolioLog, stats, config.maxPositions, posSnapshots);

    ctx.updateProgress(strategyId, { phase: '保存结果', percent: 96 });

    const run = ctx.runRepo.create({
      strategyId,
      timeframe: config.timeframe,
      dateStart: config.dateStart,
      dateEnd: config.dateEnd,
      symbols: targetSymbols,
      stats: reportData,
      configSnapshot: config as unknown as Record<string, unknown>,
    });
    const savedRun = await ctx.runRepo.save(run);

    if (trades.length) {
      const tradeEntities: Partial<BacktestTradeEntity>[] = trades.map((t) => ({
        runId: savedRun.id,
        symbol: t.symbol,
        entryTime: new Date(t.entryTime.replace(' ', 'T') + 'Z'),
        entryPrice: t.entryPrice,
        exitTime: new Date(t.exitTime.replace(' ', 'T') + 'Z'),
        exitPrice: t.exitPrice,
        pnl: t.pnl,
        pnlPct: t.returnPct,
        holdBars: t.holdCandles,
      }));
      await ctx.tradeRepo.save(tradeEntities as BacktestTradeEntity[]);
    }

    if (candleLog && candleLog.length > 0) {
      const CHUNK_SIZE = 500;
      for (let i = 0; i < candleLog.length; i += CHUNK_SIZE) {
        const chunk = candleLog.slice(i, i + CHUNK_SIZE);
        const values = chunk.map((entry) => ({
          runId: savedRun.id,
          barIdx: entry.barIdx,
          ts: new Date(entry.ts.replace(' ', 'T') + 'Z'),
          openEquity: String(entry.openEquity),
          closeEquity: String(entry.closeEquity),
          posCount: entry.posCount,
          maxPositions: config.maxPositions,
          entriesJson: entry.entries,
          exitsJson: entry.exits,
          openSymbolsJson: entry.openSymbols ?? [],
          inCooldown: entry.inCooldown,
          cooldownDuration: entry.cooldownDuration ?? null,
          cooldownRemaining: entry.cooldownRemaining ?? null,
        }));
        await ctx.candleLogRepo
          .createQueryBuilder()
          .insert()
          .into(BacktestCandleLogEntity)
          .values(values)
          .execute();
      }
      ctx.logger.log(`candleLog 写入完成：runId=${savedRun.id}，共 ${candleLog.length} 条`);
    }

    await ctx.strategyRepo.update(strategyId, {
      lastBacktestAt: savedRun.createdAt,
      lastBacktestReturn: stats.totalReturnPct,
      symbols: targetSymbols,
    });

    ctx.finalizeProgress(strategyId, {
      status: 'done',
      phase: '完成',
      percent: 100,
      runId: savedRun.id,
      message: '回测完成',
    });
  } catch (err) {
    const e = err as Error;
    ctx.logger.error(`回测失败 strategyId=${strategyId}: ${e.message}`, e.stack);
    ctx.finalizeProgress(strategyId, {
      status: 'error',
      message: e.message || String(err),
    });
  }
}
