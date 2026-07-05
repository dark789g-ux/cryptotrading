/**
 * ETF K 线技术指标 service：复用 indicators/indicators.ts 的 calcIndicators 全套。
 *
 * 落 raw.fund_daily_indicator，同构 raw.daily_indicator。
 * 采用全量重算（ETF 无 a_share_sync_states dirty 标记表）：
 * 按 ts_code 加载 fund_daily 全量行 → calcIndicators → upsert。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FundDailyEntity } from '../../entities/raw/fund-daily.entity';
import { FundDailyIndicatorEntity } from '../../entities/raw/fund-daily-indicator.entity';
import { calcBrickChartPoints } from '../../indicators/brick-chart';
import {
  calcIndicators,
  type KlineRow,
  type KlineRowWithIndicators,
} from '../../indicators/indicators';
import type { EtfSyncErrorItem, EtfSyncResult } from './etf.types';

const UPSERT_CHUNK = 1000;

@Injectable()
export class EtfIndicatorService {
  private readonly logger = new Logger(EtfIndicatorService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 重算指定 ETF 列表的技术指标。
   * 全量重算每个 ts_code 的所有已有日线对应的指标。
   */
  async recalculateIndicators(etfCodes: string[]): Promise<EtfSyncResult> {
    const indicatorRepo = this.dataSource.getRepository(FundDailyIndicatorEntity);
    const errors: EtfSyncErrorItem[] = [];
    let totalWritten = 0;

    for (let i = 0; i < etfCodes.length; i++) {
      const tsCode = etfCodes[i];
      try {
        const count = await this.recalculateForSymbol(tsCode, indicatorRepo);
        totalWritten += count;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[etf-indicator] ${tsCode} 异常: ${msg}`);
        errors.push({ apiName: 'etf_indicator', message: `${tsCode}: ${msg}` });
      }
    }

    this.logger.log(`[etf-indicator] 完成：${etfCodes.length} 只 ETF，落库 ${totalWritten} 行`);
    return { success: totalWritten, errors };
  }

  private async recalculateForSymbol(
    tsCode: string,
    repo: Repository<FundDailyIndicatorEntity>,
  ): Promise<number> {
    // 加载该 ETF 的全量日线
    const dailyRepo = this.dataSource.getRepository(FundDailyEntity);
    const rows = await dailyRepo.find({
      where: { tsCode } as never,
      order: { tradeDate: 'ASC' },
    });

    if (rows.length === 0) return 0;

    // 映射为 KlineRow
    const klines: KlineRow[] = rows.map((r) => ({
      open_time: r.tradeDate,
      open: Number(r.open) || 0,
      high: Number(r.high) || 0,
      low: Number(r.low) || 0,
      close: Number(r.close) || 0,
      volume: Number(r.vol) || 0,
      quote_volume: Number(r.amount) || 0,
      taker_buy_base_vol: 0,
      taker_buy_quote_vol: 0,
    }));

    // 计算指标
    const indicators = calcIndicators(klines);

    // 计算砖图（独立于 calcIndicators）
    const brickCharts = calcBrickChartPoints(klines.map((k) => ({
      open_time: k.open_time,
      open: Number(k.open) || 0,
      high: Number(k.high) || 0,
      low: Number(k.low) || 0,
      close: Number(k.close) || 0,
      volume: Number(k.volume) || 0,
    })));

    // 构建 entity 并 upsert
    const entities: Partial<FundDailyIndicatorEntity>[] = indicators.map((ind, idx) => ({
      tsCode,
      tradeDate: rows[idx].tradeDate,
      dif: ind.DIF,
      dea: ind.DEA,
      macd: ind.MACD,
      kdjK: ind['KDJ.K'],
      kdjD: ind['KDJ.D'],
      kdjJ: ind['KDJ.J'],
      bbi: ind.BBI,
      ma5: ind.MA5,
      ma30: ind.MA30,
      ma60: ind.MA60,
      ma120: ind.MA120,
      ma240: ind.MA240,
      quoteVolume10: ind['10_quote_volume'],
      atr14: ind.atr_14,
      lossAtr14: ind.loss_atr_14,
      low9: ind.low_9,
      high9: ind.high_9,
      stopLossPct: ind.stop_loss_pct,
      riskRewardRatio: ind.risk_reward_ratio,
      brick: brickCharts[idx]?.brick ?? null,
      brickDelta: brickCharts[idx]?.delta ?? null,
      brickXg: brickCharts[idx]?.xg ?? null,
      roc10: ind.roc10,
      roc20: ind.roc20,
      roc60: ind.roc60,
      obv5d: ind.obv5d,
      obv10d: ind.obv10d,
      obv20d: ind.obv20d,
    }));

    // 去重
    const deduped = this.dedup(entities, ['tsCode', 'tradeDate']);

    // 分块 upsert
    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK);
      await repo
        .createQueryBuilder()
        .insert()
        .into(FundDailyIndicatorEntity)
        .values(chunk)
        .orUpdate(
          ['dif', 'dea', 'macd', 'kdj_k', 'kdj_d', 'kdj_j', 'bbi',
           'ma5', 'ma30', 'ma60', 'ma120', 'ma240', 'quote_volume_10',
           'atr_14', 'loss_atr_14', 'low_9', 'high_9', 'stop_loss_pct',
           'risk_reward_ratio', 'brick', 'brick_delta', 'brick_xg',
           'roc10', 'roc20', 'roc60', 'obv5d', 'obv10d', 'obv20d'],
          ['ts_code', 'trade_date'],
        )
        .execute();
    }

    return deduped.length;
  }

  private dedup<T extends object>(entities: T[], keys: (keyof T)[]): T[] {
    const map = new Map<string, T>();
    for (const e of entities) {
      const k = keys.map((key) => String(e[key])).join('|');
      map.set(k, e);
    }
    return [...map.values()];
  }
}
