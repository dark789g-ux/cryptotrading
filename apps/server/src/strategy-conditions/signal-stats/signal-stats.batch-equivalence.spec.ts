/**
 * signal-stats.batch-equivalence.spec.ts
 *
 * 批量出场模拟 `simulateSignalsBatched` 的**特征 / 快照测试**。
 *
 * 历史背景：本文件原为「新旧路径等价测试」——同一份 fixture 同时跑批量路径
 * `simulateSignalsBatched` 与已删除的逐信号路径 `simulateSignal` 并 deep-equal。
 * 两条路径的 zero-drift 等价性已经：
 *   ① 在真实数据上确认（8000 信号 0 漂移）；
 *   ② 历史上由 old-vs-new 差分 + 变异检测（mutation testing）证明该等价测试非空洞。
 * 据此旧逐信号路径 `simulateSignal` / `SimulateSignalParams` / `fetchSymbol` 已从
 * `signal-stats.simulator.db.ts` 删除，本测试也随之去掉对旧路径的对比，转为
 * **对新批量路径单独做语义断言 + 全字段快照回归**（不再有 old 作 oracle）。
 *
 * 手法：用 Jest mock 注入假 DataSource + 假 queryBuilder，驱动新路径吃同一份 fixture：
 *   - 假 queryBuilder.buildAShareQuery 恒返回 { sql:'TRUE', params:[] }（命中与否完全由
 *     mock DataSource 按 fixture.hitDates 决定，与真实谓词无关）。
 *   - 假 DataSource.query 按 SQL 关键字分派，从 fixture 取数；**按传入的整个 dates 集合
 *     返回命中**（不自己 slice）——批量路径传 unionWindow，命中按日期独立取值，
 *     buildHoldingDays 的 idx>0 再逐信号排除各自 buyDate。
 *
 * 覆盖场景（见 fixture）：正常成交 / 停牌 suspended / 一字涨停 limit_up / 次新 new_listing /
 * insufficient_data（多形态）/ 退市强平 delist / 缺 symbol / 多信号同 tsCode /
 * 600009 同 tsCode S2-buyDate-命中（普通 strategy 用例）/ strategy 正常命中 /
 * ★ 600100 per-signal daysSinceList 次新缺口（晚信号须用自己的 buyIdx，非组内 minBuyIdx）。
 *
 * 断言三层：
 *   (a) 逐 tsCode 语义断言：每个场景显式断言新路径产物（suspended/limit_up/new_listing/
 *       delist/signal/trade/insufficient_data 等）。
 *   (b) 大混合多 tsCode 聚合（镜像 runner / E2E 验收口径：trades 排序 + filtered 按 reason
 *       计数 + 关键 exitReason 形态）。
 *   (c) 全字段快照兜底：对新路径 outcomes 按 ts_code+signalDate 排序后 toMatchSnapshot，
 *       覆盖 ret/buyDate/exitDate/exitReason/holdDays/buyPrice/exitPrice 全字段回归。
 *
 * 【覆盖分工 / 本测试**不**守 idx>0】
 *   buildHoldingDays 的 `idx > 0`（排除 buyDate 不判 exitSignalHit）这个不变量，**不在本文件守**：
 *   decideStrategy 的出场循环从 i=1 起、永不读 days[0]，故即便 days[0].exitSignalHit 被误置 true
 *   也不影响出场决策——idx>0 对**本测试的输出**是死代码，删它本测试照样全绿。
 *   idx>0 的真正护门在 `signal-stats.simulator.spec.ts` 的 `buildHoldingDays` 纯函数单测
 *   （直接断言 days[0].exitSignalHit===false，删 idx>0 会让那几个用例转红）。
 *   下方 600009 场景因此**仅作普通 strategy 用例**保留，不宣称守 idx>0。
 */

import { DataSource } from 'typeorm';
import { StrategyConditionsQueryBuilder } from '../strategy-conditions.query-builder';
import { SignalStatsSimulator } from './signal-stats.simulator.db';
import { ExitConfig, SimulationOutcome } from './signal-stats.simulator';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture：自造一段连续 SSE 交易日 + 各 tsCode 的 quote/limit/hit/symbol 数据
// ─────────────────────────────────────────────────────────────────────────────

/** 模拟 pg numeric（返回 string）；null 透传。 */
type NumStr = string | null;

interface QuoteRow {
  qfqOpen: NumStr;
  qfqClose: NumStr;
  open: NumStr;
}

interface SymbolRow {
  listDate: string | null;
  delistDate: string | null;
}

interface Fixture {
  /** 升序 SSE 交易日（YYYYMMDD）。 */
  sseCalendar: string[];
  /** date_end。 */
  dateEnd: string;
  /** 每个 tsCode 的逐日 quote（key=tradeDate）。停牌日不放 key。 */
  quotes: Record<string, Record<string, QuoteRow>>;
  /** 每个 tsCode 的逐日 up_limit（key=tradeDate）。 */
  limits: Record<string, Record<string, NumStr>>;
  /** 每个 tsCode 的命中卖出条件交易日集合（strategy 模式用）。 */
  hitDates: Record<string, Set<string>>;
  /** a_share_symbols；缺 key = 该 tsCode 无行。 */
  symbols: Record<string, SymbolRow>;
}

/**
 * 生成 N 个连续“交易日”。这里只需字面递增、可比较即可（mock 不读真实日历语义），
 * 用 20260000 + 顺序号偏移避免与真实日期混淆但保持 YYYYMMDD 形态可比。
 *
 * 取自 20260105 起，每“日”+1（跳过周末不需要——mock 把日历当 SSE 日历整体用，
 * 索引步进即可）；为避免月份溢出，直接用月内连续 + 跨月手工铺。简单起见用 200 个
 * 连续序号映射成严格递增的 YYYYMMDD 字符串。
 */
function makeCalendar(count: number): string[] {
  const out: string[] = [];
  let y = 2026;
  let m = 1;
  let d = 5;
  for (let i = 0; i < count; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`);
    d++;
    if (d > 28) {
      d = 1;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

/** 全局日历：80 个交易日，足够覆盖次新（>=60 间隔）与正常持有窗口。 */
const CAL = makeCalendar(80);
const DATE_END = CAL[79];

/** 便捷取日历日（索引）。 */
const D = (i: number): string => CAL[i];

/**
 * 构造 fixture。各 tsCode 场景：
 *
 *  600000.SH 正常成交（fixed_n）：buyDate 起逐日有 quote。
 *  600001.SH 停牌：buyDate 无 quote → suspended。
 *  600002.SH 一字涨停：buyDate rawOpen>=upLimit → limit_up。
 *  600003.SH 次新：list_date 距 buyDate < 60 交易日 → new_listing。
 *  600004.SH insufficient_data：signalDate 不在日历。
 *  600005.SH insufficient_data：buyDate > dateEnd（signalDate = 倒数第一日）。
 *  600006.SH 退市强平：delist_date 落在持有窗口内 → delist。
 *  600007.SH 缺 symbol：不在 symbols → daysSinceList null、delistDate null，正常成交。
 *  600008.SH 多信号同 tsCode：两个不同 signalDate（触发 unionWindow 并集）。
 *  600009.SH 同 tsCode S2-buyDate-命中（普通 strategy 等价用例；**不**守 idx>0，见文件头分工）。
 *  600010.SH strategy 正常命中：中段某日命中卖出条件 → exitReason 'signal'。
 *  600011.SH strategy max_hold：无命中 → 满 maxHold 强平。
 *  600100.SH ★ per-signal daysSinceList 次新缺口：同 tsCode S1(buyIdx21,次新) + S2(buyIdx61,成交)，
 *            晚信号 daysSinceList 须用各自 buyIdx；新路径误用 minBuyIdx 会把 S2 误判次新 → diff。
 */
function makeFixture(): Fixture {
  const quotes: Fixture['quotes'] = {};
  const limits: Fixture['limits'] = {};
  const hitDates: Fixture['hitDates'] = {};
  const symbols: Fixture['symbols'] = {};

  // 工具：给某 tsCode 在 [fromIdx, toIdx] 闭区间逐日铺正常 quote（价格随日递增便于区分）。
  const fillQuotes = (
    ts: string,
    fromIdx: number,
    toIdx: number,
    base = 10,
  ): void => {
    quotes[ts] = quotes[ts] ?? {};
    limits[ts] = limits[ts] ?? {};
    for (let i = fromIdx; i <= toIdx; i++) {
      const px = base + i * 0.1;
      quotes[ts][D(i)] = {
        qfqOpen: px.toFixed(4),
        qfqClose: (px + 0.05).toFixed(4),
        open: px.toFixed(4),
      };
      // up_limit 远高于 open → 默认不触发涨停。
      limits[ts][D(i)] = (px * 2).toFixed(4);
    }
  };

  // 600000.SH 正常成交：信号日 idx20 → buyDate idx21；铺到末尾。
  // list_date=null → daysSinceList=null → 不按次新剔除（buyIdx=21 无法凑出 >=60 间隔）。
  fillQuotes('600000.SH', 21, 79);
  symbols['600000.SH'] = { listDate: null, delistDate: null };

  // 600001.SH 停牌：buyDate(idx21) 无 quote；其余有也无所谓（出场前已被 suspended 拦）。
  fillQuotes('600001.SH', 22, 79);
  symbols['600001.SH'] = { listDate: D(0), delistDate: null };
  // 删除 buyDate(idx21) → 停牌。
  delete quotes['600001.SH'][D(21)];

  // 600002.SH 一字涨停：buyDate(idx21) rawOpen>=upLimit。list_date=null（不按次新剔除）。
  fillQuotes('600002.SH', 21, 79);
  symbols['600002.SH'] = { listDate: null, delistDate: null };
  // 把 buyDate 的 open 顶到 up_limit。
  {
    const ul = '100.0000';
    limits['600002.SH'][D(21)] = ul;
    quotes['600002.SH'][D(21)] = { qfqOpen: '50.0000', qfqClose: '50.5000', open: ul };
  }

  // 600003.SH 次新：buyDate idx21，list_date=D(0) → daysSinceList=21-0=21<60 → new_listing。
  fillQuotes('600003.SH', 21, 79);
  symbols['600003.SH'] = { listDate: D(0), delistDate: null }; // 次新（daysSinceList=21<60）

  // 600004.SH insufficient_data：signalDate 不在日历（用一个日历外的串）。
  fillQuotes('600004.SH', 21, 79);
  symbols['600004.SH'] = { listDate: null, delistDate: null };

  // 600005.SH insufficient_data：signalDate=倒数第一日 → buyDate 越界 / > dateEnd。
  fillQuotes('600005.SH', 0, 79);
  symbols['600005.SH'] = { listDate: null, delistDate: null };

  // 600006.SH 退市强平：buyDate idx21，delist_date=idx23 落在持有窗口内。
  //   需 horizonN/maxHold >= 2 才能在凑满前先撞退市（fixed_n=3 / strategy=5 均满足）；
  //   fixed_n=1 会先 max_hold 出场（idx22）——这正是两路径都该一致的合法行为。
  fillQuotes('600006.SH', 21, 79);
  symbols['600006.SH'] = { listDate: null, delistDate: D(23) };

  // 600007.SH 缺 symbol：不放进 symbols；正常成交。
  fillQuotes('600007.SH', 21, 79);

  // 600008.SH 多信号同 tsCode：S1 signalDate=idx20(buy21)、S2 signalDate=idx40(buy41)。
  // 全程铺 quote → 两个信号都正常成交，但 unionWindow=slice(21) 覆盖两窗。
  fillQuotes('600008.SH', 21, 79);
  symbols['600008.SH'] = { listDate: null, delistDate: null };

  // 600009.SH 同 tsCode S2-buyDate-命中（普通 strategy 等价用例 —— **不**守 idx>0，见文件头分工）：
  //   S1 signalDate=idx20 → buyDate idx21；S2 signalDate=idx40 → buyDate idx41。
  //   S2 的 buyDate(idx41) 也置为命中日：unionWindow=slice(21) 让新路径把 idx41 纳入 hitSet，
  //   但 buildHoldingDays 的 idx>0 排除各信号自己的 days[0] → 两路径 days[] 仍 byte-identical。
  //   注意：decideStrategy 出场循环从 i=1 起、永不读 days[0]，故 idx>0 对**本等价测试的输出**
  //   是死代码——删 idx>0 本场景照样绿。idx>0 的真护门在 simulator.spec.ts 的 buildHoldingDays
  //   纯函数单测（断言 days[0].exitSignalHit===false）。本场景仅作普通 strategy 等价用例。
  //   另给 S1 中段命中日（idx30）、S2 真正命中日（idx45，>buyDate）确保两信号各走 'signal' 出场。
  fillQuotes('600009.SH', 21, 79);
  symbols['600009.SH'] = { listDate: null, delistDate: null };
  hitDates['600009.SH'] = new Set([D(30), D(41), D(45)]);

  // 600010.SH strategy 正常命中：buyDate idx21，命中日 idx25 → exitReason 'signal'。
  fillQuotes('600010.SH', 21, 79);
  symbols['600010.SH'] = { listDate: null, delistDate: null };
  hitDates['600010.SH'] = new Set([D(25)]);

  // 600011.SH strategy max_hold（未命中，窗口足够）：无命中 → 满 maxHold 强平。
  fillQuotes('600011.SH', 21, 79);
  symbols['600011.SH'] = { listDate: null, delistDate: null };
  hitDates['600011.SH'] = new Set(); // 永不命中

  // 600100.SH ★ 次新 per-signal daysSinceList 缺口守门（同 tsCode 两信号、非空 list_date）：
  //   list_date=D(0) → effListIdx=0。daysSinceList 必须用**各信号自己的 buyIdx**：
  //     S1 signalDate=idx20 → buyIdx=21 → daysSinceList=21-0=21 < 60 → filtered new_listing。
  //     S2 signalDate=idx60 → buyIdx=61 → daysSinceList=61-0=61 >= 60 → 正常成交（trade）。
  //   正确 per-signal 实现下 S1=new_listing、S2=trade，新旧路径一致（绿）。
  //   若新路径 simulateSignalsBatched 误用 minBuyIdx（=min(21,61)=21）算 daysSinceList：
  //     S2 会被当 21<60 → 误判 new_listing → 新≠旧（红）。这是本场景守的真缺口。
  //   全程铺 quote（idx21..79 覆盖 S1 buyDate=idx21 与 S2 持有窗口 idx61..），让 S2 能正常出场。
  fillQuotes('600100.SH', 21, 79);
  symbols['600100.SH'] = { listDate: D(0), delistDate: null };

  return { sseCalendar: CAL, dateEnd: DATE_END, quotes, limits, hitDates, symbols };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock 工厂：DataSource.query 按 SQL 关键字分派，从 fixture 取数
// ─────────────────────────────────────────────────────────────────────────────

function makeMockDataSource(fx: Fixture): DataSource {
  const query = jest.fn(async (sql: string, params: unknown[]): Promise<unknown[]> => {
    // ── raw.daily_indicator（fetchExitSignalHits）→ [{tradeDate}] ──
    //    ★ 必须最先分派：该 SQL 同时含 `raw.daily_quote`（LEFT JOIN），若先匹配 daily_quote
    //    分支会错返 quote 行（tradeDate=undefined）→ hitSet 全空 → strategy 永不 'signal'。
    //    tsCode=params[len-2]、dates=params[len-1]；按传入的整个 dates 返回命中（不自己 slice）。
    if (sql.includes('raw.daily_indicator')) {
      const tsCode = params[params.length - 2] as string;
      const dates = params[params.length - 1] as string[];
      const hits = fx.hitDates[tsCode] ?? new Set<string>();
      const out: Array<Record<string, string>> = [];
      for (const d of dates) {
        if (hits.has(d)) out.push({ tradeDate: d });
      }
      return out;
    }

    // ── raw.daily_quote → [{trade_date, qfq_open, qfq_close, open}] ──
    if (sql.includes('raw.daily_quote')) {
      const tsCode = params[0] as string;
      const dates = params[1] as string[];
      const byDate = fx.quotes[tsCode] ?? {};
      const out: Array<Record<string, NumStr>> = [];
      for (const d of dates) {
        const q = byDate[d];
        if (!q) continue; // 停牌日：无行
        out.push({
          trade_date: d,
          qfq_open: q.qfqOpen,
          qfq_close: q.qfqClose,
          open: q.open,
        });
      }
      return out;
    }

    // ── raw.stk_limit → [{trade_date, up_limit}] ──
    if (sql.includes('raw.stk_limit')) {
      const tsCode = params[0] as string;
      const dates = params[1] as string[];
      const byDate = fx.limits[tsCode] ?? {};
      const out: Array<Record<string, NumStr>> = [];
      for (const d of dates) {
        if (!(d in byDate)) continue;
        out.push({ trade_date: d, up_limit: byDate[d] });
      }
      return out;
    }

    // ── a_share_symbols 批量（含 ANY）→ [{ts_code, list_date, delist_date}] ──
    if (sql.includes('a_share_symbols') && sql.includes('ANY')) {
      const tsCodes = params[0] as string[];
      const out: Array<Record<string, string | null>> = [];
      for (const ts of tsCodes) {
        const s = fx.symbols[ts];
        if (!s) continue; // 缺行：不返回
        out.push({ ts_code: ts, list_date: s.listDate, delist_date: s.delistDate });
      }
      return out;
    }

    // ── a_share_symbols 单条（= $1）→ [{list_date, delist_date}] | [] ──
    if (sql.includes('a_share_symbols')) {
      const tsCode = params[0] as string;
      const s = fx.symbols[tsCode];
      if (!s) return [];
      return [{ list_date: s.listDate, delist_date: s.delistDate }];
    }

    throw new Error(`unexpected SQL in mock: ${sql.slice(0, 80)}`);
  });

  return { query } as unknown as DataSource;
}

function makeMockQueryBuilder(): StrategyConditionsQueryBuilder {
  return {
    buildAShareQuery: jest.fn(() => ({ sql: 'TRUE', params: [] })),
  } as unknown as StrategyConditionsQueryBuilder;
}

function makeSimulator(fx: Fixture): SignalStatsSimulator {
  return new SignalStatsSimulator(makeMockDataSource(fx), makeMockQueryBuilder());
}

// ─────────────────────────────────────────────────────────────────────────────
// 信号清单（tsCode + signalDate），与场景一一对应
// ─────────────────────────────────────────────────────────────────────────────

interface Sig {
  tsCode: string;
  signalDate: string;
}

/** 全部场景信号（含日历外 signalDate 触发 insufficient_data）。 */
function allSignals(): Sig[] {
  return [
    { tsCode: '600000.SH', signalDate: D(20) }, // 正常成交
    { tsCode: '600001.SH', signalDate: D(20) }, // 停牌
    { tsCode: '600002.SH', signalDate: D(20) }, // 一字涨停
    { tsCode: '600003.SH', signalDate: D(20) }, // 次新
    { tsCode: '600004.SH', signalDate: '20991231' }, // signalDate 不在日历 → insufficient
    { tsCode: '600005.SH', signalDate: D(79) }, // signalDate=末日 → buyDate 越界 → insufficient
    { tsCode: '600006.SH', signalDate: D(20) }, // 退市强平
    { tsCode: '600007.SH', signalDate: D(20) }, // 缺 symbol
    { tsCode: '600008.SH', signalDate: D(20) }, // 多信号 S1
    { tsCode: '600008.SH', signalDate: D(40) }, // 多信号 S2
    { tsCode: '600009.SH', signalDate: D(20) }, // 同 tsCode S2-buyDate-命中 S1（普通 strategy 等价用例）
    { tsCode: '600009.SH', signalDate: D(40) }, // 同 tsCode S2（buyDate=idx41 是命中日；不守 idx>0）
    { tsCode: '600010.SH', signalDate: D(20) }, // strategy 正常命中
    { tsCode: '600011.SH', signalDate: D(20) }, // strategy max_hold
    { tsCode: '600100.SH', signalDate: D(20) }, // ★ per-signal 次新 S1：buyIdx=21 距 list<60 → new_listing
    { tsCode: '600100.SH', signalDate: D(60) }, // ★ per-signal 次新 S2：buyIdx=61 距 list>=60 → trade
  ];
}

/** 把信号按 tsCode 分组（保组内输入顺序）。 */
function groupByTsCode(signals: Sig[]): Map<string, Sig[]> {
  const m = new Map<string, Sig[]>();
  for (const s of signals) {
    const arr = m.get(s.tsCode);
    if (arr) arr.push(s);
    else m.set(s.tsCode, [s]);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 跑新批量路径的 helper
// ─────────────────────────────────────────────────────────────────────────────

async function runPath(
  sim: SignalStatsSimulator,
  fx: Fixture,
  signals: Sig[],
  exit: ExitConfig,
  exitConditions: unknown,
): Promise<SimulationOutcome[]> {
  return sim.simulateSignalsBatched({
    signals,
    exit,
    exitConditions: exitConditions as any,
    sseCalendar: fx.sseCalendar,
    dateEnd: fx.dateEnd,
  });
}

/**
 * 全字段快照视图：按 ts_code 逐组跑批量路径（组内 outcome 与组内输入信号一一对应、保序），
 * 把每个 outcome 配上其 signal，最后按 (ts_code, signal_date) 稳定排序得确定性快照。
 *
 * 不直接 zip 全量 `simulateSignalsBatched(allSignals)` 的输出——其组间顺序不保证与全局
 * 输入一致（按 ts_code 分组后 flat），index 对齐会脆。逐组跑则组内顺序确定，映射可靠。
 */
async function snapshotView(
  sim: SignalStatsSimulator,
  fx: Fixture,
  signals: Sig[],
  exit: ExitConfig,
  exitConditions: unknown,
): Promise<Array<{ tsCode: string; signalDate: string; outcome: SimulationOutcome }>> {
  const groups = groupByTsCode(signals);
  const rows: Array<{ tsCode: string; signalDate: string; outcome: SimulationOutcome }> = [];
  for (const [, groupSignals] of groups.entries()) {
    const outcomes = await runPath(sim, fx, groupSignals, exit, exitConditions);
    for (let i = 0; i < groupSignals.length; i++) {
      rows.push({
        tsCode: groupSignals[i].tsCode,
        signalDate: groupSignals[i].signalDate,
        outcome: outcomes[i],
      });
    }
  }
  return rows.sort((a, b) =>
    a.tsCode === b.tsCode
      ? a.signalDate.localeCompare(b.signalDate)
      : a.tsCode.localeCompare(b.tsCode),
  );
}

/** 聚合提取：trades（排序）+ filtered reason 计数。 */
function aggregate(outcomes: SimulationOutcome[]) {
  const trades = outcomes
    .filter((o): o is Extract<SimulationOutcome, { kind: 'trade' }> => o.kind === 'trade')
    .map((o) => o.trade)
    .sort((a, b) =>
      a.tsCode === b.tsCode
        ? a.signalDate.localeCompare(b.signalDate)
        : a.tsCode.localeCompare(b.tsCode),
    );
  const filteredCounts: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.kind === 'filtered') {
      filteredCounts[o.reason] = (filteredCounts[o.reason] ?? 0) + 1;
    }
  }
  return { trades, filteredCounts };
}

// 两种 exit 模式 × （fixed_n 多个 horizon）。strategy 用非空占位 exitConditions（queryBuilder 被 mock）。
const EXIT_FIXED_1: ExitConfig = { mode: 'fixed_n', horizonN: 1 };
const EXIT_FIXED_3: ExitConfig = { mode: 'fixed_n', horizonN: 3 };
const EXIT_STRATEGY_5: ExitConfig = { mode: 'strategy', maxHold: 5 };
const EXIT_CONDS_PLACEHOLDER = [
  { field: 'macd_hist', operator: 'lt', value: 0 },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 测试套件
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalStatsSimulator batch path feature & snapshot', () => {
  const modes: Array<{ name: string; exit: ExitConfig; conds: unknown }> = [
    { name: 'fixed_n horizonN=1', exit: EXIT_FIXED_1, conds: null },
    { name: 'fixed_n horizonN=3', exit: EXIT_FIXED_3, conds: null },
    { name: 'strategy maxHold=5', exit: EXIT_STRATEGY_5, conds: EXIT_CONDS_PLACEHOLDER },
  ];

  // ── (a) 全字段快照兜底：逐 tsCode 跑批量路径 → 排序后 toMatchSnapshot ──
  //    覆盖每个 outcome 的 ret/buyDate/exitDate/exitReason/holdDays/buyPrice/exitPrice 全字段回归。
  describe('(a) full-field snapshot of batch outcomes', () => {
    for (const m of modes) {
      it(`${m.name}: sorted outcomes match snapshot`, async () => {
        const fx = makeFixture();
        const sim = makeSimulator(fx);
        const view = await snapshotView(sim, fx, allSignals(), m.exit, m.conds);
        expect(view).toMatchSnapshot();
      });
    }
  });

  // ── (b) 大混合多 tsCode 聚合（镜像 runner / E2E 验收口径：trades 排序 + filtered 计数） ──
  describe('(b) big-mixed multi-tsCode aggregate', () => {
    for (const m of modes) {
      it(`${m.name}: trades sorted + filtered counts match snapshot`, async () => {
        const fx = makeFixture();
        const sim = makeSimulator(fx);
        const outcomes = await runPath(sim, fx, allSignals(), m.exit, m.conds);
        const { trades, filteredCounts } = aggregate(outcomes);
        expect({ trades, filteredCounts }).toMatchSnapshot();
      });
    }
  });

  // ── (c) 语义断言：新路径每类场景产物显式断言（可读的正确性核心，不依赖 oracle） ──
  describe('(c) scenario semantics on batch path', () => {
    it('fixed_n covers trade + suspended + limit_up + new_listing + insufficient + delist', async () => {
      const fx = makeFixture();
      const sim = makeSimulator(fx);
      const outcomes = await runPath(sim, fx, allSignals(), EXIT_FIXED_3, null);
      const { trades, filteredCounts } = aggregate(outcomes);

      expect(trades.length).toBeGreaterThan(0);
      expect(filteredCounts['suspended']).toBeGreaterThanOrEqual(1);
      expect(filteredCounts['limit_up']).toBeGreaterThanOrEqual(1);
      expect(filteredCounts['new_listing']).toBeGreaterThanOrEqual(1);
      expect(filteredCounts['insufficient_data']).toBeGreaterThanOrEqual(2);
      // 退市强平：600006 应产出一条 exitReason='delist' 的 trade。
      expect(trades.some((t) => t.exitReason === 'delist')).toBe(true);

      // ★ per-signal 次新缺口：600100 同 tsCode 两信号必须**一新一成**——
      //   S1(buyIdx=21,距 list 21<60) filtered new_listing、S2(buyIdx=61,距 list 61>=60) trade。
      //   新路径 daysSinceList 必须 per-signal（用各自 buyIdx，非组内 minBuyIdx），否则 S2 误判次新。
      const s600100 = await snapshotView(
        sim,
        fx,
        [
          { tsCode: '600100.SH', signalDate: D(20) },
          { tsCode: '600100.SH', signalDate: D(60) },
        ],
        EXIT_FIXED_3,
        null,
      );
      const s100Trades = s600100.filter((r) => r.outcome.kind === 'trade');
      const s100NewListing = s600100.filter(
        (r) => r.outcome.kind === 'filtered' && r.outcome.reason === 'new_listing',
      );
      expect(s100Trades).toHaveLength(1); // 仅 S2 成交
      const s2Out = s100Trades[0].outcome;
      if (s2Out.kind === 'trade') expect(s2Out.trade.buyDate).toBe(D(61)); // S2 buyDate=idx61
      expect(s100NewListing).toHaveLength(1); // 仅 S1 被次新剔除
    });

    it('strategy covers signal exit + max_hold + delist + same-tsCode S2-buyDate-hit signals', async () => {
      const fx = makeFixture();
      const sim = makeSimulator(fx);
      const outcomes = await runPath(
        sim,
        fx,
        allSignals(),
        EXIT_STRATEGY_5,
        EXIT_CONDS_PLACEHOLDER,
      );
      const { trades } = aggregate(outcomes);

      // strategy 正常命中 600010 → exitReason='signal'。
      expect(
        trades.some((t) => t.tsCode === '600010.SH' && t.exitReason === 'signal'),
      ).toBe(true);
      // 未命中 600011 → max_hold。
      expect(
        trades.some((t) => t.tsCode === '600011.SH' && t.exitReason === 'max_hold'),
      ).toBe(true);
      // 退市 600006 → delist（strategy 路径同样退市优先）。
      expect(
        trades.some((t) => t.tsCode === '600006.SH' && t.exitReason === 'delist'),
      ).toBe(true);
      // 600009 同 tsCode S2-buyDate-命中：至少有一条成交 outcome（专项断言见下方 describe）。
      expect(trades.filter((t) => t.tsCode === '600009.SH').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 同 tsCode S2-buyDate-命中专项（普通 strategy 用例）──
  //    注意：这**不**守 idx>0（见文件头分工）。decideStrategy 出场循环从 i=1 起、永不读 days[0]，
  //    故 S2 自己窗口的 days[0]=buyDate 是否被判命中对出场决策无影响——删 idx>0 本用例照样绿。
  //    idx>0 的真护门在 signal-stats.simulator.spec.ts 的 buildHoldingDays 纯函数单测。
  //    本用例验证 unionWindow 把 S2 buyDate 纳入 hitSet 时，S2 仍在下一命中日出场而非自己 buyDate。
  describe('same tsCode, S2 buyDate is a hit date (strategy)', () => {
    it('600009 S2 exits at next hit (idx45), not its own buyDate (idx41)', async () => {
      const fx = makeFixture();
      // 前置确认：S2 的 buyDate=idx41 确实在 fixture 命中集里（unionWindow 会纳入它）。
      expect(fx.hitDates['600009.SH'].has(D(41))).toBe(true);

      const sim = makeSimulator(fx);
      const s2Group: Sig[] = [
        { tsCode: '600009.SH', signalDate: D(20) }, // S1
        { tsCode: '600009.SH', signalDate: D(40) }, // S2，buyDate=idx41=命中日
      ];

      const outcomes = await runPath(
        sim,
        fx,
        s2Group,
        EXIT_STRATEGY_5,
        EXIT_CONDS_PLACEHOLDER,
      );

      // S2 不应在其 buyDate(idx41) 当天 'signal' 出场——decideStrategy 出场循环从 i=1 起、
      // 永不读 days[0]，故 buyDate 当天不判（这才是真正阻止 idx41 出场的机制，**非** idx>0）。
      // S2 的下一个命中日是 idx45 → S2 exitDate 应为 idx45 而非 idx41。
      const s2 = outcomes[1];
      expect(s2.kind).toBe('trade');
      if (s2.kind === 'trade') {
        expect(s2.trade.buyDate).toBe(D(41));
        expect(s2.trade.exitDate).not.toBe(D(41)); // 绝不在 buyDate 当天出场
        expect(s2.trade.exitDate).toBe(D(45)); // 命中日 idx45
        expect(s2.trade.exitReason).toBe('signal');
      }
    });
  });

  // ── ★ per-signal daysSinceList 陷阱专项：晚信号 daysSinceList 须用自己的 buyIdx，非 minBuyIdx ──
  //    守的真缺口：新路径 simulateSignalsBatched 的 daysSinceList=buyIdx-effListIdx 必须 per-signal。
  //    若误用组内最早 minBuyIdx，晚信号 S2 会被算成与早信号一样小的 daysSinceList → 误判次新。
  describe('★ per-signal new_listing trap: late signal uses own buyIdx, not minBuyIdx', () => {
    it('600100 S1(new_listing)+S2(trade); batch path must use S2 own buyIdx for daysSinceList', async () => {
      const fx = makeFixture();
      // 前置：list_date=D(0)（effListIdx=0），同 tsCode 两信号 buyIdx 分别 21 / 61。
      expect(fx.symbols['600100.SH'].listDate).toBe(D(0));

      const sim = makeSimulator(fx);
      const group: Sig[] = [
        { tsCode: '600100.SH', signalDate: D(20) }, // S1 buyIdx=21，距 list 21<60 → new_listing
        { tsCode: '600100.SH', signalDate: D(60) }, // S2 buyIdx=61，距 list 61>=60 → trade
      ];

      // fixed_n（次新过滤在入场阶段，与 fixed_n/strategy 无关，用 fixed_n 最直接）。
      const outcomes = await runPath(sim, fx, group, EXIT_FIXED_3, null);

      // 灵魂断言：S1 被次新剔除、S2 正常成交且 buyDate=idx61。
      //   守的真缺口：daysSinceList 必须 per-signal——误用组内 minBuyIdx(=21) 时 S2 会被算成
      //   21<60 → 误判 new_listing，此断言转红。
      const s1 = outcomes[0];
      const s2 = outcomes[1];
      expect(s1.kind).toBe('filtered');
      if (s1.kind === 'filtered') expect(s1.reason).toBe('new_listing');
      expect(s2.kind).toBe('trade');
      if (s2.kind === 'trade') expect(s2.trade.buyDate).toBe(D(61));
    });
  });

  // ── 多信号同 tsCode：unionWindow 并集逻辑不破坏单信号语义 ──
  //    两信号各自 buyDate（S1=idx21、S2=idx41）必须各按自己的窗口成交，unionWindow=slice(21)
  //    覆盖两窗但 per-signal 切窗后互不污染。
  describe('multi-signal same tsCode (unionWindow)', () => {
    it('600008 S1+S2 each trades with its own buyDate under all exit modes', async () => {
      const group: Sig[] = [
        { tsCode: '600008.SH', signalDate: D(20) }, // S1 → buyDate idx21
        { tsCode: '600008.SH', signalDate: D(40) }, // S2 → buyDate idx41
      ];
      for (const m of [
        { exit: EXIT_FIXED_1, conds: null },
        { exit: EXIT_FIXED_3, conds: null },
        { exit: EXIT_STRATEGY_5, conds: EXIT_CONDS_PLACEHOLDER },
      ]) {
        const fx = makeFixture();
        const sim = makeSimulator(fx);
        const outcomes = await runPath(sim, fx, group, m.exit, m.conds);

        expect(outcomes).toHaveLength(2);
        const s1 = outcomes[0];
        const s2 = outcomes[1];
        expect(s1.kind).toBe('trade');
        if (s1.kind === 'trade') expect(s1.trade.buyDate).toBe(D(21));
        expect(s2.kind).toBe('trade');
        if (s2.kind === 'trade') expect(s2.trade.buyDate).toBe(D(41));
      }
    });
  });
});
