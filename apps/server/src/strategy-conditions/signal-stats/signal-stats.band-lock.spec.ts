/**
 * signal-stats.band-lock.spec.ts
 *
 * 波段跟踪止损 trailing_lock 出场规则纯函数单测 —— 与 Python 共享核 band_lock_exit.py
 * **跨语言对拍**的 TS 侧期望表，逐条对 docs/.../2026-06-09-trailing-lock-exit-design/02 §四 样例
 * S1~S13 做精确数值断言（含 reason / exitDate(=exit_index) / exitPrice / holdDays），任何偏差都让对拍失败。
 * 期望数值与 apps/quant-pipeline/tests/unit/test_band_lock_exit.py 完全一致。
 *
 * 映射约定（TS HoldingDaySnapshot ↔ Python BandLockBar）：
 *   adj_open→qfqOpen, adj_high→qfqHigh, adj_low→qfqLow, adj_close→qfqClose, ma5→ma5;
 *   raw_open→rawOpen(默认=qfqOpen), raw_high→rawHigh(默认=qfqHigh), up_limit→upLimit, down_limit→downLimit;
 *   停牌(suspended)→hasQuote=false 且各价 null。
 *   exit_index = 命中出场那根在 days 中的下标；这里把每根 days[i] 的 calDate 设为 'd<i>'，
 *   用 exitDay.calDate==='d<exit_index>' 断言下标。
 *
 * 入场过滤（停牌/一字涨停/次新）由 simulateTradeCore 接管，故 S8(limit_up)/入场停牌 通过 simulateTradeCore 验。
 * 纯出场推进（S1~S7、S9~S13）直接验 decideBandLock，并辅以 simulateTradeCore 端到端验 exitPrice/exitReason 落地。
 */

import {
  decideBandLock,
  floor2,
  simulateTradeCore,
  HoldingDaySnapshot,
  SimulationInput,
  WindowQuote,
} from './signal-stats.simulator';
import { attachMa5 } from './signal-stats.simulator.db';

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

/** 造一根 day（calDate='d<idx>'，与 days 下标对齐，便于断言 exit_index）。 */
function bar(idx: number, opts: BarOpts = {}): HoldingDaySnapshot {
  const suspended = opts.sus === true;
  // 停牌日（sus 或全 None）：hasQuote=false，所有价 null（与 buildHoldingDays / Python _is_suspended 口径一致）。
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

/** trailing_lock 走 simulateTradeCore 的输入工厂（daysSinceList 给足、未退市）。 */
function bandLockInput(
  d: HoldingDaySnapshot[],
  signalHigh: number,
  overrides: Partial<SimulationInput> = {},
): SimulationInput {
  return {
    tsCode: '000001.SZ',
    signalDate: '20260101',
    days: d,
    daysSinceList: 999,
    delistDate: null,
    signalHigh,
    exit: { mode: 'trailing_lock' },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// floor2 取整边界（跨语言逐位一致，与 Python test_floor2_boundaries 同）
// ─────────────────────────────────────────────────────────────────────────────
describe('floor2', () => {
  it('取整边界与 Python 逐位一致', () => {
    expect(floor2(9.99)).toBe(9.99);
    expect(floor2(10.4895)).toBe(10.48);
    expect(floor2(10.567 * 0.999)).toBe(10.55); // 10.556433 → 10.55
    expect(floor2(10.0 * 0.999)).toBe(9.99); // 方案一初始止损
    expect(floor2(9.7 * 0.999)).toBe(9.69); // 方案二初始止损
    expect(floor2(10.5 * 0.999)).toBe(10.48); // 锁定止损
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideBandLock 直接验：S1~S7、S9~S13（纯出场推进；入场已由调用方过滤）
// ─────────────────────────────────────────────────────────────────────────────
describe('decideBandLock 对拍样例', () => {
  // S1：方案一·跟踪止损出场（精确数值）
  it('S1 方案一跟踪止损：exit_index=2, exitPrice=10.45, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec).not.toBeNull();
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d2');
    expect(dec!.exitPrice).toBe(10.45); // min(10.48, open(d2)=10.45)
    expect(dec!.holdDays).toBe(2);
  });

  // S2：方案一·锁定后 MA5 离场
  it('S2 锁定后 MA5 离场：exit_index=2, exitPrice=10.1, holdDays=2', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2, ma5: 10.0 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, ma5: 10.3 },
      { o: 10.5, h: 10.6, low: 10.5, c: 10.1, ma5: 10.2 },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('ma5_exit');
    expect(dec!.exitDay.calDate).toBe('d2');
    expect(dec!.exitPrice).toBe(10.1);
    expect(dec!.holdDays).toBe(2);
  });

  // S3：方案二·初始止损=floor2(9.7×0.999)=9.69（精确数值）
  it('S3 方案二初始止损：exit_index=1, exitPrice=9.69, holdDays=1', () => {
    const d = days(
      { o: 10.0, h: 10.0, low: 9.7, c: 9.9 },
      { o: 9.8, h: 9.85, low: 9.6, c: 9.7 },
    );
    const dec = decideBandLock(d, { signalHigh: 99.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d1');
    expect(dec!.exitPrice).toBe(9.69); // min(9.69, open(d1)=9.8)
    expect(dec!.holdDays).toBe(1);
  });

  // S4：方案二·保本地板触发（止损被抬到 floor2(cost×0.999)=9.99）
  it('S4 方案二保本地板触发：exit_index=2, exitPrice=9.99', () => {
    const d = days(
      { o: 10.0, h: 10.0, low: 9.7, c: 9.9 },
      { o: 10.1, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.0, h: 10.05, low: 9.98, c: 9.99 },
    );
    const dec = decideBandLock(d, { signalHigh: 99.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d2');
    expect(dec!.exitPrice).toBe(9.99); // 地板把止损抬到 9.99
    expect(dec!.holdDays).toBe(2);
  });

  // S4 配对：T+2 low 10.00 > 地板 9.99 → 不触发，no_exit（null）。
  it('S4 配对 地板上方不触发：null（no_exit）', () => {
    const d = days(
      { o: 10.0, h: 10.0, low: 9.7, c: 9.9 },
      { o: 10.1, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.0, h: 10.1, low: 10.0, c: 10.05 },
    );
    expect(decideBandLock(d, { signalHigh: 99.0, delistDate: null })).toBeNull();
  });

  // S5：跳空低开 → exitPrice = open（min 取开盘）
  it('S5 跳空低开取 open：exit_index=2, exitPrice=10.0', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.0, h: 10.05, low: 9.9, c: 9.95 },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d2');
    expect(dec!.exitPrice).toBe(10.0); // min(10.48, open(d2)=10.0)
    expect(dec!.holdDays).toBe(2);
  });

  // S6：封死跌停顺延 → 次日非封死 @qfq_open，reason 保留，exit_index=实际卖出日，holdDays 顺延续增
  it('S6 封死跌停顺延：exit_index=3, exitPrice=10.2, holdDays=3, reason=stop', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42, rh: 10.5, dn: 10.5 }, // 封死跌停
      { o: 10.2, h: 10.3, low: 10.1, c: 10.2 }, // 次日非封死
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d3'); // 顺延到实际卖出日
    expect(dec!.exitPrice).toBe(10.2); // @qfq_open(d3)
    expect(dec!.holdDays).toBe(3); // 顺延期续增
  });

  // S7：停牌跳过 → 不计 hold、不触发、不更新止损
  it('S7 停牌跳过：exit_index=3, holdDays=2（停牌日不计）', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      {}, // 停牌：全 None
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d3');
    expect(dec!.exitPrice).toBe(10.45);
    expect(dec!.holdDays).toBe(2); // 停牌日不计
  });

  it('S7b is_suspended 标记日按停牌跳过（hasQuote=false 等价）', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, sus: true }, // 标记停牌
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 }, // 真正的锁定日
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d3');
    expect(dec!.holdDays).toBe(2);
  });

  // S9：持仓首日不自止损（初始止损 T+2 才生效）
  it('S9 持仓首日不自止损：单根窗口 → null', () => {
    const d = days({ o: 10.0, h: 10.2, low: 8.0, c: 10.1 });
    expect(decideBandLock(d, { signalHigh: 99.0, delistDate: null })).toBeNull();
  });

  // S10：MA5 预热不足（ma5=null）→ 不触发 MA5 离场，仅止损逻辑
  it('S10 MA5 预热不足：exit_index=3, exitPrice=10.45, holdDays=3, reason=stop', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2, ma5: null },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, ma5: null },
      { o: 10.5, h: 10.55, low: 10.5, c: 10.0, ma5: null }, // 大跌但 ma5=null → 不 ma5_exit
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42, ma5: null },
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d3');
    expect(dec!.exitPrice).toBe(10.45);
    expect(dec!.holdDays).toBe(3);
  });

  // S11：max_hold 兜底（精确 exit_index/holdDays/exitPrice）
  it('S11 max_hold 兜底：exit_index=10, holdDays=10, exitPrice=11.05', () => {
    const opts: BarOpts[] = [{ o: 10.0, h: 10.2, low: 9.95, c: 10.1 }];
    for (let k = 0; k < 10; k++) {
      const px = 10.1 + 0.1 * k;
      opts.push({ o: px, h: px + 0.1, low: px, c: px + 0.05 });
    }
    const d = days(...opts);
    expect(d).toHaveLength(11); // indices 0..10
    const dec = decideBandLock(d, { signalHigh: 999.0, maxHold: 10, delistDate: null });
    expect(dec!.exitReason).toBe('max_hold');
    expect(dec!.exitDay.calDate).toBe('d10');
    expect(dec!.holdDays).toBe(10);
    // 第 10 根 qfq_close = (10.1 + 0.1*9) + 0.05 = 11.05
    expect(dec!.exitPrice).toBeCloseTo(11.05, 10);
  });

  // S12：窗口耗尽未出场 → null（no_exit）
  it('S12 窗口耗尽未出场：null', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.95, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.05, c: 10.2 },
    );
    expect(decideBandLock(d, { signalHigh: 999.0, delistDate: null })).toBeNull();
  });

  // S13：方案二·保本地板锁定当日首次浮盈（验 (2-pre) 先激活地板）
  it('S13 保本地板锁定当日首次浮盈：exit_index=2, exitPrice=10.48, holdDays=2', () => {
    const d = days(
      { o: 10.5, h: 10.5, low: 9.0, c: 10.0 },
      { o: 10.55, h: 10.7, low: 9.6, c: 10.6 },
      { o: 10.5, h: 10.5, low: 10.47, c: 10.48 },
    );
    const dec = decideBandLock(d, { signalHigh: 9.5, delistDate: null });
    expect(dec!.exitReason).toBe('stop');
    expect(dec!.exitDay.calDate).toBe('d2');
    expect(dec!.exitPrice).toBe(10.48); // 冻结止损=max(floor2(9.6×0.999)=9.59, floor2(10.5×0.999)=10.48)=10.48
    expect(dec!.holdDays).toBe(2);
  });

  // S13 配对：T+3 low 10.49 > 冻结止损 10.48 → 不触发，null（证伪“地板未在锁定当日激活”）
  it('S13 配对 冻结止损上方不触发：null', () => {
    const d = days(
      { o: 10.5, h: 10.5, low: 9.0, c: 10.0 },
      { o: 10.55, h: 10.7, low: 9.6, c: 10.6 },
      { o: 10.5, h: 10.6, low: 10.49, c: 10.55 },
    );
    expect(decideBandLock(d, { signalHigh: 9.5, delistDate: null })).toBeNull();
  });

  // 铁律：日内止损(1) 优先于 收盘 MA5 离场(2b)
  it('日内止损优先于 MA5 离场：reason=stop, exit_index=2', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2, ma5: 10.0 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, ma5: 10.3 }, // 锁定 stop_next=10.48
      { o: 10.45, h: 10.5, low: 10.4, c: 10.1, ma5: 10.2 }, // 止损 + MA5 同时满足
    );
    const dec = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(dec!.exitReason).toBe('stop'); // 止损优先
    expect(dec!.exitDay.calDate).toBe('d2');
  });

  it('空 days → null', () => {
    expect(decideBandLock([], { signalHigh: 10.0, delistDate: null })).toBeNull();
  });

  // signal-stats 专属：退市强平（核函数不处理，由 decideBandLock 接 delistDate 分支）
  it('退市强平：cal_date>=delistDate 用退市前最后有 quote 日 qfq_close 强平 delist', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.95, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.05, c: 12.0 }, // 最后有 quote 日
      { o: 10.2, h: 10.4, low: 10.1, c: 10.3 }, // cal_date d2 >= delist → 退市触发
    );
    const dec = decideBandLock(d, { signalHigh: 999.0, delistDate: 'd2' });
    expect(dec!.exitReason).toBe('delist');
    expect(dec!.exitDay.calDate).toBe('d1');
    expect(dec!.exitPrice).toBeUndefined(); // delist 不给 exitPrice，simulateTradeCore 回退取 qfqClose
    expect(dec!.holdDays).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // S14~S19：4 个放开参数（stopRatio / floorRatio / floorEnabled / ma5RequireDown）
  // 的边界对拍样例。每条同时断言「默认参数回归」与「变体行为」，与 Python
  // test_band_lock_exit.py 的 S14~S19 **逐位一致**（跨语言对拍）。
  // 注：核接收已量化的网格点 ratio（量化是各入口的事），样例直接传网格点 ratio。
  // ───────────────────────────────────────────────────────────────────────────

  // S14：stopRatio=0.997 → 锁定止损价更低，同日成交价不同。
  it('S14 stopRatio=0.997 压低锁定止损：默认 @10.48 / 变体 @10.46', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.5, h: 10.6, low: 10.4, c: 10.42 },
    );
    // 默认参数回归
    const def = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(def!.exitReason).toBe('stop');
    expect(def!.exitDay.calDate).toBe('d2');
    expect(def!.exitPrice).toBe(10.48);
    expect(def!.holdDays).toBe(2);
    // 变体 stopRatio=0.997
    const v = decideBandLock(d, { signalHigh: 10.0, delistDate: null, stopRatio: 0.997 });
    expect(v!.exitReason).toBe('stop');
    expect(v!.exitDay.calDate).toBe('d2');
    expect(v!.exitPrice).toBe(10.46);
    expect(v!.holdDays).toBe(2);
  });

  // S15：stopRatio=1.0 → 仅去缓冲，floor2 截断仍生效（floor2(10.567)=10.56 ≠ 10.567）。
  it('S15 stopRatio=1.0 floor2 仍截断：默认 @10.55 / 变体 @10.56', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.567, c: 10.5 },
      { o: 10.6, h: 10.7, low: 10.55, c: 10.6 },
    );
    const def = decideBandLock(d, { signalHigh: 10.0, delistDate: null });
    expect(def!.exitReason).toBe('stop');
    expect(def!.exitDay.calDate).toBe('d2');
    expect(def!.exitPrice).toBe(10.55);
    expect(def!.holdDays).toBe(2);
    const v = decideBandLock(d, { signalHigh: 10.0, delistDate: null, stopRatio: 1.0 });
    expect(v!.exitReason).toBe('stop');
    expect(v!.exitDay.calDate).toBe('d2');
    expect(v!.exitPrice).toBe(10.56); // floor2(10.567×1.0)=10.56，证明 1.0 仍截断
    expect(v!.holdDays).toBe(2);
  });

  // S16：floorRatio=1.02, floorEnabled=true（方案二盈利回落）→ 锁盈地板拦截。
  // ⚠️ 10.0×1.02=10.2 但 10.2×100=1019.9999…→floor2=10.19（跨语言浮点逐位一致）。
  it('S16 floorRatio=1.02 锁盈地板：默认 null / 变体 stop @10.19', () => {
    const d = days(
      { o: 10.0, h: 10.0, low: 9.7, c: 9.9 },
      { o: 10.1, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.25, h: 10.3, low: 10.0, c: 10.05 },
    );
    // 默认参数回归：地板 9.99 拦不住，d2 low10.0 在止损上方 → null（no_exit）
    expect(decideBandLock(d, { signalHigh: 99.0, delistDate: null })).toBeNull();
    // 变体 floorRatio=1.02：锁盈地板 10.19 拦截
    const v = decideBandLock(d, { signalHigh: 99.0, delistDate: null, floorRatio: 1.02 });
    expect(v!.exitReason).toBe('stop');
    expect(v!.exitDay.calDate).toBe('d2');
    expect(v!.exitPrice).toBe(10.19); // floor2(10×1.02)=10.19（浮点截断，与 Python 逐位一致）
    expect(v!.holdDays).toBe(2);
  });

  // S17：floorEnabled=false（方案二）→ 不设地板，止损可跌破成本。
  it('S17 floorEnabled=false 止损跌破成本：默认 @9.99 / 变体 @9.79', () => {
    const d = days(
      { o: 10.0, h: 10.0, low: 9.7, c: 9.9 },
      { o: 10.1, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.0, h: 10.05, low: 9.5, c: 9.6 },
    );
    // 默认参数回归：地板把止损抬到 9.99
    const def = decideBandLock(d, { signalHigh: 99.0, delistDate: null });
    expect(def!.exitReason).toBe('stop');
    expect(def!.exitDay.calDate).toBe('d2');
    expect(def!.exitPrice).toBe(9.99);
    expect(def!.holdDays).toBe(2);
    // 变体 floorEnabled=false：无地板，止损 9.79（跌破成本）
    const v = decideBandLock(d, { signalHigh: 99.0, delistDate: null, floorEnabled: false });
    expect(v!.exitReason).toBe('stop');
    expect(v!.exitDay.calDate).toBe('d2');
    expect(v!.exitPrice).toBe(9.79);
    expect(v!.holdDays).toBe(2);
  });

  // S18：ma5RequireDown=false（锁定后收盘跌破 MA5 但 MA5 未下行）→ 立即 ma5_exit。
  it('S18 ma5RequireDown=false 提前 MA5 离场：默认 null / 变体 ma5_exit @10.1', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2, ma5: 10.0 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, ma5: 10.3 },
      { o: 10.5, h: 10.6, low: 10.5, c: 10.1, ma5: 10.4 }, // 跌破 MA5 但 MA5 上行（10.4>10.3）
    );
    // 默认参数回归：MA5 上行 → 不离场 → null（no_exit）
    expect(decideBandLock(d, { signalHigh: 10.0, delistDate: null })).toBeNull();
    // 变体 ma5RequireDown=false：收盘跌破 MA5 即离场
    const v = decideBandLock(d, { signalHigh: 10.0, delistDate: null, ma5RequireDown: false });
    expect(v!.exitReason).toBe('ma5_exit');
    expect(v!.exitDay.calDate).toBe('d2');
    expect(v!.exitPrice).toBe(10.1);
    expect(v!.holdDays).toBe(2);
  });

  // S19：组合 maxHold=10 + stopRatio=0.997 + floorEnabled=false + ma5RequireDown=false。
  it('S19 组合参数：默认 null / 变体 ma5_exit @10.6（d3, holdDays=3）', () => {
    const d = days(
      { o: 10.0, h: 10.1, low: 9.5, c: 9.8 },
      { o: 10.0, h: 10.5, low: 9.9, c: 10.4 },
      { o: 10.5, h: 11.2, low: 10.8, c: 11.0, ma5: 10.5 },
      { o: 11.0, h: 11.1, low: 10.9, c: 10.6, ma5: 10.7 },
    );
    // 默认参数回归：窗口耗尽 → null（no_exit）
    expect(decideBandLock(d, { signalHigh: 10.0, maxHold: 10, delistDate: null })).toBeNull();
    // 组合变体
    const v = decideBandLock(d, {
      signalHigh: 10.0,
      maxHold: 10,
      delistDate: null,
      stopRatio: 0.997,
      floorEnabled: false,
      ma5RequireDown: false,
    });
    expect(v!.exitReason).toBe('ma5_exit');
    expect(v!.exitDay.calDate).toBe('d3');
    expect(v!.exitPrice).toBe(10.6);
    expect(v!.holdDays).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// simulateTradeCore 端到端：trailing_lock 分支取 decision.exitPrice、exitReason 落地、入场过滤
// ─────────────────────────────────────────────────────────────────────────────
describe('simulateTradeCore trailing_lock 集成', () => {
  // S1 端到端：exitPrice=止损成交价(≠qfqClose)、ret 用该价、exitReason='stop'
  it('S1 端到端：buyPrice=10, exitPrice=10.45, ret=10.45/10-1, exitReason=stop', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const out = simulateTradeCore(bandLockInput(d, 10.0));
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.buyPrice).toBe(10);
    expect(out.trade.exitPrice).toBe(10.45); // 止损成交价（≠ qfqClose 10.42）
    expect(out.trade.ret).toBeCloseTo(10.45 / 10 - 1, 10);
    expect(out.trade.exitReason).toBe('stop');
    expect(out.trade.exitDate).toBe('d2');
    expect(out.trade.holdDays).toBe(2);
  });

  // ma5_exit 端到端：exitPrice=qfqClose
  it('S2 端到端 ma5_exit：exitPrice=qfqClose=10.1, exitReason=ma5_exit', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2, ma5: 10.0 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5, ma5: 10.3 },
      { o: 10.5, h: 10.6, low: 10.5, c: 10.1, ma5: 10.2 },
    );
    const out = simulateTradeCore(bandLockInput(d, 10.0));
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.exitReason).toBe('ma5_exit');
    expect(out.trade.exitPrice).toBe(10.1);
    expect(out.trade.ret).toBeCloseTo(10.1 / 10 - 1, 10);
  });

  // S8：一字涨停买不进 → 沿用现有 simulateTradeCore 过滤 limit_up
  it('S8 一字涨停买不进：filtered limit_up（沿用现有入场过滤）', () => {
    const d = days({ o: 10.0, h: 10.0, low: 10.0, c: 10.0, ro: 10.0, up: 10.0 });
    const out = simulateTradeCore(bandLockInput(d, 99.0));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('limit_up');
  });

  it('入场停牌 → filtered suspended', () => {
    const d = days({}); // 全 None
    const out = simulateTradeCore(bandLockInput(d, 99.0));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('suspended');
  });

  // 次新过滤沿用现有口径（在 decideBandLock 之前）
  it('次新 daysSinceList<60 → filtered new_listing', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const out = simulateTradeCore(bandLockInput(d, 10.0, { daysSinceList: 59 }));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('new_listing');
  });

  // 窗口耗尽 → insufficient_data
  it('S12 端到端 窗口耗尽：filtered insufficient_data', () => {
    const d = days(
      { o: 10.0, h: 10.2, low: 9.95, c: 10.1 },
      { o: 10.1, h: 10.3, low: 10.05, c: 10.2 },
    );
    const out = simulateTradeCore(bandLockInput(d, 999.0));
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('insufficient_data');
  });

  // signalHigh 缺失 → insufficient_data（不静默当 0/Infinity）
  it('signalHigh 缺失 → filtered insufficient_data', () => {
    const d = days(
      { o: 10.0, h: 10.3, low: 9.8, c: 10.2 },
      { o: 10.4, h: 10.6, low: 10.5, c: 10.5 },
      { o: 10.45, h: 10.5, low: 10.4, c: 10.42 },
    );
    const out = simulateTradeCore({
      tsCode: '000001.SZ',
      signalDate: '20260101',
      days: d,
      daysSinceList: 999,
      delistDate: null,
      exit: { mode: 'trailing_lock' },
      // signalHigh 缺失
    });
    expect(out.kind).toBe('filtered');
    if (out.kind !== 'filtered') return;
    expect(out.reason).toBe('insufficient_data');
  });

  // S11 端到端 max_hold（trailing_lock 带 maxHold）
  it('S11 端到端 max_hold：exitReason=max_hold, exitPrice=11.05', () => {
    const opts: BarOpts[] = [{ o: 10.0, h: 10.2, low: 9.95, c: 10.1 }];
    for (let k = 0; k < 10; k++) {
      const px = 10.1 + 0.1 * k;
      opts.push({ o: px, h: px + 0.1, low: px, c: px + 0.05 });
    }
    const d = days(...opts);
    const out = simulateTradeCore(bandLockInput(d, 999.0, { exit: { mode: 'trailing_lock', maxHold: 10 } }));
    expect(out.kind).toBe('trade');
    if (out.kind !== 'trade') return;
    expect(out.trade.exitReason).toBe('max_hold');
    expect(out.trade.exitPrice).toBeCloseTo(11.05, 10);
    expect(out.trade.holdDays).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attachMa5（DB 层 MA5 滚动现算）：5 个非停牌交易日 qfq_close 均值，停牌不进窗口，预热不足为 null
// ─────────────────────────────────────────────────────────────────────────────
describe('attachMa5', () => {
  function q(qfqClose: number | null): WindowQuote {
    return { qfqOpen: qfqClose, qfqClose, open: qfqClose };
  }

  it('前 4 日预热不足为 null，第 5 日起为 5 日均值', () => {
    const dates = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(10)],
      ['d1', q(11)],
      ['d2', q(12)],
      ['d3', q(13)],
      ['d4', q(14)],
      ['d5', q(15)],
    ]);
    attachMa5(dates, m, 5);
    expect(m.get('d0')!.ma5).toBeNull();
    expect(m.get('d3')!.ma5).toBeNull(); // 仅 4 个 → 不足
    expect(m.get('d4')!.ma5).toBe((10 + 11 + 12 + 13 + 14) / 5); // 12
    expect(m.get('d5')!.ma5).toBe((11 + 12 + 13 + 14 + 15) / 5); // 13
  });

  it('停牌日（无 key / qfqClose=null）不进窗口、不写 ma5', () => {
    const dates = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const m = new Map<string, WindowQuote>([
      ['d0', q(10)],
      ['d1', q(11)],
      // d2 停牌：无 key
      ['d3', q(12)],
      ['d4', q(13)],
      ['d5', q(14)], // 这里才凑满 5 个非停牌日：10,11,12,13,14
      ['d6', q(15)],
    ]);
    attachMa5(dates, m, 5);
    expect(m.has('d2')).toBe(false); // 停牌日仍无 key
    expect(m.get('d4')!.ma5).toBeNull(); // 只 4 个非停牌日
    expect(m.get('d5')!.ma5).toBe((10 + 11 + 12 + 13 + 14) / 5); // 第 5 个非停牌日
    expect(m.get('d6')!.ma5).toBe((11 + 12 + 13 + 14 + 15) / 5);
  });

  it('qfqClose=null 的行视为停牌，不写 ma5', () => {
    const dates = ['d0', 'd1'];
    const m = new Map<string, WindowQuote>([
      ['d0', { qfqOpen: 10, qfqClose: null, open: 10 }],
      ['d1', q(11)],
    ]);
    attachMa5(dates, m, 5);
    expect(m.get('d0')!.ma5).toBeUndefined(); // 未写（停牌跳过）
    expect(m.get('d1')!.ma5).toBeNull(); // 只 1 个非停牌日
  });
});
