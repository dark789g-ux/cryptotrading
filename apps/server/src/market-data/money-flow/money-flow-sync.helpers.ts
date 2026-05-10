import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { TushareClientService } from '../a-shares/services/tushare-client.service';
import type { MoneyFlowSyncEvent } from '@cryptotrading/shared-types';

export type SyncCtx = {
  phase: string;
  baseCurrent: number;
  total: number;
  grandTotal: number;
  emit: (e: MoneyFlowSyncEvent) => void;
};

export function pctOf(c: number, g: number): number {
  return Math.round((c / Math.max(g, 1)) * 100);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function asNullableNumeric(v: unknown, divisor?: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  if (divisor != null && divisor !== 0) return String(n / divisor);
  return String(n);
}

export function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * 按一组字段对实体数组去重，保留每组最后一条，防止 ON CONFLICT DO UPDATE 同批次重复键报错。
 */
export function deduplicateBy<T extends object>(entities: T[], keys: (keyof T)[]): T[] {
  const map = new Map<string, T>();
  for (const entity of entities) {
    const conflictKey = keys.map((k) => String(entity[k])).join('|');
    map.set(conflictKey, entity);
  }
  return Array.from(map.values());
}

const RETRY_BACKOFFS = [1000, 2000];

export async function runWithRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_BACKOFFS.length) {
        onRetry(attempt + 1, e);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFFS[attempt]));
      }
    }
  }
  throw lastErr;
}

export const RETRY_MAX_ATTEMPTS = RETRY_BACKOFFS.length;

export async function batchUpsert<T extends object>(
  repo: Repository<T>,
  entities: T[],
  conflictKeys: (keyof T)[],
): Promise<number> {
  const deduped = deduplicateBy(entities, conflictKeys);
  const chunkSize = 1000;
  for (let i = 0; i < deduped.length; i += chunkSize) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await repo.upsert(deduped.slice(i, i + chunkSize) as any, conflictKeys as string[]);
  }
  return deduped.length;
}

/** 增量模式：从交易日列表中过滤掉指定 repo 中已有数据的日期 */
export async function filterExistingDates<T extends { tradeDate: string }>(
  repo: Repository<T>,
  tradeDates: string[],
): Promise<{ dates: string[]; skipped: number }> {
  const existing = await repo
    .createQueryBuilder('e')
    .select('DISTINCT e.trade_date', 'tradeDate')
    .where('e.trade_date IN (:...dates)', { dates: tradeDates })
    .getRawMany<{ tradeDate: string }>();
  const existingSet = new Set(existing.map((r) => r.tradeDate));
  const dates = tradeDates.filter((d) => !existingSet.has(d));
  return { dates, skipped: tradeDates.length - dates.length };
}

export interface FetchByDatesOptions<TRow> {
  apiName: string;
  fields: string;
  dates: string[];
  ctx?: SyncCtx;
  logger: Logger;
  client: TushareClientService;
  /** 单日截断阈值告警（行数 ≥ 此值视为可能截断） */
  truncationThreshold?: number;
  /** 额外的请求参数构造器，默认 {start_date,end_date} = date */
  buildParams?: (date: string) => Record<string, string | number>;
}

export interface FetchByDatesResult<TRow> {
  rowsByDate: Array<{ date: string; rows: TRow[] }>;
  errors: string[];
}

/**
 * 按交易日列表逐日拉取 Tushare 数据，统一处理：
 *  - 重试 + 进度回调
 *  - API 调用失败时 logger.error + 收集到 errors（带 API 名 + 日期）
 *  - API 返回 0 条时 logger.warn（区分权限不足 / 真无数据）
 *  - 行数 ≥ truncationThreshold 时 logger.warn（可能截断）
 */
export async function fetchByDates<TRow>(
  opts: FetchByDatesOptions<TRow>,
): Promise<FetchByDatesResult<TRow>> {
  const { apiName, fields, dates, ctx, logger, client, buildParams } = opts;
  const truncationThreshold = opts.truncationThreshold ?? 6000;
  const errors: string[] = [];
  const rowsByDate: Array<{ date: string; rows: TRow[] }> = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const params = buildParams ? buildParams(date) : { start_date: date, end_date: date };
    let rows: TRow[] = [];
    try {
      rows = (await runWithRetry(
        () => client.query(apiName, params, fields),
        (attempt, err) => ctx?.emit({
          type: 'progress',
          phase: ctx.phase,
          current: ctx.baseCurrent + i,
          total: ctx.total,
          percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
          message: `重试中：${date}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
        }),
      )) as TRow[];
    } catch (e: unknown) {
      const msg = `${apiName} ${date} 调用失败: ${e instanceof Error ? e.message : String(e)}`;
      logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(`[${date}] ${msg}`);
    }

    if (rows.length === 0) {
      logger.warn(`${apiName} ${date} 返回空数据，参数=${JSON.stringify(params)}`);
    } else if (rows.length >= truncationThreshold) {
      logger.warn(`${apiName} ${date} 返回 ${rows.length} 条，可能截断（阈值 ${truncationThreshold}）`);
    }

    rowsByDate.push({ date, rows });

    ctx?.emit({
      type: 'progress',
      phase: ctx.phase,
      current: ctx.baseCurrent + i + 1,
      total: ctx.total,
      percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
      message: date,
    });
  }

  return { rowsByDate, errors };
}
