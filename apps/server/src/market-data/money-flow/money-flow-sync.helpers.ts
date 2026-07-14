import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { TushareClientService } from '../a-shares/services/tushare-client.service';
import {
  type SyncCtx,
  pctOf,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  truncate,
} from '../_shared/sync-helpers';

export type { SyncCtx } from '../_shared/sync-helpers';
export {
  pctOf,
  truncate,
  asNullableNumeric,
  asString,
  deduplicateBy,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
  batchUpsert,
} from '../_shared/sync-helpers';

/**
 * 增量模式：从交易日列表中过滤掉指定 repo 中已有数据的日期。
 *
 * `categoryScope`：当 repo 是多 category 混装表（如 index_daily_quotes 同表存
 * market/industry/concept/sw）时，必须传入本次同步自身的 category，否则会被
 * 同表其它 category 已写入的同一 trade_date 误判为「已同步」而整窗口跳过。
 * 不传 = 不按 category 收敛（单一用途表如资金流维持原状）。
 */
export async function filterExistingDates<T extends { tradeDate: string }>(
  repo: Repository<T>,
  tradeDates: string[],
  categoryScope?: string | string[],
): Promise<{ dates: string[]; skipped: number }> {
  const qb = repo
    .createQueryBuilder('e')
    .select('DISTINCT e.trade_date', 'tradeDate')
    .where('e.trade_date IN (:...dates)', { dates: tradeDates });
  if (categoryScope !== undefined) {
    const cats = Array.isArray(categoryScope) ? categoryScope : [categoryScope];
    qb.andWhere('e.category IN (:...cats)', { cats });
  }
  const existing = await qb.getRawMany<{ tradeDate: string }>();
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
 * 按交易日列表并发拉取 Tushare 数据，统一处理：
 *  - Promise.all 并发（全局 TushareClientService pLimit(5) 兜底限流）
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
  let completed = 0; // 原子计数器，替代循环索引 i

  const results = await Promise.all(
    dates.map(async (date) => {
      if (ctx?.signal?.aborted) return null;
      const params = buildParams ? buildParams(date) : { start_date: date, end_date: date };
      try {
        const rows = (await runWithRetry(
          () => client.query(apiName, params, fields),
          (attempt, err) => ctx?.emit({
            type: 'progress',
            phase: ctx.phase,
            current: ctx.baseCurrent + completed,
            total: ctx.total,
            percent: pctOf(ctx.baseCurrent + completed, ctx.grandTotal),
            message: `重试中：${date}（第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次） ${truncate(String(err), 60)}`,
          }),
        )) as TRow[];

        completed++;

        // 0 行 / 截断 warn
        if (rows.length === 0) {
          logger.warn(`${apiName} ${date} 返回空数据，参数=${JSON.stringify(params)}`);
        } else if (rows.length >= truncationThreshold) {
          logger.warn(`${apiName} ${date} 返回 ${rows.length} 条，可能截断（阈值 ${truncationThreshold}）`);
        }

        ctx?.emit({
          type: 'progress',
          phase: ctx.phase,
          current: ctx.baseCurrent + completed,
          total: ctx.total,
          percent: pctOf(ctx.baseCurrent + completed, ctx.grandTotal),
          message: date,
        });

        return { date, rows };
      } catch (e: unknown) {
        completed++;
        const msg = `${apiName} ${date} 调用失败: ${e instanceof Error ? e.message : String(e)}`;
        logger.error(msg, e instanceof Error ? e.stack : undefined);
        errors.push(`[${date}] ${msg}`);
        return { date, rows: [] as TRow[] };
      }
    }),
  );

  const rowsByDate = results.filter(
    (r): r is { date: string; rows: TRow[] } => r !== null,
  );
  return { rowsByDate, errors };
}
