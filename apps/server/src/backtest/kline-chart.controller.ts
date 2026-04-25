import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { calcBrickChartPoints, type BrickChartPoint } from '../indicators/brick-chart';
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';
import { KlineEntity } from '../entities/kline.entity';
import { fmtTs, parseUTC } from './utils/backtest-ts.util';

export interface TradeOnBar {
  type: 'entry' | 'exit';
  symbol: string;
  price: number;
  shares: number;
  reason: string;
  pnl?: number;
  isHalf?: boolean;
  kellyRaw?: number;
  kellyAdjusted?: number;
  positionRatio?: number;
  windowWinRate?: number;
  windowOdds?: number;
}

export interface KlineChartBar {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  MA5: number | null;
  MA30: number | null;
  MA60: number | null;
  MA120: number | null;
  MA240: number | null;
  'KDJ.K': number | null;
  'KDJ.D': number | null;
  'KDJ.J': number | null;
  DIF: number | null;
  DEA: number | null;
  MACD: number | null;
  BBI: number | null;
  brickChart?: BrickChartPoint;
  trades?: TradeOnBar[];
}

function toBar(entity: KlineEntity): KlineChartBar {
  return {
    open_time: fmtTs(entity.openTime),
    open: parseFloat(entity.open),
    high: parseFloat(entity.high),
    low: parseFloat(entity.low),
    close: parseFloat(entity.close),
    volume: parseFloat(entity.volume),
    MA5: entity.ma5 ?? null,
    MA30: entity.ma30 ?? null,
    MA60: entity.ma60 ?? null,
    MA120: entity.ma120 ?? null,
    MA240: entity.ma240 ?? null,
    'KDJ.K': entity.kdjK ?? null,
    'KDJ.D': entity.kdjD ?? null,
    'KDJ.J': entity.kdjJ ?? null,
    DIF: entity.dif ?? null,
    DEA: entity.dea ?? null,
    MACD: entity.macd ?? null,
    BBI: entity.bbi ?? null,
  };
}

interface RawEntry {
  symbol: string;
  price: number;
  shares: number;
  reason: string;
  kellyRaw?: number;
  kellyAdjusted?: number;
  positionRatio?: number;
  windowWinRate?: number;
  windowOdds?: number;
}

interface RawExit {
  symbol: string;
  price: number;
  shares: number;
  reason: string;
  pnl: number;
  isHalf?: boolean;
}

@Controller('backtest/runs/:runId/kline-chart')
export class KlineChartController {
  private readonly logger = new Logger(KlineChartController.name);

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly runRepo: Repository<BacktestRunEntity>,
    @InjectRepository(KlineEntity)
    private readonly klineRepo: Repository<KlineEntity>,
    @InjectRepository(BacktestCandleLogEntity)
    private readonly candleLogRepo: Repository<BacktestCandleLogEntity>,
  ) {}

  @Get()
  async getChart(
    @Param('runId') runId: string,
    @Query('symbol') symbol?: string,
    @Query('ts') tsRaw?: string,
    @Query('before') beforeRaw?: string,
    @Query('after') afterRaw?: string,
  ): Promise<KlineChartBar[]> {
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) throw new NotFoundException(`Backtest run ${runId} not found`);
    if (!symbol?.trim()) return [];

    const ts = parseUTC(tsRaw);
    if (!ts) return [];

    const interval = run.timeframe;
    const before = Math.min(500, Math.max(1, parseInt(beforeRaw ?? '100', 10) || 100));
    const after = Math.min(200, Math.max(0, parseInt(afterRaw ?? '30', 10) || 30));
    const sym = symbol.trim();

    try {
      const [preBars, postBars] = await Promise.all([
        this.klineRepo
          .createQueryBuilder('k')
          .where('k.symbol = :sym', { sym })
          .andWhere('k.interval = :interval', { interval })
          .andWhere('k.open_time <= :ts', { ts })
          .orderBy('k.open_time', 'DESC')
          .take(before + 1)
          .getMany(),
        this.klineRepo
          .createQueryBuilder('k')
          .where('k.symbol = :sym', { sym })
          .andWhere('k.interval = :interval', { interval })
          .andWhere('k.open_time > :ts', { ts })
          .orderBy('k.open_time', 'ASC')
          .take(after)
          .getMany(),
      ]);

      const bars = [...preBars.reverse(), ...postBars].map(toBar);
      if (!bars.length) return bars;

      const deltaMinRaw = run.configSnapshot?.brickDeltaMin;
      const deltaMin = typeof deltaMinRaw === 'number' ? deltaMinRaw : Number(deltaMinRaw ?? 0) || 0;
      const brickChart = calcBrickChartPoints(
        bars.map((bar) => ({
          high: bar.high,
          low: bar.low,
          close: bar.close,
        })),
        deltaMin,
      );
      bars.forEach((bar, index) => {
        bar.brickChart = brickChart[index];
      });

      const minTs = parseUTC(bars[0].open_time)!;
      const maxTs = parseUTC(bars[bars.length - 1].open_time)!;

      const candleLogs = await this.candleLogRepo
        .createQueryBuilder('cl')
        .where('cl.run_id = :runId', { runId })
        .andWhere('cl.ts >= :minTs', { minTs })
        .andWhere('cl.ts <= :maxTs', { maxTs })
        .getMany();

      const tradeMap = new Map<string, TradeOnBar[]>();
      for (const log of candleLogs) {
        const key = fmtTs(log.ts);
        const trades: TradeOnBar[] = [];

        for (const entry of log.entriesJson as RawEntry[]) {
          if (entry.symbol === sym) {
            trades.push({
              type: 'entry',
              symbol: entry.symbol,
              price: entry.price,
              shares: entry.shares,
              reason: entry.reason,
              kellyRaw: entry.kellyRaw,
              kellyAdjusted: entry.kellyAdjusted,
              positionRatio: entry.positionRatio,
              windowWinRate: entry.windowWinRate,
              windowOdds: entry.windowOdds,
            });
          }
        }

        for (const exit of log.exitsJson as RawExit[]) {
          if (exit.symbol === sym) {
            trades.push({
              type: 'exit',
              symbol: exit.symbol,
              price: exit.price,
              shares: exit.shares,
              reason: exit.reason,
              pnl: exit.pnl,
              isHalf: exit.isHalf,
            });
          }
        }

        if (trades.length) tradeMap.set(key, trades);
      }

      for (const bar of bars) {
        const trades = tradeMap.get(bar.open_time);
        if (trades) bar.trades = trades;
      }

      return bars;
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `kline-chart query failed runId=${runId} symbol=${sym}: ${error.message}`,
        error.stack,
      );
      throw err;
    }
  }
}
