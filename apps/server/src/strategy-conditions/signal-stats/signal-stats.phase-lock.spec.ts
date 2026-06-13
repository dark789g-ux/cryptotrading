/**
 * signal-stats.phase-lock.spec.ts
 *
 * 阶段锁定 phase_lock 出场规则纯函数单测 —— 与 Python 共享核 phase_lock_exit.py
 * **跨语言对拍**的 TS 侧期望表，逐条对 apps/quant-pipeline/tests/unit/test_phase_lock_exit.py
 * 的 S1~S15（+ 补充用例）做精确数值断言（kind / reason / exitIndex / exitPrice / holdDays / locked）。
 * 期望数值**照抄** Python 测试，不自行手算。任何偏差都让对拍失败。
 *
 * 映射约定（TS HoldingDaySnapshot ↔ Python PhaseLockBar）：
 *   adj_open→qfqOpen, adj_high→qfqHigh, adj_low→qfqLow, adj_close→qfqClose, ma5→ma5;
 *   raw_open→rawOpen(默认=qfqOpen), raw_high→rawHigh(默认=qfqHigh), up_limit→upLimit, down_limit→downLimit;
 *   停牌(suspended)→hasQuote=false 且各价 null。
 *   exit_index = 命中出场那根在 days 中的下标（decidePhaseLock 返回 exitIndex 直接断言）。
 *
 * decidePhaseLock 返回 PhaseLockOutcome（与 Python PhaseLockOutcome 同构），no_entry/no_exit
 * 也带 locked/holdDays，故可逐位镜像 D1 的 no_exit(locked,hold_days) / no_entry(reason) 断言。
 */

import {
  decidePhaseLock,
  floor2,
  simulateTradeCore,
  HoldingDaySnapshot,
  PhaseLockOutcome,
  SimulationInput,
  WindowQuote,
} from './signal-stats.simulator';
import { collectRecentLows } from './signal-stats.simulator.db';

// ─────────────────────────────────────────────────────────────────────────────
// 构造助手：与 Python test 的 _bar 同义（未给 ro/rh 默认等于复权 open/high，不触发限停板）。
// ─────────────────────────────────────────────────────────────────────────────
interface BarOpts {
  o?: number | null;
  h?: number | null;
  low?: number | null;
  c?: number | null;
  ma5?: number | null;
  ro?: number | null;
  rh?: number | null;
  up?: number | null;
  dn?: number | null;
  sus?: boolean;
}

/** 造一根 day（calDate='d<idx>'，与 days 下标对齐）。 */
function bar(idx: number, opts: BarOpts = {}): HoldingDaySnapshot {
  const suspended = opts.sus === true;
  // 停牌日（sus 或全 None）：hasQuote=false，所有价 null（与 Python _is_suspended 口径一致）。
  const allNone =
    opts.o === undefined &&
    opts.h === undefined &&
    opts.low === undefined &&
    opts.c === undefined;
  const isSuspended = suspended || allNone;
  if (isSuspended) {
    return {
      calDate: `d${idx}`,
      hasQuote: false,
      qfqOpen: null,
      qfqClose: null,
      qfqHigh: null,
      qfqLow: null,
      rawOpen: null,
      rawHigh: null,
      upLimit: null,
      downLimit: null,
      ma5: null,
      exitSignalHit: false,
    };
  }
  const o = opts.o ?? null;
  const h = opts.h ?? null;
  return {
    calDate: `d${idx}`,
    hasQuote: true,
    qfqOpen: o,
    qfqClose: opts.c ?? null,
    qfqHigh: h,
    qfqLow: opts.low ?? null,
    rawOpen: opts.ro ?? o,
    rawHigh: opts.rh ?? h,
    upLimit: opts.up ?? null,
    downLimit: opts.dn ?? null,
    ma5: opts.ma5 ?? null,
    exitSignalHit: false,
  };
}

/** 构造 days：依次给每个 BarOpts 配下标。 */
function days(...opts: BarOpts[]): HoldingDaySnapshot[] {
  return opts.map((o, i) => bar(i, o));
}

/** 默认 delistDate=null（未退市）的 opts 工厂。 */
function opts(initFactor: number, lockFactor: number, lookback = 3) {
  return { initFactor, lockFactor, lookback, delistDate: null };
}

/** 全字段 exit Outcome 断言助手（镜像 Python `assert out == PhaseLockOutcome(...)`）。 */
function expectOutcome(actual: PhaseLockOutcome, expected: Partial<PhaseLockOutcome>): void {
  expect(actual.kind).toBe(expected.kind);
  if (expected.reason !== undefined) expect(actual.reason).toBe(expected.reason);
  if (expected.exitIndex !== undefined) expect(actual.exitIndex).toBe(expected.exitIndex);
  if (expected.exitPrice !== undefined) expect(actual.exitPrice).toBe(expected.exitPrice);
  if (expected.holdDays !== undefined) expect(actual.holdDays).toBe(expected.holdDays);
  if (expected.locked !== undefined) expect(actual.locked).toBe(expected.locked);
}

// ─────────────────────────────────────────────────────────────────────────────
// floor2 取整边界（跨语言逐位一致，与 Python test_floor2_boundaries 同）
// ─────────────────────────────────────────────────────────────────────────────
describe('floor2 (phase_lock 边界)', () => {
  it('取整边界与 Python 逐位一致', () => {
    expect(floor2(9.99)).toBe(9.99);
    expect(floor2(10.4895)).toBe(10.48);
    expect(floor2(10.567 * 0.999)).toBe(10.55);
    expect(floor2(9.5 * 0.999)).toBe(9.49); // 初始止损边界
    expect(floor2(10.5 * 0.999)).toBe(10.48); // 锁定止损边界
    expect(floor2(9.5 * 1.0)).toBe(9.5); // if=1.0 仍截断
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decidePhaseLock 对拍样例 S1~S15（+ 补充），逐数值镜像 test_phase_lock_exit.py
// ─────────────────────────────────────────────────────────────────────────────
describe('decidePhaseLock 对拍样例（镜像 D1 S1~S15）', () => {
  // S1：阶段A盘中止损（精确数值）
  it('S1 阶段A盘中止损：exitIndex=1, exitPrice=9.50, holdDays=1, locked=false', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.5,
      holdDays: 1,
      locked: false,
    });
  });

  // S2：阶段A跳空低开止损 → exit_price = open（min 取开盘）
  it('S2 阶段A跳空低开取 open：exitPrice=9.30', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.3, h: 9.35, low: 9.2, c: 9.25 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.3,
      holdDays: 1,
      locked: false,
    });
  });

  // S3：阶段A止损固定不上移（与 band_lock 核心差异）→ no_exit, locked=false, hold_days=2
  it('S3 阶段A止损固定不上移：no_exit, locked=false, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.55, ma5: null }, // 大涨但 ma5=null → 不锁
      { o: 10.0, h: 10.2, low: 9.6, c: 10.1, ma5: null }, // low9.6>init_stop9.50 → 不止损
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 0.999));
    expectOutcome(out, { kind: 'no_exit', locked: false, holdDays: 2 });
  });

  // S4：阶段切换 + 次日生效（锁定，切换当日不出场）→ no_exit, locked=true, hold_days=2
  it('S4 阶段切换次日生效：no_exit, locked=true, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 },
      { o: 10.6, h: 10.8, low: 10.55, c: 10.7, ma5: 10.0 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, { kind: 'no_exit', locked: true, holdDays: 2 });
  });

  // S5：阶段B止损（锁定后盘中触锁定止损）
  it('S5 阶段B止损：exitIndex=2, exitPrice=10.48, holdDays=2, locked=true', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 }, // 锁定 stop=10.48
      { o: 10.5, h: 10.6, low: 10.4, c: 10.42, ma5: 10.0 }, // low10.40≤10.48 触发
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 2,
      exitPrice: 10.48,
      holdDays: 2,
      locked: true,
    });
  });

  // S6：阶段B MA5 清仓（close<MA5 且 MA5<prev_ma5 → 按收盘价）
  it('S6 阶段B MA5 清仓：exitIndex=3, exitPrice=9.9, holdDays=3, locked=true', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 }, // 锁定 stop=10.48
      { o: 10.6, h: 10.8, low: 10.5, c: 10.7, ma5: 10.0 }, // 持有；prev_ma5→10.0
      { o: 10.5, h: 10.6, low: 10.49, c: 9.9, ma5: 9.95 }, // MA5 清仓
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_ma5',
      exitIndex: 3,
      exitPrice: 9.9,
      holdDays: 3,
      locked: true,
    });
  });

  // S7：同日盘中止损优先于 MA5 清仓（阶段B）
  it('S7 盘中止损优先于 MA5 清仓：reason=phase_lock_stop, exitPrice=10.48', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 }, // 锁定 stop=10.48
      { o: 10.6, h: 10.8, low: 10.5, c: 10.7, ma5: 10.0 }, // 持有；prev_ma5→10.0
      { o: 10.5, h: 10.6, low: 10.4, c: 9.9, ma5: 9.95 }, // 止损与 MA5 同日
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop', // 止损优先，非 phase_lock_ma5
      exitIndex: 3,
      exitPrice: 10.48,
      holdDays: 3,
      locked: true,
    });
  });

  // S8：不足 lookback 根降级（次新股，仅 2 根可用）
  it('S8 不足 lookback 降级：exitPrice=9.60', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.8, c: 9.9 },
      { o: 9.7, h: 9.8, low: 9.5, c: 9.55 },
    );
    const out = decidePhaseLock(d, [9.8, 9.6], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.6,
      holdDays: 1,
      locked: false,
    });
  });

  it('S8b 空 recentLows → 无初始止损 → no_exit, locked=false, holdDays=1', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.8, c: 9.9 },
      { o: 9.0, h: 9.1, low: 8.0, c: 8.5 }, // 暴跌但 init_stop=null → 不止损
    );
    const out = decidePhaseLock(d, [], opts(1.0, 1.0));
    expectOutcome(out, { kind: 'no_exit', locked: false, holdDays: 1 });
  });

  // S9：停牌跨越 → 不计 hold、不动 stop、不动 prev_ma5
  it('S9 停牌跳过：exitIndex=2, exitPrice=9.50, holdDays=1', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      {}, // 停牌
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 2,
      exitPrice: 9.5,
      holdDays: 1,
      locked: false,
    });
  });

  it('S9b is_suspended 标记日按停牌跳过', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45, sus: true }, // 标记停牌（但有价）→ 跳过
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45 }, // 真正触发日
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expect(out.kind).toBe('exit');
    expect(out.reason).toBe('phase_lock_stop');
    expect(out.exitIndex).toBe(2);
    expect(out.holdDays).toBe(1);
  });

  // S10：封死跌停顺延（止损）→ 次日非封死 @adj_open，reason 保留
  it('S10 封死跌停顺延止损：exitIndex=2, exitPrice=9.3, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45, rh: 9.7, dn: 9.7 }, // 封死跌停
      { o: 9.3, h: 9.4, low: 9.2, c: 9.3 }, // 次日非封死
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 2,
      exitPrice: 9.3,
      holdDays: 2,
      locked: false,
    });
  });

  // S11：封死跌停顺延（MA5 清仓）→ 次日非封死 @adj_open，reason 保留
  it('S11 封死跌停顺延 MA5：exitIndex=4, exitPrice=9.8, holdDays=4, locked=true', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 }, // 锁定 stop=10.48
      { o: 10.6, h: 10.8, low: 10.5, c: 10.7, ma5: 10.0 }, // 持有；prev_ma5→10.0
      { o: 10.5, h: 10.6, low: 10.49, c: 9.9, ma5: 9.95, rh: 10.6, dn: 10.6 }, // MA5 清仓但封死 → 顺延
      { o: 9.8, h: 9.9, low: 9.7, c: 9.75, ma5: 9.9 }, // 次日非封死
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_ma5',
      exitIndex: 4,
      exitPrice: 9.8,
      holdDays: 4,
      locked: true,
    });
  });

  // S12：涨停开盘不入场 → no_entry / limit_up
  it('S12 涨停开盘不入场：no_entry, reason=limit_up', () => {
    const d = days({ o: 10.0, h: 10.0, low: 10.0, c: 10.0, ro: 10.0, up: 10.0 });
    const out = decidePhaseLock(d, [10.0], opts(0.999, 0.999, 3));
    expectOutcome(out, { kind: 'no_entry', reason: 'limit_up' });
  });

  it('S12b raw_open < up_limit（未顶格）→ 入场成立 → no_exit', () => {
    const d = days({ o: 9.99, h: 10.0, low: 9.9, c: 9.95, ro: 9.99, up: 10.0 });
    const out = decidePhaseLock(d, [9.9], opts(0.999, 0.999, 3));
    expect(out.kind).toBe('no_exit');
  });

  it('入场停牌 → no_entry, reason=suspended', () => {
    const d = days({}); // 全 None
    const out = decidePhaseLock(d, [], opts(0.999, 0.999, 3));
    expectOutcome(out, { kind: 'no_entry', reason: 'suspended' });
  });

  // S13：窗口耗尽未出场 → no_exit
  it('S13 窗口耗尽未出场：no_exit, locked=false, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.5, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.0, c: 10.2 },
      { o: 10.2, h: 10.4, low: 10.1, c: 10.3 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, { kind: 'no_exit', locked: false, holdDays: 2 });
  });

  // S14：两个独立 factor 生效（init_factor 与 lock_factor 互不串用）
  it('S14 两个独立 factor：exitIndex=2, exitPrice=10.55, holdDays=2, locked=true', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 }, // 锁定 stop=10.55（lf=1.005）
      { o: 10.6, h: 10.7, low: 10.54, c: 10.6, ma5: 10.0 }, // low10.54≤10.55 触发
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.98, 1.005));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 2,
      exitPrice: 10.55,
      holdDays: 2,
      locked: true,
    });
  });

  it('S14b init_factor 仅作用初始止损：exitPrice=9.31', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.5, h: 9.6, low: 9.3, c: 9.35 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.98, 1.005));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.31,
      holdDays: 1,
      locked: false,
    });
  });

  // S15：切换当日盘中先止损 → phase_lock_stop 且当日不锁定（locked=false）
  it('S15 切换当日盘中先止损：exitPrice=9.50, locked=false', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 9.6, h: 10.7, low: 9.4, c: 10.6, ma5: 9.8 }, // 止损与切换条件同日
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.5,
      holdDays: 1,
      locked: false, // 当日先止损，未锁定
    });
  });

  // 补充：持仓首日不自止损（初始止损 T+2 才生效）
  it('补充 持仓首日不自止损：单根窗口 → no_exit, locked=false, holdDays=0', () => {
    const d = days({ o: 10.0, h: 10.2, low: 8.0, c: 10.1 });
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, { kind: 'no_exit', locked: false, holdDays: 0 });
  });

  // 补充：MA5 预热不足（ma5=null）→ 不锁、不清仓，仅止损逻辑
  it('补充 MA5 预热不足：exitIndex=2, exitPrice=9.50, holdDays=2, locked=false', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: null },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.55, ma5: null },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45, ma5: null },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(1.0, 1.0));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 2,
      exitPrice: 9.5,
      holdDays: 2,
      locked: false,
    });
  });

  // 补充：空 bars 防御 → no_exit
  it('补充 空 bars → no_exit', () => {
    const out = decidePhaseLock([], [10.0], opts(0.999, 0.999));
    expect(out.kind).toBe('no_exit');
  });

  // 补充：默认参数对齐（init_stop=floor2(9.5×0.999)=9.49）
  it('补充 默认 0.999/0.999：exitIndex=1, exitPrice=9.49', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.48, c: 9.5 },
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], opts(0.999, 0.999));
    expectOutcome(out, {
      kind: 'exit',
      reason: 'phase_lock_stop',
      exitIndex: 1,
      exitPrice: 9.49,
      holdDays: 1,
      locked: false,
    });
  });

  // signal-stats 专属：退市强平（核函数不处理，由 decidePhaseLock 接 delistDate 分支）
  it('退市强平：cal_date>=delistDate 用退市前最后有 quote 日，reason=delist', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.95, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.05, c: 12.0 }, // 最后有 quote 日
      { o: 10.2, h: 10.4, low: 10.1, c: 10.3 }, // cal_date d2 >= delist → 退市触发
    );
    const out = decidePhaseLock(d, [10.0, 9.8, 9.5], {
      initFactor: 0.999,
      lockFactor: 0.999,
      lookback: 3,
      delistDate: 'd2',
    });
    expectOutcome(out, { kind: 'exit', reason: 'delist', exitIndex: 1, holdDays: 1 });
    expect(out.exitPrice).toBeNull(); // delist 不给成交价 → simulateTradeCore 回退取 qfqClose
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// simulateTradeCore 端到端：phase_lock 分支取 outcome.exitPrice、exitReason 落地、入场过滤
// ─────────────────────────────────────────────────────────────────────────────

/** phase_lock 走 simulateTradeCore 的输入工厂（daysSinceList 给足、未退市）。 */
function phaseLockInput(
  d: HoldingDaySnapshot[],
  recentLows: number[],
  overrides: Partial<SimulationInput> = {},
): SimulationInput {
  return {
    tsCode: '000001.SZ',
    signalDate: '20260101',
    days: d,
    daysSinceList: 999,
    delistDate: null,
    recentLows,
    exit: { mode: 'phase_lock', initFactor: 0.999, lockFactor: 0.999, lookback: 3 },
    ...overrides,
  };
}

describe('simulateTradeCore phase_lock 集成', () => {
  it('S1 端到端：buyPrice=10, exitPrice=9.50, ret=9.50/10-1, exitReason=phase_lock_stop', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45 },
    );
    const out = simulateTradeCore(
      phaseLockInput(d, [10.0, 9.8, 9.5], {
        exit: { mode: 'phase_lock', initFactor: 1.0, lockFactor: 1.0, lookback: 3 },
      }),
    );
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.buyPrice).toBe(10);
    expect(out.trade.exitPrice).toBe(9.5);
    expect(out.trade.ret).toBeCloseTo(9.5 / 10 - 1, 10);
    expect(out.trade.exitReason).toBe('phase_lock_stop');
    expect(out.trade.exitDate).toBe('d1');
    expect(out.trade.holdDays).toBe(1);
  });

  it('S6 端到端 ma5 清仓：exitPrice=qfqClose=9.9, exitReason=phase_lock_ma5', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0, ma5: 9.6 },
      { o: 10.2, h: 10.7, low: 10.5, c: 10.6, ma5: 9.8 },
      { o: 10.6, h: 10.8, low: 10.5, c: 10.7, ma5: 10.0 },
      { o: 10.5, h: 10.6, low: 10.49, c: 9.9, ma5: 9.95 },
    );
    const out = simulateTradeCore(phaseLockInput(d, [10.0, 9.8, 9.5]));
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.exitReason).toBe('phase_lock_ma5');
    expect(out.trade.exitPrice).toBe(9.9);
    expect(out.trade.ret).toBeCloseTo(9.9 / 10 - 1, 10);
  });

  it('S12 一字涨停买不进：filtered limit_up（沿用现有入场过滤）', () => {
    const d = days({ o: 10.0, h: 10.0, low: 10.0, c: 10.0, ro: 10.0, up: 10.0 });
    const out = simulateTradeCore(phaseLockInput(d, [10.0]));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('limit_up');
  });

  it('入场停牌 → filtered suspended', () => {
    const d = days({}); // 全 None
    const out = simulateTradeCore(phaseLockInput(d, []));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('suspended');
  });

  it('次新 daysSinceList<60 → filtered new_listing', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 10.0 },
      { o: 9.6, h: 9.7, low: 9.4, c: 9.45 },
    );
    const out = simulateTradeCore(phaseLockInput(d, [10.0, 9.8, 9.5], { daysSinceList: 59 }));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('new_listing');
  });

  it('S13 端到端 窗口耗尽：filtered insufficient_data', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.5, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.0, c: 10.2 },
      { o: 10.2, h: 10.4, low: 10.1, c: 10.3 },
    );
    const out = simulateTradeCore(phaseLockInput(d, [10.0, 9.8, 9.5]));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('insufficient_data');
  });

  it('退市强平端到端：exitReason=delist, exitPrice=qfqClose(退市前最后有 quote 日)', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.95, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.05, c: 12.0 }, // 退市前最后有 quote 日
      { o: 10.2, h: 10.4, low: 10.1, c: 10.3 },
    );
    const out = simulateTradeCore(phaseLockInput(d, [10.0, 9.8, 9.5], { delistDate: 'd2' }));
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.exitReason).toBe('delist');
    expect(out.trade.exitPrice).toBe(12.0); // 回退取 d1 的 qfqClose
    expect(out.trade.exitDate).toBe('d1');
    expect(out.trade.holdDays).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectRecentLows（DB 层 recentLows 切窗）：含 buyDate 的最近 lookback 个非停牌 qfqLow，升序
// ─────────────────────────────────────────────────────────────────────────────
describe('collectRecentLows', () => {
  function q(qfqLow: number | null): WindowQuote {
    return { qfqOpen: qfqLow, qfqClose: qfqLow, open: qfqLow, qfqLow };
  }

  it('含 buyDate 的最近 lookback 个非停牌 qfqLow，升序返回', () => {
    const cal = ['d0', 'd1', 'd2', 'd3', 'd4'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(10)],
      ['d1', q(11)],
      ['d2', q(12)], // buyDate = d2 (buyIdx=2)
    ]);
    // buyIdx=2, lookback=3 → 回看 d2,d1,d0 → [10,11,12]（升序）
    expect(collectRecentLows(cal, 2, m, 3)).toEqual([10, 11, 12]);
  });

  it('不足 lookback（次新股）→ 用现有可用个数', () => {
    const cal = ['d0', 'd1'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(9.8)],
      ['d1', q(9.6)], // buyDate = d1 (buyIdx=1)
    ]);
    expect(collectRecentLows(cal, 1, m, 3)).toEqual([9.8, 9.6]);
  });

  it('停牌日（无 key）跳过、不占 lookback 名额', () => {
    const cal = ['d0', 'd1', 'd2', 'd3'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(10)],
      // d1 停牌：无 key
      ['d2', q(12)],
      ['d3', q(13)], // buyDate = d3 (buyIdx=3)
    ]);
    // 回看 d3,d2,(d1 跳过),d0 → 收满 3 个非停牌：13,12,10 → 升序 [10,12,13]
    expect(collectRecentLows(cal, 3, m, 3)).toEqual([10, 12, 13]);
  });

  it('qfqLow=null 视为停牌跳过', () => {
    const cal = ['d0', 'd1', 'd2'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(10)],
      ['d1', { qfqOpen: 11, qfqClose: 11, open: 11, qfqLow: null }],
      ['d2', q(12)], // buyDate
    ]);
    expect(collectRecentLows(cal, 2, m, 3)).toEqual([10, 12]);
  });

  it('全停牌 → 空数组（核视为无初始止损）', () => {
    const cal = ['d0', 'd1'];
    const m = new Map<string, WindowQuote>();
    expect(collectRecentLows(cal, 1, m, 3)).toEqual([]);
  });
});
