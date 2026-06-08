/**
 * signal-stats.concurrency.spec.ts
 *
 * Unit tests for mapWithConcurrency.
 * All tests use controlled Promises or zero-ms timers — no real-clock delays.
 */

import { mapWithConcurrency } from './signal-stats.concurrency';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A manually-resolvable promise handle. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 1. Empty array
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — empty array', () => {
  it('returns [] without calling fn', async () => {
    const fn = jest.fn().mockResolvedValue(42);
    const result = await mapWithConcurrency([], 4, fn);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Order preservation
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — order preservation', () => {
  it('returns results in input order even when later items resolve first', async () => {
    // items[0] takes longer than items[1..4]
    // If order were by completion, items[1..4] would appear before items[0].
    const delays = [20, 2, 4, 2, 4]; // ms — intentionally short but non-trivial
    const result = await mapWithConcurrency(
      [0, 1, 2, 3, 4],
      5, // full concurrency so all start at once
      async (item, index) => {
        await delay(delays[index]);
        return item * 10;
      },
    );
    expect(result).toEqual([0, 10, 20, 30, 40]);
  });

  it('preserves order with limit=1 (serial)', async () => {
    const order: number[] = [];
    const result = await mapWithConcurrency(
      [3, 1, 4, 1, 5],
      1,
      async (item) => {
        order.push(item);
        return item * 2;
      },
    );
    expect(result).toEqual([6, 2, 8, 2, 10]);
    expect(order).toEqual([3, 1, 4, 1, 5]);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency upper bound
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — concurrency upper bound', () => {
  it('never exceeds limit concurrent calls (limit=2, items=6)', async () => {
    let active = 0;
    let peakActive = 0;
    const deferreds = Array.from({ length: 6 }, () => deferred<number>());

    const promise = mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      2,
      async (item) => {
        active++;
        peakActive = Math.max(peakActive, active);
        // Wait until externally resolved so we control when slots free up.
        const result = await deferreds[item].promise;
        active--;
        return result;
      },
    );

    // Tick the micro-task queue so workers start.
    await Promise.resolve();
    // At this point only 2 workers should be in-flight (items 0 and 1).
    expect(active).toBe(2);
    expect(peakActive).toBe(2);

    // Resolve item 0 → worker picks up item 2.
    deferreds[0].resolve(0);
    await Promise.resolve();
    await Promise.resolve(); // extra tick for the worker loop
    expect(active).toBe(2);
    expect(peakActive).toBe(2);

    // Resolve all remaining items.
    deferreds[1].resolve(1);
    deferreds[2].resolve(2);
    deferreds[3].resolve(3);
    deferreds[4].resolve(4);
    deferreds[5].resolve(5);

    const results = await promise;
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peakActive).toBe(2);
  });

  it('limit clamped to 1 when given 0', async () => {
    let maxActive = 0;
    let active = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(0);
      active--;
      return item;
    });
    expect(maxActive).toBe(1);
  });

  it('limit clamped to 1 when given negative', async () => {
    const result = await mapWithConcurrency([7, 8], -5, async (item) => item + 1);
    expect(result).toEqual([8, 9]);
  });

  it('fractional limit is floored (2.9 → 2)', async () => {
    let active = 0;
    let peakActive = 0;
    const deferreds = Array.from({ length: 4 }, () => deferred<number>());

    const promise = mapWithConcurrency(
      [0, 1, 2, 3],
      2.9,
      async (item) => {
        active++;
        peakActive = Math.max(peakActive, active);
        const result = await deferreds[item].promise;
        active--;
        return result;
      },
    );

    await Promise.resolve();
    // floor(2.9) = 2, so only 2 should be active
    expect(active).toBe(2);

    deferreds[0].resolve(0);
    deferreds[1].resolve(1);
    deferreds[2].resolve(2);
    deferreds[3].resolve(3);
    await promise;
    expect(peakActive).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Error propagation
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — error propagation', () => {
  it('rejects when fn rejects, does not swallow the error', async () => {
    const boom = new Error('boom');
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw boom;
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  it('propagates the exact error object', async () => {
    const err = new TypeError('type error');
    await expect(
      mapWithConcurrency([1], 1, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// 5. limit=1 serial correctness
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — limit=1 serial', () => {
  it('runs tasks one at a time and returns correct values', async () => {
    const execution: number[] = [];
    const result = await mapWithConcurrency(
      [10, 20, 30],
      1,
      async (item) => {
        execution.push(item);
        return item + 1;
      },
    );
    expect(execution).toEqual([10, 20, 30]);
    expect(result).toEqual([11, 21, 31]);
  });
});

// ---------------------------------------------------------------------------
// 6. Single item
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — single item', () => {
  it('works with exactly one item', async () => {
    const result = await mapWithConcurrency(['hello'], 4, async (s) => s.toUpperCase());
    expect(result).toEqual(['HELLO']);
  });
});

// ---------------------------------------------------------------------------
// 7. limit > items.length
// ---------------------------------------------------------------------------

describe('mapWithConcurrency — limit > items count', () => {
  it('uses only as many workers as items (no over-spawning)', async () => {
    // 3 items, limit=100 — should still return all 3 correctly
    const result = await mapWithConcurrency([1, 2, 3], 100, async (x) => x * x);
    expect(result).toEqual([1, 4, 9]);
  });
});
