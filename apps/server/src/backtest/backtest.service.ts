import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BacktestRunEntity } from '../entities/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest-trade.entity';
import { BacktestCandleLogEntity } from '../entities/backtest-candle-log.entity';

import { StrategyEntity } from '../entities/strategy.entity';
import { BacktestDataService } from './engine/data.service';
import { runBacktest } from './engine/engine';
import { calcStats, prepareReportData } from './engine/report';
import { BacktestConfig, DEFAULT_CONFIG, validateConfig } from './engine/models';

export interface BacktestProgress {
  status: 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  currentTs: string | null;
  startTs: string | null;
  endTs: string | null;
  startedAt: number;
  elapsedMs: number;
  etaMs: number | null;
  message?: string;
  runId?: string;
}

const PROGRESS_RETENTION_MS = 30_000;
type StatsRow = Record<string, unknown>;

interface PositionQueryOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'ASC' | 'DESC';
  symbol?: string;
  pnlMin?: number;
  pnlMax?: number;
  returnPctMin?: number;
  returnPctMax?: number;
  stopType?: string;
  entryStart?: string;
  entryEnd?: string;
  closeStart?: string;
  closeEnd?: string;
}

interface SymbolQueryOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'ASC' | 'DESC';
  symbol?: string;
  totalPnlMin?: number;
  totalPnlMax?: number;
  winRateMin?: number;
  winRateMax?: number;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function matchesNumberRange(value: unknown, min?: number, max?: number): boolean {
  const num = asNumber(value);
  if (num === null) return min === undefined && max === undefined;
  if (min !== undefined && num < min) return false;
  if (max !== undefined && num > max) return false;
  return true;
}

function matchesTimeRange(value: unknown, start?: string, end?: string): boolean {
  const time = asString(value);
  if (!start && !end) return true;
  if (!time) return false;
  if (start && time < start) return false;
  if (end && time > end) return false;
  return true;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private isRunning = false;
  private readonly progressMap = new Map<string, BacktestProgress>();

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly runRepo: Repository<BacktestRunEntity>,
    @InjectRepository(BacktestTradeEntity)
    private readonly tradeRepo: Repository<BacktestTradeEntity>,
    @InjectRepository(StrategyEntity)
    private readonly strategyRepo: Repository<StrategyEntity>,
    @InjectRepository(BacktestCandleLogEntity)
    private readonly candleLogRepo: Repository<BacktestCandleLogEntity>,
    private readonly dataService: BacktestDataService,
  ) {}

  async listRuns(strategyId: string) {
    return this.runRepo.find({
      where: { strategyId },
      order: { createdAt: 'DESC' },
    });
  }

  async getRun(runId: string) {
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) return null;
    const trades = await this.tradeRepo.find({ where: { runId } });
    return { ...run, trades };
  }

  async getRunPositions(
    runId: string,
    opts: PositionQueryOptions,
  ) {
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) return null;
    const reportData = (run.stats ?? {}) as Record<string, unknown>;
    let rows = [...((reportData.positions ?? []) as StatsRow[])];

    if (opts.symbol?.trim()) {
      rows = rows.filter((row) => asString(row.symbol) === opts.symbol!.trim());
    }
    if (opts.stopType?.trim()) {
      rows = rows.filter((row) =>
        Array.isArray(row.stopTypes) &&
        row.stopTypes.some((item) => asString(item) === opts.stopType!.trim()),
      );
    }

    rows = rows.filter((row) =>
      matchesNumberRange(row.pnl, opts.pnlMin, opts.pnlMax) &&
      matchesNumberRange(row.returnPct, opts.returnPctMin, opts.returnPctMax) &&
      matchesTimeRange(row.entryTime, opts.entryStart, opts.entryEnd) &&
      matchesTimeRange(row.closeTime, opts.closeStart, opts.closeEnd),
    );

    const ALLOWED = ['entryTime', 'entryPrice', 'closeTime', 'sellPrice', 'pnl', 'returnPct', 'holdCandles'];
    const sortBy = ALLOWED.includes(opts.sortBy ?? '') ? opts.sortBy! : 'entryTime';
    const dir = opts.sortOrder === 'ASC' ? 1 : -1;

    rows.sort((a, b) => {
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });

    const total = rows.length;
    const start = (opts.page - 1) * opts.pageSize;
    return { rows: rows.slice(start, start + opts.pageSize), total, page: opts.page, pageSize: opts.pageSize };
  }

  async getRunSymbols(
    runId: string,
    opts: SymbolQueryOptions,
  ) {
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) return null;
    const reportData = (run.stats ?? {}) as Record<string, unknown>;
    let rows = [...((reportData.symbols ?? []) as StatsRow[])];

    if (opts.symbol?.trim()) {
      rows = rows.filter((row) => asString(row.symbol) === opts.symbol!.trim());
    }

    rows = rows.filter((row) =>
      matchesNumberRange(row.totalPnl, opts.totalPnlMin, opts.totalPnlMax) &&
      matchesNumberRange(row.winRate, opts.winRateMin, opts.winRateMax),
    );

    const ALLOWED = ['posCount', 'winRate', 'totalPnl', 'avgReturn', 'bestReturn', 'worstReturn', 'avgHold'];
    const sortBy = ALLOWED.includes(opts.sortBy ?? '') ? opts.sortBy! : 'totalPnl';
    const dir = opts.sortOrder === 'ASC' ? 1 : -1;

    rows.sort((a, b) => {
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });

    const total = rows.length;
    const start = (opts.page - 1) * opts.pageSize;
    return { rows: rows.slice(start, start + opts.pageSize), total, page: opts.page, pageSize: opts.pageSize };
  }

  getProgress(strategyId: string): BacktestProgress | null {
    const p = this.progressMap.get(strategyId);
    if (!p) return null;
    if (p.status !== 'running') return p;
    const elapsedMs = Date.now() - p.startedAt;
    const etaMs =
      p.percent > 0 && p.percent < 100
        ? Math.max(0, (elapsedMs * (100 - p.percent)) / p.percent)
        : null;
    return { ...p, elapsedMs, etaMs };
  }

  /** 启动回测，立即返回；通过 getProgress 轮询进度 */
  startBacktest(strategyId: string, symbols: string[]): { ok: boolean; message?: string } {
    if (this.isRunning) {
      return { ok: false, message: '回测任务已在运行中，请稍后再试' };
    }
    this.isRunning = true;
    this.progressMap.set(strategyId, {
      status: 'running',
      phase: '初始化',
      percent: 0,
      currentTs: null,
      startTs: null,
      endTs: null,
      startedAt: Date.now(),
      elapsedMs: 0,
      etaMs: null,
    });
    this.doBacktest(strategyId, symbols).finally(() => {
      this.isRunning = false;
    });
    return { ok: true };
  }

  private updateProgress(strategyId: string, patch: Partial<BacktestProgress>) {
    const cur = this.progressMap.get(strategyId);
    if (!cur) return;
    const next: BacktestProgress = { ...cur, ...patch };
    next.elapsedMs = Date.now() - next.startedAt;
    if (next.status === 'running' && next.percent > 0 && next.percent < 100) {
      next.etaMs = Math.max(0, (next.elapsedMs * (100 - next.percent)) / next.percent);
    }
    this.progressMap.set(strategyId, next);
  }

  private finalizeProgress(strategyId: string, patch: Partial<BacktestProgress>) {
    this.updateProgress(strategyId, patch);
    setTimeout(() => this.progressMap.delete(strategyId), PROGRESS_RETENTION_MS);
  }

  private async doBacktest(strategyId: string, symbols: string[]) {
    try {
      const strategy = await this.strategyRepo.findOneBy({ id: strategyId });
      if (!strategy) {
        this.finalizeProgress(strategyId, { status: 'error', message: `策略 ${strategyId} 不存在` });
        return;
      }

      const params = (strategy.params ?? {}) as Partial<BacktestConfig>;
      const config: BacktestConfig = { ...DEFAULT_CONFIG, ...params };
      validateConfig(config);
      const targetSymbols = symbols.length ? symbols : (strategy.symbols ?? []);

      if (!targetSymbols.length) {
        this.finalizeProgress(strategyId, { status: 'error', message: '未选择任何交易对' });
        return;
      }

      this.updateProgress(strategyId, { phase: '加载 K 线数据', percent: 2 });

      const { data, backtestStart } = await this.dataService.loadKlines(
        targetSymbols,
        config.timeframe,
        config,
      );

      if (!data.size) {
        this.finalizeProgress(strategyId, { status: 'error', message: '无可用数据' });
        return;
      }

      // 计算全局时间轴端点，用于按时长比例展示进度
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

      this.updateProgress(strategyId, {
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
          // 引擎阶段占整体 5% ~ 90%
          const overall = 5 + Math.max(0, Math.min(100, timePct)) * 0.85;
          this.updateProgress(strategyId, {
            phase: '运行回测引擎',
            percent: overall,
            currentTs,
          });
        },
      );

      this.updateProgress(strategyId, { phase: '计算统计指标', percent: 92 });
      const stats = calcStats(trades, portfolioLog, config.initialCapital, config.timeframe);
      const reportData = prepareReportData(trades, portfolioLog, stats, config.maxPositions, posSnapshots);

      this.updateProgress(strategyId, { phase: '保存结果', percent: 96 });

      const run = this.runRepo.create({
        strategyId,
        timeframe: config.timeframe,
        dateStart: config.dateStart,
        dateEnd: config.dateEnd,
        symbols: targetSymbols,
        stats: reportData,
        configSnapshot: config as unknown as Record<string, unknown>,
      });
      const savedRun = await this.runRepo.save(run);

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

      // ── 批量写入逐根 K 线日志（引擎若返回 candleLog 则持久化） ──
      if (candleLog && candleLog.length > 0) {
        const CHUNK_SIZE = 500;
        for (let i = 0; i < candleLog.length; i += CHUNK_SIZE) {
          const chunk = candleLog.slice(i, i + CHUNK_SIZE);
          const values = chunk.map((entry) => ({
            runId: savedRun.id,
            barIdx: entry.barIdx,
            // ts 字段来自引擎格式 "YYYY-MM-DD HH:mm:ss"，转为 ISO 再解析为 UTC Date
            ts: new Date(entry.ts.replace(' ', 'T') + 'Z'),
            openEquity: String(entry.openEquity),
            closeEquity: String(entry.closeEquity),
            posCount: entry.posCount,
            maxPositions: config.maxPositions,
            entriesJson: entry.entries,
            exitsJson: entry.exits,
            inCooldown: entry.inCooldown,
          }));
          await this.candleLogRepo
            .createQueryBuilder()
            .insert()
            .into(BacktestCandleLogEntity)
            .values(values)
            .execute();
        }
        this.logger.log(`candleLog 写入完成：runId=${savedRun.id}，共 ${candleLog.length} 条`);
      }

      await this.strategyRepo.update(strategyId, {
        lastBacktestAt: savedRun.createdAt,
        lastBacktestReturn: stats.totalReturnPct,
        symbols: targetSymbols,
      });

      this.finalizeProgress(strategyId, {
        status: 'done',
        phase: '完成',
        percent: 100,
        runId: savedRun.id,
        message: '回测完成',
      });
    } catch (err) {
      const e = err as Error;
      this.logger.error(`回测失败 strategyId=${strategyId}: ${e.message}`, e.stack);
      this.finalizeProgress(strategyId, {
        status: 'error',
        message: e.message || String(err),
      });
    }
  }
}
