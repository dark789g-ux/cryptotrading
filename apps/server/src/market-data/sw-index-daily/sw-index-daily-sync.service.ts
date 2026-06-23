import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from 'rxjs';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
import {
  asNullableNumeric,
  asString,
  batchUpsert,
  deduplicateBy,
  pctOf,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  truncate,
} from '../_shared/sync-helpers';
import { filterExistingDates } from '../money-flow/money-flow-sync.helpers';
import { SwIndexDailySyncDto } from './dto/sync.dto';
import { ThsIndexDailyIndicatorService } from '../ths-index-daily/ths-index-daily-indicator.service';
import {
  buildSwCatalogEntities,
  INDEX_CLASSIFY_FIELDS,
  RawIndexClassifyRow,
} from './sw-index-catalog-builder';
import type {
  SwIndexDailySyncErrorItem,
  SwIndexDailySyncEvent,
  SwIndexDailySyncResult,
} from './sw-index-daily.types';

// Tushare sw_daily：https://tushare.pro/wctapi/documents/327.md
// 字段（文档冻结）：ts_code,trade_date,name,open,high,low,close,change,pct_change,
//                   vol(万股),amount(万元),pe,pb,float_mv(万元),total_mv(万元)
// 注意：无 pre_close；ts_code 后缀 .SI（非 .SW）；涨幅字段名 pct_change（非 pct_chg）
const SW_DAILY_FIELDS =
  'ts_code,trade_date,name,open,high,low,close,change,pct_change,vol,amount,pe,pb,float_mv,total_mv';

interface RawRow {
  [k: string]: unknown;
}

@Injectable()
export class SwIndexDailySyncService {
  private readonly logger = new Logger(SwIndexDailySyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(SwIndexCatalogEntity)
    private readonly catalogRepo: Repository<SwIndexCatalogEntity>,
    private readonly tushareClient: TushareClientService,
    private readonly indicatorService: ThsIndexDailyIndicatorService,
  ) {}

  /**
   * 同步入口：先灌 sw_index_catalog（index_classify 三级），再按 trade_date 循环 sw_daily。
   * 返回汇总结果（不发 SSE）。
   */
  async sync(
    dto: SwIndexDailySyncDto,
    onProgress?: (event: SwIndexDailySyncEvent) => void,
  ): Promise<SwIndexDailySyncResult> {
    const errors: SwIndexDailySyncErrorItem[] = [];

    // 0) 目录灌入（index_classify 三级，src=SW2021）
    const catalogParams = { src: 'SW2021' };
    try {
      await this.refreshCatalog(catalogParams, onProgress);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`index_classify 灌入失败：${msg}`, e instanceof Error ? e.stack : undefined);
      errors.push({ apiName: 'index_classify', params: catalogParams, message: msg });
      // 目录失败不阻断行情（行情按全量 ts_code 写，不依赖 catalog 过滤）
    }

    // 1) 取交易日列表
    let openDates: string[];
    try {
      openDates = await resolveOpenTradeDates(this.tushareClient, {
        startDate: dto.start_date,
        endDate: dto.end_date,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`trade_cal 调用失败 start=${dto.start_date} end=${dto.end_date}: ${msg}`);
      errors.push({
        apiName: 'trade_cal',
        params: { start_date: dto.start_date, end_date: dto.end_date },
        message: msg,
      });
      return { success: 0, skipped: 0, errors };
    }
    if (!openDates.length) {
      this.logger.warn(`trade_cal 返回 0 个交易日，参数 start=${dto.start_date} end=${dto.end_date}`);
      errors.push({
        apiName: 'no_open_trade_dates',
        params: { start_date: dto.start_date, end_date: dto.end_date },
      });
      return { success: 0, skipped: 0, errors };
    }

    // 2) 增量过滤
    let dates = openDates;
    let skipped = 0;
    if ((dto.syncMode ?? 'incremental') === 'incremental') {
      const filtered = await filterExistingDates(this.quotesRepo, openDates);
      dates = filtered.dates;
      skipped = filtered.skipped;
      if (skipped) {
        this.logger.log(`增量模式：跳过已同步交易日 ${skipped} 个，剩余 ${dates.length} 个`);
      }
    } else {
      this.logger.log(`overwrite 模式：全量重拉 ${openDates.length} 个交易日`);
    }
    if (!dates.length) {
      return { success: 0, skipped, errors };
    }

    // 3) 按 trade_date 循环 sw_daily
    const grandTotal = dates.length * 2; // quotes 拉取 + 指标计算
    let success = 0;
    const affectedTsCodes = new Set<string>();
    for (let i = 0; i < dates.length; i++) {
      const tradeDate = dates[i];
      const params: Record<string, string | number> = { trade_date: tradeDate };
      let rows: RawRow[] = [];
      try {
        rows = (await runWithRetry(
          () => this.tushareClient.query('sw_daily', params, SW_DAILY_FIELDS),
          (attempt, err) =>
            onProgress?.({
              type: 'progress',
              phase: '同步申万指数日线',
              current: i,
              total: dates.length,
              percent: pctOf(i, grandTotal),
              message: `重试中：${tradeDate}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
            }),
        )) as RawRow[];
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `sw_daily ${tradeDate} 调用失败：${msg}`,
          e instanceof Error ? e.stack : undefined,
        );
        errors.push({ apiName: 'sw_daily', params, message: msg });
        onProgress?.({
          type: 'progress',
          phase: '同步申万指数日线',
          current: i + 1,
          total: dates.length,
          percent: pctOf(i + 1, grandTotal),
          message: `${tradeDate} 调用失败`,
        });
        continue;
      }

      // 空数据：TushareClientService 已经按 data===null / items===[] 两条分支分别 warn 过
      // 这里只负责把"0 行"作为 failedItem 推出，区分"日期参数错误"与"当日数据未发布"
      if (rows.length === 0) {
        this.logger.warn(`sw_daily ${tradeDate} 返回 0 行，记 failedItem`);
        errors.push({ apiName: 'sw_daily_empty', params });
        onProgress?.({
          type: 'progress',
          phase: '同步申万指数日线',
          current: i + 1,
          total: dates.length,
          percent: pctOf(i + 1, grandTotal),
          message: `${tradeDate} 无数据`,
        });
        continue;
      }

      // 4) 字段映射 + 单位换算（map 内，落库前）
      //    sw_daily 单位（文档冻结）：vol=万股、amount=万元、total_mv/float_mv=万元
      //    库列：vol_hand=手(vol×100)、amount=千元(amount×10)、total_mv_wan/float_mv_wan=万元(一致)
      //    注意：sw_daily 无 pre_close；change 直填；涨幅字段 pct_change（非 pct_chg）
      const entitiesAll = rows.map((row) => {
        const vol = asNullableFloat(row.vol);
        const amount = asNullableFloat(row.amount);
        return this.quotesRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          open: asNullableFloat(row.open),
          high: asNullableFloat(row.high),
          low: asNullableFloat(row.low),
          close: asNullableFloat(row.close),
          preClose: null,
          change: asNullableFloat(row.change),
          pctChange: asNullableFloat(row.pct_change),
          volHand: vol != null ? vol * 100 : null,
          amount: amount != null ? amount * 10 : null,
          totalMvWan: asNullableNumeric(row.total_mv), // 万元一致，不换算
          floatMvWan: asNullableNumeric(row.float_mv), // 万元一致，不换算
          turnoverRate: null,
          pe: asNullableFloat(row.pe),
          pb: asNullableFloat(row.pb),
          category: 'sw',
        });
      });

      // 5) upsert 前显式去重（按 conflictKeys），warn 原始 / 去重条数
      const deduped = deduplicateBy(entitiesAll, ['tsCode', 'tradeDate']);
      if (deduped.length < entitiesAll.length) {
        this.logger.warn(
          `sw_daily ${tradeDate} 返回重复 (ts_code, trade_date)：原始 ${entitiesAll.length} 行 → 去重后 ${deduped.length} 行`,
        );
      }

      if (deduped.length) {
        await batchUpsert(this.quotesRepo, deduped, ['tsCode', 'tradeDate']);
        success += deduped.length;
        for (const e of deduped) affectedTsCodes.add(e.tsCode);
      }

      onProgress?.({
        type: 'progress',
        phase: '同步申万指数日线',
        current: i + 1,
        total: dates.length,
        percent: pctOf(i + 1, grandTotal),
        message: `${tradeDate} 落库 ${deduped.length}`,
      });
    }

    // 6) 指标计算（复用 ths indicator service，读全 category 不分类，申万 K 线自动有 MA/MACD/KDJ/BBI/BRICK）
    if (affectedTsCodes.size) {
      const tsCodes = [...affectedTsCodes];
      onProgress?.({
        type: 'progress',
        phase: '计算申万指数指标',
        current: 0,
        total: tsCodes.length,
        percent: pctOf(dates.length, grandTotal),
        message: `开始重算 ${tsCodes.length} 个申万指数的指标`,
      });
      for (let i = 0; i < tsCodes.length; i++) {
        const tsCode = tsCodes[i];
        try {
          await this.indicatorService.recalculateForSymbols([tsCode]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ apiName: 'sw_index_indicator', params: { ts_code: tsCode }, message: msg });
        }
        onProgress?.({
          type: 'progress',
          phase: '计算申万指数指标',
          current: i + 1,
          total: tsCodes.length,
          percent: pctOf(dates.length + Math.round((dates.length * (i + 1)) / tsCodes.length), grandTotal),
          message: `${tsCode}`,
        });
      }
    }

    return { success, skipped, errors };
  }

  /** SSE 入口。 */
  startSync(dto: SwIndexDailySyncDto): Subject<SwIndexDailySyncEvent> {
    const subject = new Subject<SwIndexDailySyncEvent>();

    if (this.isSyncing) {
      setTimeout(() => {
        subject.next({ type: 'error', message: '申万指数日线同步任务已在运行中，请稍后再试' });
        subject.complete();
      }, 0);
      return subject;
    }
    this.isSyncing = true;

    setTimeout(async () => {
      try {
        const result = await this.sync(dto, (e) => subject.next(e));
        subject.next({
          type: 'done',
          message: result.errors.length
            ? `同步完成，${result.errors.length} 项失败`
            : '同步完成',
          result,
        });
        subject.complete();
      } catch (err) {
        this.logger.error(
          `startSync 失败: ${err instanceof Error ? err.stack : String(err)}`,
        );
        subject.next({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        subject.complete();
      } finally {
        this.isSyncing = false;
      }
    }, 0);

    return subject;
  }

  /**
   * 拉 index_classify 三级（L1/L2/L3，src=SW2021）灌 sw_index_catalog。
   * 树结构（parent_code 指向父级 industry_code）→ 扁平冗余（l1/l2/l3 各自 code+name）。
   */
  private async refreshCatalog(
    params: { src: string },
    onProgress?: (event: SwIndexDailySyncEvent) => void,
  ): Promise<number> {
    const levels: Array<'L1' | 'L2' | 'L3'> = ['L1', 'L2', 'L3'];
    const rawByLevel = new Map<'L1' | 'L2' | 'L3', RawIndexClassifyRow[]>();
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const levelParams = { ...params, level };
      const rows = (await runWithRetry(
        () => this.tushareClient.query('index_classify', levelParams, INDEX_CLASSIFY_FIELDS),
        (attempt, err) =>
          onProgress?.({
            type: 'progress',
            phase: '灌入申万行业目录',
            current: i,
            total: levels.length,
            percent: pctOf(i, levels.length),
            message: `重试中：index_classify ${level}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
          }),
      )) as RawIndexClassifyRow[];
      if (rows.length === 0) {
        this.logger.warn(`index_classify ${level} 返回 0 行，参数=${JSON.stringify(levelParams)}`);
      }
      rawByLevel.set(level, rows);
      onProgress?.({
        type: 'progress',
        phase: '灌入申万行业目录',
        current: i + 1,
        total: levels.length,
        percent: pctOf(i + 1, levels.length),
        message: `${level} ${rows.length} 行`,
      });
    }

    const entities = buildSwCatalogEntities(
      rawByLevel.get('L1') ?? [],
      rawByLevel.get('L2') ?? [],
      rawByLevel.get('L3') ?? [],
    );
    const written = await batchUpsert(this.catalogRepo, entities, ['tsCode']);
    this.logger.log(`sw_index_catalog 灌入 ${written} 行（L1=${rawByLevel.get('L1')?.length ?? 0} / L2=${rawByLevel.get('L2')?.length ?? 0} / L3=${rawByLevel.get('L3')?.length ?? 0}）`);
    return written;
  }
}

/** 把 Tushare 数值字段转为 number | null（OHLC/change/pe/pb/vol/amount 走 double） */
function asNullableFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
