import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SymbolEntity } from '../entities/symbol.entity';
import { KlineEntity } from '../entities/kline.entity';
import { AppConfigEntity } from '../entities/app-config.entity';
import { SymbolsService } from '../symbols/symbols.service';
import { KlinesService } from '../klines/klines.service';
import { calcIndicators, KlineRow } from '../indicators/indicators';
import { Subject } from 'rxjs';

export interface SseEvent {
  type: 'start' | 'progress' | 'done' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

// 稳定币黑名单（与原 Python EXCLUDED_SYMBOLS 保持一致）
const EXCLUDED_SYMBOLS = new Set([
  'USDCUSDT', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'FRAX',
  'USDP', 'EURC', 'EURI', 'EURUSDT', 'FDUSDUSDT',
  'BFUSDUSDT', 'XUSDUSDT', 'USD1USDT',
]);

const VALID_INTERVALS = ['1h', '4h', '1d'];
const KLINE_LIMIT = 1000;
const DEFAULT_START_TIME = '2024-01-01 00:00:00';
const REQUEST_DELAY_MS = 60;
const UPDATE_LOOKBACK_DAYS = 30;

@Injectable()
export class SyncService {
  private isSyncing = false;
  private syncSubject: Subject<SseEvent> | null = null;

  constructor(
    @InjectRepository(SymbolEntity)
    private readonly symbolRepo: Repository<SymbolEntity>,
    @InjectRepository(KlineEntity)
    private readonly klineRepo: Repository<KlineEntity>,
    @InjectRepository(AppConfigEntity)
    private readonly configRepo: Repository<AppConfigEntity>,
    private readonly symbolsService: SymbolsService,
    private readonly klinesService: KlinesService,
    private readonly configService: ConfigService,
  ) {}

  get baseUrl(): string {
    return this.configService.get('BINANCE_BASE_URL', 'https://api.binance.com');
  }

  /** 获取同步偏好 */
  async getPreferences() {
    const intervalsCfg = await this.configRepo.findOne({ where: { key: 'sync_intervals' } });
    const intervals: string[] = intervalsCfg?.value ?? ['1h'];

    const symbols = await this.symbolRepo.find({ where: { syncEnabled: true } });
    return {
      intervals,
      symbols: symbols.map((s) => s.symbol),
    };
  }

  /** 保存同步偏好 */
  async savePreferences(prefs: { intervals: string[]; symbols: string[] }) {
    // 保存 intervals 到 app_config
    await this.configRepo.upsert(
      { key: 'sync_intervals', value: prefs.intervals },
      ['key'],
    );
    // 先清空所有 sync_enabled，再设置选中的
    await this.symbolRepo.update({}, { syncEnabled: false });
    if (prefs.symbols.length > 0) {
      for (const sym of prefs.symbols) {
        await this.symbolRepo.update({ symbol: sym }, { syncEnabled: true });
      }
    } else {
      // 空数组 = 全部同步
      await this.symbolRepo.update({}, { syncEnabled: true });
    }
    return { ok: true };
  }

  /** 启动同步，返回 Observable<SseEvent> */
  startSync(): Subject<SseEvent> {
    if (this.isSyncing) {
      const sub = new Subject<SseEvent>();
      sub.next({ type: 'error', message: '同步任务已在运行中，请稍后再试' });
      sub.complete();
      return sub;
    }
    this.syncSubject = new Subject<SseEvent>();
    this.isSyncing = true;
    this.runSync(this.syncSubject).finally(() => {
      this.isSyncing = false;
    });
    return this.syncSubject;
  }

  private emit(sub: Subject<SseEvent>, event: SseEvent) {
    sub.next(event);
  }

  private async runSync(sub: Subject<SseEvent>) {
    try {
      this.emit(sub, { type: 'start' });

      // 1. 获取交易对列表
      this.emit(sub, { type: 'progress', phase: '获取交易对列表', current: 0, total: 1, percent: 0 });
      const exchangeSymbols = await this.fetchExchangeInfo();
      await this.symbolsService.upsertSymbols(exchangeSymbols, EXCLUDED_SYMBOLS);
      this.emit(sub, { type: 'progress', phase: '获取交易对列表', current: 1, total: 1, percent: 2, message: `共 ${exchangeSymbols.length} 个交易对` });

      // 2. 获取需要同步的标的和周期
      const prefs = await this.getPreferences();
      const intervals = prefs.intervals.filter((i) => VALID_INTERVALS.includes(i));
      if (!intervals.length) {
        this.emit(sub, { type: 'done', message: '未配置同步周期' });
        sub.complete();
        return;
      }

      // 决定同步哪些 symbol
      let targetSymbols: string[];
      if (prefs.symbols.length > 0) {
        targetSymbols = prefs.symbols;
      } else {
        // 全部非排除标的
        const all = await this.symbolRepo.find({ where: { isActive: true, isExcluded: false } });
        targetSymbols = all.map((s) => s.symbol);
      }

      const totalTasks = targetSymbols.length * intervals.length;
      let done = 0;

      // 3. 逐标的逐周期同步
      for (const interval of intervals) {
        for (const symbol of targetSymbols) {
          try {
            await this.syncSymbolKlines(symbol, interval);
          } catch (e) {
            // 单个失败不中止全部
          }
          done++;
          const percent = 2 + (done / totalTasks) * 96;
          this.emit(sub, {
            type: 'progress',
            phase: `同步 ${interval} K 线`,
            current: done,
            total: totalTasks,
            percent: Math.round(percent * 10) / 10,
            message: symbol,
          });
          await this.sleep(REQUEST_DELAY_MS);
        }
      }

      this.emit(sub, { type: 'done', message: '数据同步完成' });
      sub.complete();
    } catch (err) {
      this.emit(sub, { type: 'error', message: String(err?.message || err) });
      sub.complete();
    }
  }

  /** 同步单个 symbol 的单个 interval K 线 */
  private async syncSymbolKlines(symbol: string, interval: string) {
    // 找最新一根 K 线时间，决定从哪里开始拉
    const latest = await this.klineRepo.findOne({
      where: { symbol, interval },
      order: { openTime: 'DESC' },
    });

    let startMs: number;
    if (latest) {
      // 回溯 UPDATE_LOOKBACK_DAYS 天
      const lookbackMs = UPDATE_LOOKBACK_DAYS * 24 * 3600 * 1000;
      startMs = latest.openTime.getTime() - lookbackMs;
    } else {
      startMs = new Date(DEFAULT_START_TIME).getTime();
    }

    const klineRows: KlineRow[] = [];

    while (true) {
      const url = `${this.baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&limit=${KLINE_LIMIT}`;
      const resp = await axios.get(url, { timeout: 15000 });
      const data: any[][] = resp.data;
      if (!data || !data.length) break;

      for (const r of data) {
        klineRows.push({
          open_time: new Date(r[0]),
          open: r[1],
          high: r[2],
          low: r[3],
          close: r[4],
          volume: r[5],
          close_time: new Date(r[6]),
          quote_volume: r[7],
          trades: r[8],
          taker_buy_base_vol: r[9],
          taker_buy_quote_vol: r[10],
        });
      }

      if (data.length < KLINE_LIMIT) break;
      startMs = data[data.length - 1][0] + 1;
      await this.sleep(REQUEST_DELAY_MS);
    }

    if (!klineRows.length) return;

    // 计算指标
    const withIndicators = calcIndicators(klineRows);

    // 转换为实体
    const entities: Partial<KlineEntity>[] = withIndicators.map((r) => ({
      symbol,
      interval,
      openTime: new Date(r.open_time as string),
      open: String(r.open),
      high: String(r.high),
      low: String(r.low),
      close: String(r.close),
      volume: String(r.volume),
      closeTime: r.close_time ? new Date(r.close_time as string) : null,
      quoteVolume: String(r.quote_volume || 0),
      trades: String(r.trades || 0),
      takerBuyBaseVol: String(r.taker_buy_base_vol || 0),
      takerBuyQuoteVol: String(r.taker_buy_quote_vol || 0),
      dif: r.DIF,
      dea: r.DEA,
      macd: r.MACD,
      kdjK: r['KDJ.K'],
      kdjD: r['KDJ.D'],
      kdjJ: r['KDJ.J'],
      bbi: r.BBI,
      ma5: r.MA5,
      ma30: r.MA30,
      ma60: r.MA60,
      ma120: r.MA120,
      ma240: r.MA240,
      quoteVolume10: r['10_quote_volume'],
      atr14: r.atr_14,
      lossAtr14: r.loss_atr_14,
      low9: r.low_9,
      high9: r.high_9,
      stopLossPct: r.stop_loss_pct,
      riskRewardRatio: r.risk_reward_ratio,
    }));

    await this.klinesService.upsertKlines(entities);
  }

  /** 获取币安 exchangeInfo 并返回 USDT 交易对列表 */
  private async fetchExchangeInfo(): Promise<{ symbol: string; baseAsset: string; quoteAsset: string }[]> {
    const url = `${this.baseUrl}/api/v3/exchangeInfo`;
    const resp = await axios.get(url, { timeout: 15000 });
    const symbols = resp.data?.symbols ?? [];
    return symbols
      .filter((s: any) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s: any) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
      }));
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
