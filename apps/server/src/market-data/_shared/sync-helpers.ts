import { Repository } from 'typeorm';
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
