// BaseDataSyncService —— NestJS 直调 Tushare，按依赖顺序串行同步三张 raw 基础表。
//
// ★双写说明：本服务与 Python `quant sync raw` CLI **双写** raw.trade_cal / raw.stk_limit /
//   raw.suspend_d。三表是 Tushare 原样透传（无复权、无衍生计算，schema 由共享实体钉死），
//   两入口走同一组列 + 同一 Tushare 源 + 幂等 upsert（last-writer-wins 于相同内容）→ 不会发散。
//   口径见 docs/superpowers/specs/2026-06-08-base-data-sync-frontend-design/。
//   不退役 Python 侧（其 orchestrator 把 trade_cal 作为 A 股备料第一步）。
//
// 串行 4 步（依赖顺序硬保证）：
//   Step1 trade_cal(exchange=SSE,[start,end]) → upsert 键(exchange, calDate)
//   Step2 查库取 [start,end] is_open=1 开市日列表（不再调 Tushare）
//   Step3 逐开市日 stk_limit(trade_date) → upsert 键(tsCode, tradeDate)
//   Step4 逐开市日 suspend_d(trade_date) → upsert 键(tsCode, tradeDate, suspendType) ★3 列

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Subject } from 'rxjs';
import { TradeCalEntity } from '../../entities/raw/trade-cal.entity';
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity';
import { StkLimitEntity } from '../../entities/raw/stk-limit.entity';
import { SuspendEntity } from '../../entities/raw/suspend.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { collectCompletenessErrors } from '../_shared/dataset-completeness';
import {
  asString,
  deduplicateBy,
  pctOf,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  truncate,
} from '../_shared/sync-helpers';
import type { ErrorItem, StoredRange, SyncDto, SyncEvent, SyncResult } from './base-data-sync.types';

// Tushare 出参字段（已落官方文档核实：trade_cal doc26 / stk_limit doc183 / suspend_d doc214）
const TRADE_CAL_FIELDS = 'exchange,cal_date,is_open,pretrade_date';
const STK_LIMIT_FIELDS = 'trade_date,ts_code,pre_close,up_limit,down_limit';
const SUSPEND_FIELDS = 'ts_code,trade_date,suspend_timing,suspend_type';

const UPSERT_CHUNK = 1000;

interface RawRow {
  [k: string]: unknown;
}

/**
 * numeric 列「原样字符串入库」：直接透传 Tushare 返回的字符串，仅 null/''→null。
 * 不经 Number() 往返（那会丢失 '10.00' 的尾零、并对超大值有精度风险）。
 * stk_limit 的 pre_close/up_limit/down_limit 实体 TS 类型即 string|null。
 */
function asRawNumericString(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

@Injectable()
export class BaseDataSyncService {
  private readonly logger = new Logger(BaseDataSyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(TradeCalEntity)
    private readonly tradeCalRepo: Repository<TradeCalEntity>,
    @InjectRepository(StkLimitEntity)
    private readonly stkLimitRepo: Repository<StkLimitEntity>,
    @InjectRepository(SuspendEntity)
    private readonly suspendRepo: Repository<SuspendEntity>,
    @InjectRepository(DailyQuoteEntity)
    private readonly dailyQuoteRepo: Repository<DailyQuoteEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 同步入口（不发 SSE，返回汇总结果）。串行 4 步，依赖顺序硬保证。
   */
  async sync(dto: SyncDto, onProgress?: (event: SyncEvent) => void): Promise<SyncResult> {
    const { signal } = dto;
    const errors: ErrorItem[] = [];
    // 预期正常的空日（仅 suspend_d 当日无停复牌）—— 与 errors 分桶，不计入"失败 N 项"。
    const warnings: ErrorItem[] = [];
    let success = 0;
    const rangeParams = { start_date: dto.start_date, end_date: dto.end_date };

    // ── Step1 trade_cal ────────────────────────────────────────────
    if (signal?.aborted) return { success, skipped: 0, errors, warnings };
    onProgress?.({
      type: 'progress',
      phase: 'trade_cal',
      current: 0,
      total: 4,
      percent: 0,
      message: '同步交易日历 trade_cal',
    });
    try {
      const calRows = (await runWithRetry(
        () =>
          this.tushareClient.query(
            'trade_cal',
            { exchange: 'SSE', start_date: dto.start_date, end_date: dto.end_date },
            TRADE_CAL_FIELDS,
          ),
        (attempt, err) =>
          onProgress?.({
            type: 'progress',
            phase: 'trade_cal',
            current: 0,
            total: 4,
            percent: 0,
            message: `trade_cal 重试中（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
          }),
      )) as RawRow[];

      if (calRows.length === 0) {
        this.logger.warn(`trade_cal 返回 0 行，params=${JSON.stringify(rangeParams)}`);
        errors.push({ apiName: 'trade_cal_empty', params: rangeParams });
      } else {
        const entities = calRows.map((row) =>
          this.tradeCalRepo.create({
            exchange: asString(row.exchange),
            calDate: asString(row.cal_date),
            isOpen: parseInt(asString(row.is_open), 10) || 0,
            pretradeDate: row.pretrade_date == null ? null : asString(row.pretrade_date),
            updatedAt: new Date(),
          }),
        );
        success += await this.upsertBatched(this.tradeCalRepo, entities, ['exchange', 'calDate'], 'trade_cal');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`trade_cal 调用失败 ${JSON.stringify(rangeParams)}: ${msg}`, e instanceof Error ? e.stack : undefined);
      errors.push({ apiName: 'trade_cal', params: rangeParams, message: msg });
    }

    // ── Step2 取开市日（查库，不再调 Tushare）──────────────────────
    const openRows = await this.tradeCalRepo.find({
      where: { exchange: 'SSE', isOpen: 1, calDate: Between(dto.start_date, dto.end_date) },
      select: ['calDate'],
    });
    const openDates = openRows.map((r) => r.calDate).sort();
    if (openDates.length === 0) {
      this.logger.warn(`范围内无开市日，params=${JSON.stringify(rangeParams)}`);
      errors.push({ apiName: 'no_open_trade_dates', params: rangeParams });
      return { success, skipped: 0, errors, warnings };
    }

    // ── Step3 stk_limit 并发逐开市日 ────────────────────────────────
    let stkCompleted = 0;
    const stkResults = await Promise.all(openDates.map(async (tradeDate) => {
      if (signal?.aborted) return null; // 对齐 a-shares:未入队提前 return
      const params = { trade_date: tradeDate };
      try {
        const rows = (await runWithRetry(
          () => this.tushareClient.query('stk_limit', params, STK_LIMIT_FIELDS),
          (attempt, err) =>
            onProgress?.({
              type: 'progress',
              phase: 'stk_limit',
              current: stkCompleted,
              total: openDates.length,
              percent: pctOf(stkCompleted, openDates.length),
              message: `stk_limit ${tradeDate} 重试中（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
            }),
        )) as RawRow[];
        stkCompleted++; // 单线程 JS 原子递增
        onProgress?.({
          type: 'progress',
          phase: 'stk_limit',
          current: stkCompleted,
          total: openDates.length,
          percent: pctOf(stkCompleted, openDates.length),
          message: `同步涨跌停 stk_limit ${tradeDate}`,
        });
        return { tradeDate, rows };
      } catch (e: unknown) {
        stkCompleted++;
        onProgress?.({
          type: 'progress',
          phase: 'stk_limit',
          current: stkCompleted,
          total: openDates.length,
          percent: pctOf(stkCompleted, openDates.length),
          message: `stk_limit ${tradeDate} 调用失败`,
        });
        return { tradeDate, error: e };
      }
    }));
    // 遍历结果处理：有 error → errors.push；0 行 → errors.push(stk_limit_empty)；非空 → create + upsertBatched
    for (const r of stkResults) {
      if (r == null) continue; // abort 未入队
      if ('error' in r) {
        const msg = r.error instanceof Error ? r.error.message : String(r.error);
        const params = { trade_date: r.tradeDate };
        this.logger.error(`stk_limit ${r.tradeDate} 调用失败：${msg}`, r.error instanceof Error ? r.error.stack : undefined);
        errors.push({ apiName: 'stk_limit', params, message: msg });
        continue;
      }
      const { tradeDate, rows } = r;
      // stk_limit 某开市日 0 行 = 可疑（每只票每开市日都该有涨跌停价）
      if (rows.length === 0) {
        const params = { trade_date: tradeDate };
        this.logger.warn(`stk_limit ${tradeDate} 返回 0 行（可疑），params=${JSON.stringify(params)}`);
        errors.push({ apiName: 'stk_limit_empty', params });
        continue;
      }
      const entities = rows.map((row) =>
        this.stkLimitRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          preClose: asRawNumericString(row.pre_close),
          upLimit: asRawNumericString(row.up_limit),
          downLimit: asRawNumericString(row.down_limit),
          updatedAt: new Date(),
        }),
      );
      success += await this.upsertBatched(this.stkLimitRepo, entities, ['tsCode', 'tradeDate'], `stk_limit ${tradeDate}`);
    }

    // POST-sync 对账：actual（stk_limit 当日入库行数）vs baseline（raw.daily_quote 当日行数）。
    // actual < baseline → push errors，避免部分缺失伪装成功（与 stk_limit_empty 互补：
    // stk_limit_empty 只盖 0 行；此处盖「非空却残缺」）。
    const stkLimitCompletenessErrors = await collectCompletenessErrors(
      this.dailyQuoteRepo,
      {
        tableName: 'raw.stk_limit',
        dateColumn: 'trade_date',
        baseline: { table: 'raw.daily_quote', dateColumn: 'trade_date' },
      },
      openDates,
      'stk_limit',
    );
    for (const message of stkLimitCompletenessErrors) {
      errors.push({ apiName: 'stk_limit_incomplete', params: {}, message });
    }

    // ── Step4 suspend_d 并发逐开市日 ────────────────────────────────
    let suspendCompleted = 0;
    const suspendResults = await Promise.all(openDates.map(async (tradeDate) => {
      if (signal?.aborted) return null; // 对齐 a-shares:未入队提前 return
      const params = { trade_date: tradeDate };
      try {
        // 不传 suspend_type → 返回当日 S+R 全部行
        const rows = (await runWithRetry(
          () => this.tushareClient.query('suspend_d', params, SUSPEND_FIELDS),
          (attempt, err) =>
            onProgress?.({
              type: 'progress',
              phase: 'suspend_d',
              current: suspendCompleted,
              total: openDates.length,
              percent: pctOf(suspendCompleted, openDates.length),
              message: `suspend_d ${tradeDate} 重试中（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
            }),
        )) as RawRow[];
        suspendCompleted++; // 单线程 JS 原子递增
        onProgress?.({
          type: 'progress',
          phase: 'suspend_d',
          current: suspendCompleted,
          total: openDates.length,
          percent: pctOf(suspendCompleted, openDates.length),
          message: `同步停复牌 suspend_d ${tradeDate}`,
        });
        return { tradeDate, rows };
      } catch (e: unknown) {
        suspendCompleted++;
        onProgress?.({
          type: 'progress',
          phase: 'suspend_d',
          current: suspendCompleted,
          total: openDates.length,
          percent: pctOf(suspendCompleted, openDates.length),
          message: `suspend_d ${tradeDate} 调用失败`,
        });
        return { tradeDate, error: e };
      }
    }));
    // 遍历结果处理：有 error → errors.push；0 行 → warnings.push(suspend_d_empty)；非空 → create + upsertBatched
    for (const r of suspendResults) {
      if (r == null) continue; // abort 未入队
      if ('error' in r) {
        const msg = r.error instanceof Error ? r.error.message : String(r.error);
        const params = { trade_date: r.tradeDate };
        this.logger.error(`suspend_d ${r.tradeDate} 调用失败：${msg}`, r.error instanceof Error ? r.error.stack : undefined);
        errors.push({ apiName: 'suspend_d', params, message: msg });
        continue;
      }
      const { tradeDate, rows } = r;
      // suspend_d 某日 0 行 = 正常（当日无停复牌事件）；归 warnings，不计入"失败 N 项"
      if (rows.length === 0) {
        const params = { trade_date: tradeDate };
        this.logger.warn(`suspend_d ${tradeDate} 返回 0 行（正常空日），params=${JSON.stringify(params)}`);
        warnings.push({ apiName: 'suspend_d_empty', params });
        continue;
      }
      const entities = rows.map((row) =>
        this.suspendRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          suspendType: asString(row.suspend_type),
          suspendTiming: row.suspend_timing == null ? null : asString(row.suspend_timing),
          updatedAt: new Date(),
        }),
      );
      success += await this.upsertBatched(
        this.suspendRepo,
        entities,
        ['tsCode', 'tradeDate', 'suspendType'],
        `suspend_d ${tradeDate}`,
      );
    }

    return { success, skipped: 0, errors, warnings };
  }

  /**
   * upsert 前按冲突键显式去重（避免 ON CONFLICT 同批重复键 500），分批 1000 行。
   * 返回去重后真实写入行数。
   */
  private async upsertBatched<T extends object>(
    repo: Repository<T>,
    entities: T[],
    conflictKeys: (keyof T)[],
    label: string,
  ): Promise<number> {
    const deduped = deduplicateBy(entities, conflictKeys);
    if (deduped.length < entities.length) {
      this.logger.warn(`${label} 返回重复键：原始 ${entities.length} 行 → 去重后 ${deduped.length} 行`);
    }
    for (let j = 0; j < deduped.length; j += UPSERT_CHUNK) {
      await repo.upsert(deduped.slice(j, j + UPSERT_CHUNK), conflictKeys as string[]);
    }
    return deduped.length;
  }

  /**
   * SSE 入口（异步 + 单飞锁）。
   */
  startSync(dto: SyncDto): Subject<SyncEvent> {
    const subject = new Subject<SyncEvent>();

    if (this.isSyncing) {
      setTimeout(() => {
        subject.next({ type: 'error', message: '基础数据同步任务已在运行中，请稍后再试' });
        subject.complete();
      }, 0);
      return subject;
    }
    this.isSyncing = true;

    setTimeout(async () => {
      try {
        const result = await this.sync(dto, (e) => subject.next(e));
        // 中断时：已拉数据不丢，走正常完成路径（push done 事件 + complete）
        const abortMsg = dto.signal?.aborted ? '（已取消）' : '';
        const failPart = result.errors.length ? `，${result.errors.length} 项失败` : '';
        const warnPart = result.warnings.length ? `，${result.warnings.length} 项空日警告` : '';
        subject.next({
          type: 'done',
          message: `同步完成${abortMsg}${failPart}${warnPart}`,
          result,
        });
        subject.complete();
      } catch (err) {
        this.logger.error(`startSync 失败: ${err instanceof Error ? err.stack : String(err)}`);
        subject.next({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        subject.complete();
      } finally {
        this.isSyncing = false;
      }
    }, 0);

    return subject;
  }

  /**
   * 三表库存日期范围（驱动前端增量默认 + 库存标签）。
   * trade_cal 日期列是 calDate，stk_limit / suspend_d 是 tradeDate。
   * ★增量水位前端应锚 stkLimit.max（稠密可靠）；trade_cal 含未来日历、suspend_d 稀疏。
   */
  async getStoredRange(): Promise<StoredRange> {
    const [stkLimit, suspend, tradeCal] = await Promise.all([
      this.minMax(this.stkLimitRepo, 'trade_date'),
      this.minMax(this.suspendRepo, 'trade_date'),
      this.minMax(this.tradeCalRepo, 'cal_date'),
    ]);
    return { stkLimit, suspend, tradeCal };
  }

  private async minMax<T extends object>(
    repo: Repository<T>,
    dateColumn: string,
  ): Promise<{ min: string | null; max: string | null }> {
    const row = await repo
      .createQueryBuilder('t')
      .select(`MIN(t.${dateColumn})`, 'min')
      .addSelect(`MAX(t.${dateColumn})`, 'max')
      .getRawOne<{ min: string | null; max: string | null }>();
    return { min: row?.min ?? null, max: row?.max ?? null };
  }
}
