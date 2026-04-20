import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KlineEntity } from '../entities/kline.entity';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { fmtTs, parseUTC } from './utils/backtest-ts.util';

export interface TradeOnBar {
  type: 'entry' | 'exit';
  symbol: string;
  price: number;
  shares: number;
  reason: string;
  pnl?: number;
  isHalf?: boolean;
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
  trades?: TradeOnBar[];
}

function toBar(e: KlineEntity): KlineChartBar {
  return {
    open_time: fmtTs(e.openTime),
    open: parseFloat(e.open),
    high: parseFloat(e.high),
    low: parseFloat(e.low),
    close: parseFloat(e.close),
    volume: parseFloat(e.volume),
    MA5: e.ma5 ?? null,
    MA30: e.ma30 ?? null,
    MA60: e.ma60 ?? null,
    MA120: e.ma120 ?? null,
    MA240: e.ma240 ?? null,
    'KDJ.K': e.kdjK ?? null,
    'KDJ.D': e.kdjD ?? null,
    'KDJ.J': e.kdjJ ?? null,
    DIF: e.dif ?? null,
    DEA: e.dea ?? null,
    MACD: e.macd ?? null,
    BBI: e.bbi ?? null,
  };
}

interface RawEntry {
  symbol: string;
  price: number;
  shares: number;
  reason: string;
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
    if (!run) throw new NotFoundException(`回测运行 ${runId} 不存在`);
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
        const logKey = fmtTs(log.ts);
        const trades: TradeOnBar[] = [];

        for (const e of log.entriesJson as RawEntry[]) {
          if (e.symbol === sym) {
            trades.push({ type: 'entry', symbol: e.symbol, price: e.price, shares: e.shares, reason: e.reason });
          }
        }
        for (const e of log.exitsJson as RawExit[]) {
          if (e.symbol === sym) {
            trades.push({ type: 'exit', symbol: e.symbol, price: e.price, shares: e.shares, reason: e.reason, pnl: e.pnl, isHalf: e.isHalf });
          }
        }

        if (trades.length) tradeMap.set(logKey, trades);
      }

      for (const bar of bars) {
        const trades = tradeMap.get(bar.open_time);
        if (trades) bar.trades = trades;
      }

      return bars;
    } catch (err) {
      const e = err as Error;
      this.logger.error(
        `kline-chart 查询失败 runId=${runId} symbol=${sym}: ${e.message}`,
        e.stack,
      );
      throw err;
    }
  }
}
