import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KlineEntity } from '../../entities/symbol/kline.entity';
import { calcBrickChartPoints } from '../../indicators/brick-chart';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
import { KdjParamsDto } from './dto/kdj-params.dto';

@Injectable()
export class KlinesService {
  constructor(
    @InjectRepository(KlineEntity)
    private readonly klineRepo: Repository<KlineEntity>,
  ) {}

  /** 返回指定 symbol+interval 的全量 K 线（含指标），按时间升序 */
  async getKlines(symbol: string, interval: string): Promise<object[]> {
    const rows = await this.klineRepo.find({
      where: { symbol, interval },
      order: { openTime: 'ASC' },
    });

    return this.mapRowsToBars(rows);
  }

  /**
   * 按自定义 KDJ 参数重新计算 K 线指标。
   *
   * - 复用 KlineEntity 全量 OHLC 查询，按 openTime ASC；
   * - 若传入 kdjParams，用 calcKdjSeries 重算整条 KDJ；
   * - 其它指标字段保持原值；
   * - 返回字段形状与 getKlines() 完全一致。
   */
  async recalcKlines(
    symbol: string,
    interval: string,
    kdjParams?: KdjParamsDto,
  ): Promise<object[]> {
    const rows = await this.klineRepo.find({
      where: { symbol, interval },
      order: { openTime: 'ASC' },
    });

    let kdjSeries: ReturnType<typeof calcKdjSeries> | undefined;
    if (kdjParams) {
      kdjSeries = calcKdjSeries(
        rows.map((row) => ({
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
        })),
        kdjParams.n,
        kdjParams.m1,
        kdjParams.m2,
      );
    }

    return this.mapRowsToBars(rows, kdjSeries);
  }

  private mapRowsToBars(
    rows: KlineEntity[],
    kdjSeries?: ReturnType<typeof calcKdjSeries>,
  ): object[] {
    const brickChart = calcBrickChartPoints(
      rows.map((row) => ({
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
      })),
    );

    return rows.map((r, index) => {
      const kdj = kdjSeries?.[index] ? roundKdjPoint(kdjSeries[index]) : undefined;
      return {
        open_time: r.openTime,
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: parseFloat(r.volume),
        close_time: r.closeTime,
        quote_volume: parseFloat(r.quoteVolume),
        trades: r.trades,
        DIF: r.dif,
        DEA: r.dea,
        MACD: r.macd,
        'KDJ.K': kdj ? kdj.k : r.kdjK,
        'KDJ.D': kdj ? kdj.d : r.kdjD,
        'KDJ.J': kdj ? kdj.j : r.kdjJ,
        BBI: r.bbi,
        MA5: r.ma5,
        MA30: r.ma30,
        MA60: r.ma60,
        MA120: r.ma120,
        MA240: r.ma240,
        '10_quote_volume': r.quoteVolume10,
        atr_14: r.atr14,
        loss_atr_14: r.lossAtr14,
        low_9: r.low9,
        high_9: r.high9,
        stop_loss_pct: r.stopLossPct,
        risk_reward_ratio: r.riskRewardRatio,
        brickChart: brickChart[index],
      };
    });
  }

  /** 批量 upsert K 线（同步时使用） */
  async upsertKlines(klines: Partial<KlineEntity>[]) {
    if (!klines.length) return;
    await this.klineRepo
      .createQueryBuilder()
      .insert()
      .into(KlineEntity)
      .values(klines)
      .orUpdate(
        [
          'open', 'high', 'low', 'close', 'volume',
          'close_time', 'quote_volume', 'trades',
          'taker_buy_base_vol', 'taker_buy_quote_vol',
          'dif', 'dea', 'macd', 'kdj_k', 'kdj_d', 'kdj_j',
          'bbi', 'ma5', 'ma30', 'ma60', 'ma120', 'ma240',
          'quote_volume_10', 'atr_14', 'loss_atr_14',
          'low_9', 'high_9', 'stop_loss_pct', 'risk_reward_ratio',
        ],
        ['symbol', 'interval', 'open_time'],
      )
      .execute();
  }
}
