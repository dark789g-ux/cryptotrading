import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from 'rxjs';
import { BacktestRunEntity } from '../entities/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest-trade.entity';

import { StrategyEntity } from '../entities/strategy.entity';
import { BacktestDataService } from './engine/data.service';
import { runBacktest } from './engine/engine';
import { calcStats, prepareReportData } from './engine/report';
import { BacktestConfig, DEFAULT_CONFIG } from './engine/models';

export interface SseEvent {
  type: 'start' | 'progress' | 'done' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
  runId?: string;
}

@Injectable()
export class BacktestService {
  private isRunning = false;

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly runRepo: Repository<BacktestRunEntity>,
    @InjectRepository(BacktestTradeEntity)
    private readonly tradeRepo: Repository<BacktestTradeEntity>,
    @InjectRepository(StrategyEntity)
    private readonly strategyRepo: Repository<StrategyEntity>,
    private readonly dataService: BacktestDataService,
  ) {}

  /** 获取策略的历史回测列表 */
  async listRuns(strategyId: string) {
    return this.runRepo.find({
      where: { strategyId },
      order: { createdAt: 'DESC' },
    });
  }

  /** 获取单次回测详情（含 trades） */
  async getRun(runId: string) {
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) return null;
    const trades = await this.tradeRepo.find({ where: { runId } });
    return { ...run, trades };
  }

  /** 启动回测，返回 SSE Subject */
  startBacktest(strategyId: string, symbols: string[]): Subject<SseEvent> {
    const sub = new Subject<SseEvent>();
    if (this.isRunning) {
      sub.next({ type: 'error', message: '回测任务已在运行中，请稍后再试' });
      sub.complete();
      return sub;
    }
    this.isRunning = true;
    this.doBacktest(strategyId, symbols, sub).finally(() => {
      this.isRunning = false;
    });
    return sub;
  }

  private async doBacktest(strategyId: string, symbols: string[], sub: Subject<SseEvent>) {
    try {
      sub.next({ type: 'start' });

      // 1. 加载策略配置
      const strategy = await this.strategyRepo.findOneBy({ id: strategyId });
      if (!strategy) {
        sub.next({ type: 'error', message: `策略 ${strategyId} 不存在` });
        sub.complete();
        return;
      }

      const config: BacktestConfig = { ...DEFAULT_CONFIG, ...(strategy.params as object) };
      const targetSymbols = symbols.length ? symbols : (strategy.symbols ?? []);

      if (!targetSymbols.length) {
        sub.next({ type: 'error', message: '未选择任何交易对' });
        sub.complete();
        return;
      }

      sub.next({ type: 'progress', phase: '加载 K 线数据', current: 0, total: targetSymbols.length, percent: 5 });

      // 2. 从 DB 加载数据
      const { data, backtestStart } = await this.dataService.loadKlines(
        targetSymbols,
        config.timeframe,
        config,
      );

      if (!data.size) {
        sub.next({ type: 'error', message: '无可用数据' });
        sub.complete();
        return;
      }

      sub.next({ type: 'progress', phase: '运行回测引擎', current: 0, total: 100, percent: 10 });

      // 3. 运行回测引擎
      const { trades, portfolioLog, posSnapshots } = runBacktest(
        data,
        backtestStart,
        config,
        (current, total, pct) => {
          sub.next({
            type: 'progress',
            phase: '运行回测引擎',
            current,
            total,
            percent: 10 + pct * 0.7,
          });
        },
      );

      sub.next({ type: 'progress', phase: '计算统计指标', current: 90, total: 100, percent: 80 });

      // 4. 计算统计指标
      const stats = calcStats(trades, portfolioLog, config.initialCapital);
      const reportData = prepareReportData(trades, portfolioLog, stats, posSnapshots);

      // 5. 存储结果
      sub.next({ type: 'progress', phase: '保存结果', current: 95, total: 100, percent: 90 });

      const run = this.runRepo.create({
        strategyId,
        timeframe: config.timeframe,
        dateStart: config.dateStart,
        dateEnd: config.dateEnd,
        symbols: targetSymbols,
        stats: reportData,
      });
      const savedRun = await this.runRepo.save(run);

      // 存储逐笔交易（只保存完整交易）
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
        await this.tradeRepo.save(tradeEntities as BacktestTradeEntity[]);
      }

      // 更新策略最新回测信息
      await this.strategyRepo.update(strategyId, {
        lastBacktestAt: savedRun.createdAt,
        lastBacktestReturn: stats.totalReturnPct,
        symbols: targetSymbols,
      });

      sub.next({ type: 'done', message: '回测完成', runId: savedRun.id, percent: 100 });
      sub.complete();
    } catch (err) {
      sub.next({ type: 'error', message: String((err as any)?.message || err) });
      sub.complete();
    }
  }
}
