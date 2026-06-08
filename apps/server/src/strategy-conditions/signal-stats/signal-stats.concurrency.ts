/**
 * signal-stats.concurrency.ts
 *
 * Bounded-concurrency map helper used by the signal-stats exit simulation
 * to fan out per-symbol DB queries with at most `limit` in-flight at once.
 *
 * No third-party dependencies — pure TypeScript worker-pool pattern.
 */

/**
 * Run `fn` for every item in `items` with at most `limit` concurrent calls,
 * returning results in the same order as the input.
 *
 * - result[i] always corresponds to items[i] regardless of completion order.
 * - At most Math.max(1, Math.floor(limit)) calls are in-flight simultaneously.
 * - Any rejection propagates immediately; errors are never swallowed.
 * - Empty `items` returns [] without calling `fn`.
 *
 * @param items  Input array (treated as readonly).
 * @param limit  Maximum concurrency. Clamped to Math.max(1, Math.floor(limit)).
 * @param fn     Async task. Receives (item, index).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];

  const concurrency = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(n);

  // Shared cursor: each worker atomically claims the next index.
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= n) return;
      // Let the rejection propagate up — no .catch() here.
      results[index] = await fn(items[index], index);
    }
  }

  // Start min(concurrency, n) workers and wait for all of them.
  const workerCount = Math.min(concurrency, n);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
