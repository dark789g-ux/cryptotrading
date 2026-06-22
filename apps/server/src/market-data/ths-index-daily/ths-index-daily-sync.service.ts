import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from 'rxjs';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
import {
  asNullableNumeric,
  asString,
  deduplicateBy,
  pctOf,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  truncate,
} from '../_shared/sync-helpers';
import { filterExistingDates } from '../money-flow/money-flow-sync.helpers';
import { ThsIndexDailySyncDto } from './dto/sync.dto';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';
import type {
  ThsIndexDailySyncErrorItem,
  ThsIndexDailySyncEvent,
  ThsIndexDailySyncResult,
} from './ths-index-daily.types';

// Tushare ths_daily：https://tushare.pro/wctapi/documents/260.md
const THS_DAILY_FIELDS =
  'ts_code,trade_date,open,high,low,close,pre_close,change,pct_change,vol,turnover_rate,total_mv,float_mv';

interface RawRow {
  [k: string]: unknown;
}

@Injectable()
export class ThsIndexDailySyncService {
  private readonly logger = new Logger(ThsIndexDailySyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    private readonly tushareClient: TushareClientService,
    private readonly indicatorService: ThsIndexDailyIndicatorService,
  ) {}

  /**
   * 同步入口：按 trade_date 循环调用 ths_daily（单日全市场返回，I+N 合计 ~700 行）。
   * 返回汇总结果（不发 SSE）。
   */
  async sync(
    dto: ThsIndexDailySyncDto,
    onProgress?: (event: ThsIndexDailySyncEvent) => void,
  ): Promise<ThsIndexDailySyncResult> {
    const errors: ThsIndexDailySyncErrorItem[] = [];

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

    // 3) 加载 ths_index_catalog（仅 I + N），用于过滤 ts_code
    const catalogRows = await this.catalogRepo
      .createQueryBuilder('c')
      .select(['c.tsCode', 'c.type'])
      .where('c.type IN (:...types)', { types: ['I', 'N'] })
      .getMany();
    const allowedTsCodes = new Set(catalogRows.map((r) => r.tsCode));
    // category 映射：catalog.type I→industry / N→concept（同步只处理行业/概念，大盘由专门入口）
    const categoryMap = new Map<string, 'industry' | 'concept'>(
      catalogRows.map((r) => [r.tsCode, r.type === 'I' ? 'industry' : 'concept'] as const),
    );
    if (!allowedTsCodes.size) {
      this.logger.warn('ths_index_catalog 为空（仅 I+N），无法过滤；请先同步行业/概念目录');
    }

    // 4) 按 trade_date 循环
    const grandTotal = dates.length * 2; // quotes 拉取 + 指标计算 两个阶段
    let success = 0;
    const affectedTsCodes = new Set<string>();
    for (let i = 0; i < dates.length; i++) {
      const tradeDate = dates[i];
      const params: Record<string, string | number> = { trade_date: tradeDate };
      let rows: RawRow[] = [];
      try {
        rows = (await runWithRetry(
          () => this.tushareClient.query('ths_daily', params, THS_DAILY_FIELDS),
          (attempt, err) =>
            onProgress?.({
              type: 'progress',
              phase: '同步指数日线',
              current: i,
              total: dates.length,
              percent: pctOf(i, grandTotal),
              message: `重试中：${tradeDate}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
            }),
        )) as RawRow[];
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `ths_daily ${tradeDate} 调用失败：${msg}`,
          e instanceof Error ? e.stack : undefined,
        );
        errors.push({ apiName: 'ths_daily', params, message: msg });
        onProgress?.({
          type: 'progress',
          phase: '同步指数日线',
          current: i + 1,
          total: dates.length,
          percent: pctOf(i + 1, grandTotal),
          message: `${tradeDate} 调用失败`,
        });
        continue;
      }

      // 空数据：TushareClientService 已经按 data===null / items===[] 两条分支分别 warn 过
      // 这里只负责把"0 行"作为 failedItem 推出，让 UI 上立即可见——区分"日期参数错误"与"当日数据未发布"
      if (rows.length === 0) {
        this.logger.warn(`ths_daily ${tradeDate} 返回 0 行，记 failedItem`);
        errors.push({ apiName: 'ths_daily_empty', params });
        onProgress?.({
          type: 'progress',
          phase: '同步指数日线',
          current: i + 1,
          total: dates.length,
          percent: pctOf(i + 1, grandTotal),
          message: `${tradeDate} 无数据`,
        });
        continue;
      }

      // 5) 字段映射 + 单位换算（total_mv / float_mv 元 → 万元；vol 保留「手」）
      const entitiesAll = rows.map((row) =>
        this.quotesRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          open: asNullableFloat(row.open),
          high: asNullableFloat(row.high),
          low: asNullableFloat(row.low),
          close: asNullableFloat(row.close),
          preClose: asNullableFloat(row.pre_close),
          change: asNullableFloat(row.change),
          pctChange: asNullableFloat(row.pct_change),
          volHand: asNullableFloat(row.vol),
          totalMvWan: asNullableNumeric(row.total_mv, 10000),
          floatMvWan: asNullableNumeric(row.float_mv, 10000),
          turnoverRate: asNullableFloat(row.turnover_rate),
          category: categoryMap.get(asString(row.ts_code)) ?? 'industry',
        }),
      );

      // 6) 用 ths_index_catalog 过滤（只保留 I + N，其它 type 静默丢弃）
      const filteredEntities = allowedTsCodes.size
        ? entitiesAll.filter((e) => allowedTsCodes.has(e.tsCode))
        : entitiesAll;
      const droppedByCatalog = entitiesAll.length - filteredEntities.length;
      if (droppedByCatalog > 0) {
        this.logger.log(
          `ths_daily ${tradeDate} 丢弃非 I/N type ${droppedByCatalog} 行（原始 ${entitiesAll.length}, 保留 ${filteredEntities.length}）`,
        );
      }

      // 7) upsert 前显式去重（按 conflictKeys），并 warn 原始 / 去重条数
      const deduped = deduplicateBy(filteredEntities, ['tsCode', 'tradeDate']);
      if (deduped.length < filteredEntities.length) {
        this.logger.warn(
          `ths_daily ${tradeDate} 返回重复 (ts_code, trade_date)：原始 ${filteredEntities.length} 行 → 去重后 ${deduped.length} 行`,
        );
      }

      if (deduped.length) {
        const chunkSize = 1000;
        for (let j = 0; j < deduped.length; j += chunkSize) {
          await this.quotesRepo.upsert(deduped.slice(j, j + chunkSize), ['tsCode', 'tradeDate']);
        }
        success += deduped.length;
        for (const e of deduped) affectedTsCodes.add(e.tsCode);
      }

      onProgress?.({
        type: 'progress',
        phase: '同步指数日线',
        current: i + 1,
        total: dates.length,
        percent: pctOf(i + 1, grandTotal),
        message: `${tradeDate} 落库 ${deduped.length}`,
      });
    }

    // 8) 指标计算（按受影响 ts_code 全量重算；MA240 等需 240 天窗口由 calcStrictSma 自身处理）
    if (affectedTsCodes.size) {
      const tsCodes = [...affectedTsCodes];
      onProgress?.({
        type: 'progress',
        phase: '计算指数指标',
        current: 0,
        total: tsCodes.length,
        percent: pctOf(dates.length, grandTotal),
        message: `开始重算 ${tsCodes.length} 个指数的指标`,
      });
      for (let i = 0; i < tsCodes.length; i++) {
        const tsCode = tsCodes[i];
        try {
          await this.indicatorService.recalculateForSymbols([tsCode]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ apiName: 'ths_index_indicator', params: { ts_code: tsCode }, message: msg });
        }
        onProgress?.({
          type: 'progress',
          phase: '计算指数指标',
          current: i + 1,
          total: tsCodes.length,
          percent: pctOf(dates.length + Math.round((dates.length * (i + 1)) / tsCodes.length), grandTotal),
          message: `${tsCode}`,
        });
      }
    }

    return { success, skipped, errors };
  }

  /**
   * SSE 入口。
   */
  startSync(dto: ThsIndexDailySyncDto): Subject<ThsIndexDailySyncEvent> {
    const subject = new Subject<ThsIndexDailySyncEvent>();

    if (this.isSyncing) {
      setTimeout(() => {
        subject.next({ type: 'error', message: '指数日线同步任务已在运行中，请稍后再试' });
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
}

/** 把 Tushare 数值字段转为 number | null（与 totalMv/floatMv 的 numeric 走 asNullableNumeric 不同，OHLC 走 double） */
function asNullableFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
