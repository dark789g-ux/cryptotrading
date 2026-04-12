/**
 * 回测数据加载服务 — 翻译自 backtest/data.py，数据源改为 PostgreSQL
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KlineEntity } from '../../entities/kline.entity';
import { KlineBarRow, BacktestConfig } from './models';

@Injectable()
export class BacktestDataService {
  constructor(
    @InjectRepository(KlineEntity)
    private readonly klineRepo: Repository<KlineEntity>,
  ) {}

  /**
   * 从 DB 加载指定 symbols+interval 的 K 线，返回回测引擎使用的数据结构。
   *
   * 等价于 Python load_all_klines()，但数据来自 PostgreSQL。
   */
  async loadKlines(
    symbols: string[],
    interval: string,
    config: BacktestConfig,
  ): Promise<{ data: Map<string, KlineBarRow[]>; backtestStart: Map<string, number> }> {
    const data = new Map<string, KlineBarRow[]>();
    const backtestStart = new Map<string, number>();

    for (const symbol of symbols) {
      const rows = await this.fetchSymbolKlines(symbol, interval, config);
      if (!rows) continue;
      data.set(symbol, rows.df);
      backtestStart.set(symbol, rows.bstart);
    }

    return { data, backtestStart };
  }

  private async fetchSymbolKlines(
    symbol: string,
    interval: string,
    config: BacktestConfig,
  ): Promise<{ df: KlineBarRow[]; bstart: number } | null> {
    const qb = this.klineRepo
      .createQueryBuilder('k')
      .where('k.symbol = :symbol', { symbol })
      .andWhere('k.interval = :interval', { interval })
      .orderBy('k.open_time', 'ASC');

    if (config.dateStart) {
      qb.andWhere('k.open_time >= :dateStart', { dateStart: new Date(config.dateStart) });
    }
    if (config.dateEnd) {
      const end = new Date(config.dateEnd);
      end.setDate(end.getDate() + 1);
      qb.andWhere('k.open_time <= :dateEnd', { dateEnd: end });
    }

    const entities = await qb.getMany();
    if (!entities.length) return null;

    // 丢弃前 warmupBars 行（指标预热期）
    const afterWarmup = entities.slice(config.warmupBars);
    if (!afterWarmup.length) return null;

    // 截取最新的 maxBacktestBars + lookbackBuffer 根
    let df: KlineBarRow[];
    let bstart: number;

    if (config.maxBacktestBars > 0) {
      const keep = config.maxBacktestBars + config.lookbackBuffer;
      const sliced = afterWarmup.length > keep ? afterWarmup.slice(-keep) : afterWarmup;
      df = sliced.map(entityToRow);
      bstart = Math.max(0, df.length - config.maxBacktestBars);
    } else {
      df = afterWarmup.map(entityToRow);
      bstart = 0;
    }

    if (df.length < 10) return null;
    return { df, bstart };
  }
}

function entityToRow(e: KlineEntity): KlineBarRow {
  const fmt = (d: Date | null) => {
    if (!d) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };

  return {
    open_time: fmt(e.openTime),
    open: Number(e.open),
    high: Number(e.high),
    low: Number(e.low),
    close: Number(e.close),
    volume: Number(e.volume),
    DIF: e.dif ?? 0,
    DEA: e.dea ?? 0,
    MACD: e.macd ?? 0,
    'KDJ.K': e.kdjK ?? 50,
    'KDJ.D': e.kdjD ?? 50,
    'KDJ.J': e.kdjJ ?? 50,
    MA5: e.ma5 ?? 0,
    MA30: e.ma30 ?? 0,
    MA60: e.ma60 ?? 0,
    MA120: e.ma120 ?? 0,
    MA240: e.ma240 ?? 0,
    BBI: e.bbi ?? 0,
    '10_quote_volume': e.quoteVolume10 ?? 0,
    atr_14: e.atr14 ?? 0,
    loss_atr_14: e.lossAtr14 ?? 0,
    low_9: e.low9 ?? 0,
    high_9: e.high9 ?? 0,
    stop_loss_pct: e.stopLossPct ?? 0,
    risk_reward_ratio: e.riskRewardRatio ?? 0,
  };
}
