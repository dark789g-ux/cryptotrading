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

    // 并行加载所有 symbol，保持原输入顺序填入 Map
    const results = await Promise.all(
      symbols.map((symbol) => this.fetchSymbolKlines(symbol, interval, config)),
    );
    symbols.forEach((symbol, i) => {
      const r = results[i];
      if (!r) return;
      data.set(symbol, r.df);
      backtestStart.set(symbol, r.bstart);
    });

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
      // 纯日期（yyyy-MM-dd）扩展为当日结束；带时分秒则按原值处理
      if (/^\d{4}-\d{2}-\d{2}$/.test(config.dateEnd)) {
        end.setDate(end.getDate() + 1);
      }
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

/** 必须非空的预计算指标字段（缺失视为数据未正常入库） */
const REQUIRED_INDICATORS: Array<keyof KlineEntity> = [
  'kdjK', 'kdjD', 'kdjJ', 'ma5', 'ma30', 'ma60', 'ma120', 'ma240',
];

function entityToRow(e: KlineEntity): KlineBarRow {
  if (!e.openTime) {
    throw new Error(`${e.symbol} 存在 open_time 为空的 K 线，数据异常`);
  }
  for (const k of REQUIRED_INDICATORS) {
    if (e[k] == null) {
      throw new Error(
        `${e.symbol} @${e.openTime.toISOString()} 指标 ${String(k)} 缺失，请先完成指标预计算`,
      );
    }
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const d = e.openTime;
  const open_time = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

  return {
    open_time,
    open: Number(e.open),
    high: Number(e.high),
    low: Number(e.low),
    close: Number(e.close),
    volume: Number(e.volume),
    quote_volume: Number(e.quoteVolume) || 0,
    DIF: e.dif ?? 0,
    DEA: e.dea ?? 0,
    MACD: e.macd ?? 0,
    'KDJ.K': e.kdjK as number,
    'KDJ.D': e.kdjD as number,
    'KDJ.J': e.kdjJ as number,
    MA5: e.ma5 as number,
    MA30: e.ma30 as number,
    MA60: e.ma60 as number,
    MA120: e.ma120 as number,
    MA240: e.ma240 as number,
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
