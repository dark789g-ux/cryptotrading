/**
 * portfolio-sim.engine.ts
 *
 * 组合级模拟器逐日回放引擎（纯函数，不依赖 DB / NestJS）。
 *
 * 消费既有 A 股信号回测 run 的逐笔交易（每笔含 ret），在共享资金池、仓位约束、
 * 交易成本下做逐日组合回放：输入=内存数据，输出=每日净值 + 逐信号判定 + 汇总指标。
 *
 * 逐日循环顺序（02 引擎设计，严格遵循）：① 出场 → ② 开仓 → ③ 盯市 → ④ 记录。
 *   - 出场毛回款 = alloc × (1 + ret)：ret 用记录值，盯市路径不影响总收益（构造性恒等）。
 *   - 开仓 alloc = positionRatio × NAV_ref(d)；NAV_ref(d) = 上一交易日收盘 NAV（首日 = initialCapital）。
 *   - 盯市 mv *= close(d)/上一盯市价（入场首日 = close(d)/open(d)）；停牌（无行情）mv 不变。
 *
 * anchorMode：资金无限 + 无成本——全部约束停用（maxPositions/exposureCap 视为 null、
 *   already_held 停用、cash_short 旁路、费率全 0），现金允许变负；此时每笔信号必 taken 且
 *   realizedRetNet ≡ ret（代数恒等，测试守住）。组合现金/净值指标无意义，仅用于逐笔对账。
 *
 * 汇总指标公式见 §汇总 与 02 引擎设计。
 */

import { calcSignalStats } from '../signal-stats/signal-stats.metrics';
import { buyRate, sellRate } from './portfolio-sim.cost';
import {
  CooldownState,
  initCooldown,
  isInCooldown,
  registerExit,
  updateDrawdownHalt,
} from './portfolio-sim.cooldown';
import { rankAndScore } from './portfolio-sim.ranking';
import {
  computeAlloc,
  computeSourceKellyMult,
  MIN_ALLOC_YUAN,
} from './portfolio-sim.sizing';
import {
  CircuitBreaker,
  EngineDailyRow,
  EngineFill,
  EngineInput,
  EngineResult,
  EngineSummary,
  EngineTrade,
  PortfolioSimCostRates,
  PortfolioSimSource,
  SkipReason,
} from './portfolio-sim.types';

/** 年化交易日数（A 股约定）。 */
export const TRADING_DAYS_PER_YEAR = 244;

// ─────────────────────────────────────────────────────────────────────────────
// 内部状态
// ─────────────────────────────────────────────────────────────────────────────

/** 在仓持仓（引擎内部状态，不外露）。 */
interface OpenPosition {
  sourceIdx: number;
  tsCode: string;
  exitDate: string;
  ret: number;
  /** 入场金额（= positionRatio × NAV_ref(buyDate)）。 */
  alloc: number;
  /** 买费绝对额（= alloc × 买入费率）。 */
  buyCost: number;
  /** 当前盯市市值。开仓时 = alloc。 */
  mv: number;
  /**
   * 上一盯市价（盯市分母）。入场首日 = open(buyDate)；之后 = 上一个有行情日的 close。
   * 停牌日不更新（下一个有行情日仍以最后一次 close 作分母）。
   */
  lastMarkPrice: number;
  /** 该笔对应的 fill（最终回填 realizedRetNet / costsPaid）。 */
  fill: EngineFill;
}

// ─────────────────────────────────────────────────────────────────────────────
// 排序：同日同策略候选优先级
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 同日同策略候选排序：
 *   - 有 rankValue 的排在缺失（null）项之前。
 *   - 有 rankValue 的之间按 rankDir（asc/desc）排序；平局按 ts_code 升序。
 *   - 缺失项之间按 ts_code 升序。
 *   - rankField='none' 视为全部缺失 → 纯按 ts_code 升序。
 */
export function sortCandidates(
  trades: EngineTrade[],
  source: PortfolioSimSource,
): EngineTrade[] {
  const useRank = source.rankField !== 'none';
  return [...trades].sort((a, b) => {
    const aHas = useRank && a.rankValue !== null;
    const bHas = useRank && b.rankValue !== null;
    // 有 rank 项整体排在缺失项之前。
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const cmp =
        source.rankDir === 'asc'
          ? (a.rankValue as number) - (b.rankValue as number)
          : (b.rankValue as number) - (a.rankValue as number);
      if (cmp !== 0) return cmp;
    }
    // 平局 / 同为缺失 / none：按 ts_code 升序。
    return a.tsCode < b.tsCode ? -1 : a.tsCode > b.tsCode ? 1 : 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 主引擎
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐日组合回放。
 *
 * @param input 配置 + 逐笔交易 + 行情 + 日历
 * @param onProgress 可选回放进度回调；每回放完一个交易日调一次 (doneDays, totalDays)。
 *   纯增量，不改任何既有回放逻辑（W2 runner 用于 replaying 阶段进度上报）。
 * @returns 每日净值 + 逐信号判定 + 汇总指标
 */
export function runPortfolioSim(
  input: EngineInput,
  onProgress?: (done: number, total: number) => void,
): EngineResult {
  const { config, trades, quotes, calendar } = input;
  const { initialCapital, anchorMode } = config;
  const totalDays = calendar.length;

  // anchorMode：费率全 0、全部约束停用（already_held / slots_full / exposure_cap / cash_short）。
  const costRates = anchorMode
    ? {
        commissionPerSide: 0,
        transferPerSide: 0,
        stampSellBefore20230828: 0,
        stampSellFrom20230828: 0,
        slippagePerSide: 0,
      }
    : config.cost;
  const buyFeeRate = buyRate(costRates);

  // 按 buyDate / exitDate 索引交易，避免逐日全表扫描。
  const buysByDate = groupBy(trades, (t) => t.buyDate);
  const exitsByDate = groupBy(trades, (t) => t.exitDate);

  // 在仓持仓（跨日存活）。
  const positions: OpenPosition[] = [];
  // fills 与 trades 一一对应（按输入顺序），便于消费方对齐。
  // factorValues 在此即从 trade 透传（与开仓路径解耦）——使熔断冻结被 skip 的 fill 也带此字段
  // （满足「taken/skipped 都带」承诺，见 spec 01/05）。
  const fills: EngineFill[] = trades.map((t) => ({
    sourceIdx: t.sourceIdx,
    tsCode: t.tsCode,
    signalDate: t.signalDate,
    buyDate: t.buyDate,
    status: 'skipped' as const, // 默认 skipped，开仓成功时改写
    rankValue: t.rankValue,
    factorValues: t.factorValues,
  }));
  // trade → 其 fill 的反查（同对象引用，开仓时回填）。
  const fillByTrade = new Map<EngineTrade, EngineFill>();
  trades.forEach((t, i) => fillByTrade.set(t, fills[i]));

  // ── 引擎 init：预算每 source 的 source_kelly 乘子（装载期一次，非 per-trade）。
  //    非 source_kelly 模式不预算（computeAlloc 不读 sourceKellyMult）。anchorMode 不影响预算
  //    （computeAlloc 首行短路，乘子永不被读）。
  const sourceKellyMult: number[] = config.sources.map((src, s) => {
    if (src.sizing?.mode !== 'source_kelly') return 1;
    const rets = trades.filter((t) => t.sourceIdx === s).map((t) => t.ret);
    return computeSourceKellyMult(rets, src.sizing, (msg) =>
      // eslint-disable-next-line no-console
      console.warn(`[portfolio-sim] source #${s} (${src.label}): ${msg}`),
    );
  });

  // ── 熔断状态（账户级，跨所有 source 合并）。anchorMode 下闸门永不触发。
  const cb: CircuitBreaker | undefined = config.circuitBreaker;
  const cooldown: CooldownState = initCooldown(cb?.baseCooldownDays ?? 0);
  let ddHalted = false; // 回撤熔断滞回态
  let peak = -Infinity; // NAV 峰值（用当日收盘 nav 更新）

  const dailyRows: EngineDailyRow[] = [];
  let cash = initialCapital;
  let prevNav = initialCapital; // NAV(d-1)，首日 = initialCapital
  let totalCosts = 0;
  let doneDays = 0;

  /**
   * 收口一笔持仓并采集连亏（spec 05 §recordExit）。
   * 两处 closePosition（跨日出场 + 同日 round-trip）都经此 helper，确保每笔恰一次、口径一致。
   * win 口径 = realizedRetNet > 0（净收益，含买卖成本）。
   */
  const closeAndRecord = (pos: OpenPosition, dayIdx: number): void => {
    const r = closePosition(pos, cash, costRates, pos.exitDate);
    cash = r.cash;
    totalCosts += r.addedCost;
    if (cb?.enableCooldown && !anchorMode) {
      const isWin = (pos.fill.realizedRetNet ?? 0) > 0;
      registerExit(
        cooldown,
        isWin,
        false, // isHalf 恒 false
        dayIdx,
        cb.consecutiveLossesThreshold,
        cb.maxCooldownDays,
        cb.extendOnLoss,
        cb.reduceOnProfit,
      );
    }
  };

  for (let dayIdx = 0; dayIdx < calendar.length; dayIdx++) {
    const d = calendar[dayIdx];
    const navRef = prevNav; // NAV_ref(d) = 上一交易日收盘 NAV

    // ── ① 出场：exit_date == d 的在仓持仓逐笔收口（先出场后开仓）。
    //    倒序 splice：处理次序不影响结果——每笔独立用 ret 收口、cash 累加满足交换律、fill 各自回填。
    //    closeAndRecord：收口后采集连亏（win 口径 = realizedRetNet>0 净收益）。
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i].exitDate !== d) continue;
      closeAndRecord(positions[i], dayIdx);
      positions.splice(i, 1);
    }

    // ── 开仓前账户级熔断双触发闸门（anchorMode 全跳过）。
    //    回撤判定用 prevNav（=NAV(d-1)）与历史 peak 比，无未来函数。
    const frozenCooldown =
      !anchorMode && !!cb?.enableCooldown && isInCooldown(cooldown, dayIdx);
    const ddNow = peak > 0 ? prevNav / peak - 1 : 0;
    if (cb?.enableDrawdownHalt && !anchorMode) {
      ddHalted = updateDrawdownHalt(ddHalted, ddNow, cb);
    }
    const frozenDD = !anchorMode && !!cb?.enableDrawdownHalt && ddHalted;
    const frozen = frozenCooldown || frozenDD;

    // ── ② 开仓：buy_date == d 的信号，按 source 在 config 中的顺序逐策略处理。
    const dayBuys = buysByDate.get(d) ?? [];
    for (let s = 0; s < config.sources.length; s++) {
      const source = config.sources[s];
      // rankAndScore 取代 sortCandidates：横截面 = 当日该 source 候选；冻结日仍跑（写 rankScore，透明）。
      const { sorted, scoreByTrade, qualityByTrade } = rankAndScore(
        dayBuys.filter((t) => t.sourceIdx === s),
        source,
      );
      for (const trade of sorted) {
        const fill = fillByTrade.get(trade)!;
        // 冻结日仍写 rankScore（透明），但全候选 skip（cooldown 优先于 drawdown_halt）。
        fill.rankScore = scoreByTrade.get(trade) ?? null;

        if (frozen) {
          fill.status = 'skipped';
          fill.skipReason = frozenCooldown ? 'cooldown' : 'drawdown_halt';
          continue;
        }

        // alloc 算一次，同时供 checkSkip 与开仓块（删除 checkSkip 内重复计算）。
        const alloc = computeAlloc(trade, source, navRef, {
          anchorMode,
          qualityByTrade,
          sourceKellyMult: sourceKellyMult[s],
        });

        // sized_out：仅 source_kelly mult=0（真负期望/全亏源）可达；signal_weighted mult≥floor>0 不触发。
        if (!anchorMode && alloc < MIN_ALLOC_YUAN) {
          fill.status = 'skipped';
          fill.skipReason = 'sized_out';
          fill.alloc = 0; // 可辨识，不参与持仓/盯市
          continue;
        }

        const skip = checkSkip(trade, source, positions, navRef, cash, alloc, {
          anchorMode,
          buyFeeRate,
        });
        if (skip !== null) {
          fill.status = 'skipped';
          fill.skipReason = skip;
          continue;
        }
        // 通过：开仓。
        const buyCost = alloc * buyFeeRate;
        cash -= alloc + buyCost;
        totalCosts += buyCost;

        fill.status = 'taken';
        fill.skipReason = undefined;
        fill.weightEntry = alloc / navRef; // 有效权重 = positionRatio×mult（与实际下注一致）
        fill.alloc = alloc;
        fill.exitDate = trade.exitDate;
        fill.costsPaid = buyCost; // 卖费在出场时补加

        const buyBar = quotes.get(trade.tsCode)?.get(d);
        const pos: OpenPosition = {
          sourceIdx: s,
          tsCode: trade.tsCode,
          exitDate: trade.exitDate,
          ret: trade.ret,
          alloc,
          buyCost,
          mv: alloc,
          // 入场首日盯市分母 = open(d)；停牌（无行情）→ 用 alloc 隐含价，盯市步骤会跳过。
          lastMarkPrice: buyBar ? buyBar.open : NaN,
          fill,
        };

        // 边界：exitDate == buyDate（同一日 round-trip）→ 开仓后立即收口，不参与盯市。
        //    同日 round-trip 也经 closeAndRecord 采集连亏（第二个收口点）。
        if (trade.exitDate === d) {
          closeAndRecord(pos, dayIdx);
        } else {
          positions.push(pos);
        }
      }
    }

    // ── ③ 盯市：每个在仓持仓（不含当日已出场者）。
    for (const pos of positions) {
      const bar = quotes.get(pos.tsCode)?.get(d);
      if (!bar) continue; // 停牌：mv 不变、lastMarkPrice 不更新
      if (Number.isFinite(pos.lastMarkPrice) && pos.lastMarkPrice !== 0) {
        pos.mv *= bar.close / pos.lastMarkPrice;
      }
      pos.lastMarkPrice = bar.close; // 下次盯市分母 = 今日 close
    }

    // ── ④ 记录。
    let sumMv = 0;
    const strategyMv: number[] = new Array(config.sources.length).fill(0);
    for (const pos of positions) {
      sumMv += pos.mv;
      strategyMv[pos.sourceIdx] += pos.mv;
    }
    const nav = cash + sumMv;
    const dailyRet = nav / prevNav - 1;
    const strategyExposure: Record<string, number> = {};
    for (let s = 0; s < config.sources.length; s++) {
      if (strategyMv[s] !== 0) {
        strategyExposure[config.sources[s].label] =
          nav !== 0 ? strategyMv[s] / nav : 0;
      }
    }
    dailyRows.push({
      tradeDate: d,
      nav,
      cash,
      dailyRet,
      positionCount: positions.length,
      exposure: nav !== 0 ? sumMv / nav : 0,
      strategyExposure,
    });
    prevNav = nav;
    if (nav > peak) peak = nav; // peak 用当日收盘 nav 更新（驱动次日回撤熔断判定）
    doneDays += 1;
    onProgress?.(doneDays, totalDays);
  }

  const summary = computeSummary(
    dailyRows,
    fills,
    initialCapital,
    totalCosts,
  );
  return { dailyRows, fills, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// 出场收口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 收口一笔持仓（计算毛回款 / 卖费 / 净实现收益率，回填 fill），返回新 cash 与本次新增成本。
 *
 * 毛回款 = alloc × (1 + ret)（路径无关）；卖费 = 毛回款 × 卖出费率；
 * cash += 毛回款 - 卖费；
 * realizedRetNet = (毛回款 - 卖费 - alloc - buyCost) / (alloc + buyCost)。
 *
 * 注意：本函数有副作用（写 fill），但对同一 pos 应只调用一次。
 */
function closePosition(
  pos: OpenPosition,
  cash: number,
  costRates: PortfolioSimCostRates,
  exitDate: string,
): { cash: number; addedCost: number } {
  const gross = pos.alloc * (1 + pos.ret);
  const sellFeeRate = sellRate(costRates, exitDate);
  const sellCost = gross * sellFeeRate;
  const newCash = cash + gross - sellCost;
  const investedTotal = pos.alloc + pos.buyCost;
  const realizedRetNet =
    investedTotal !== 0
      ? (gross - sellCost - pos.alloc - pos.buyCost) / investedTotal
      : 0;
  pos.fill.realizedRetNet = realizedRetNet;
  pos.fill.costsPaid = pos.buyCost + sellCost;
  return { cash: newCash, addedCost: sellCost };
}

// ─────────────────────────────────────────────────────────────────────────────
// 开仓约束检查（固定顺序，首个不满足者即 skip）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按固定顺序检查开仓约束，返回首个 skipReason 或 null（可开仓）。
 *
 * 顺序：already_held → slots_full → exposure_cap → cash_short。
 * anchorMode：全部约束停用（already_held 停用、maxPositions/exposureCap 视为 null、cash_short 旁路）。
 *   语义为「资金无限 + 无成本」，现金允许变负——锚点 run 仅用于逐笔对账，组合指标无意义。
 *
 * exposure_cap：(该策略持仓市值合计 + alloc)/NAV_ref > cap 才 skip（严格 >；恰好 == cap 放行）。
 *
 * alloc 由调用点 computeAlloc 算一次后传入（与开仓块共用同一值，避免 exposure/cash 判定与实际下注脱节）。
 */
export function checkSkip(
  trade: EngineTrade,
  source: PortfolioSimSource,
  positions: OpenPosition[],
  navRef: number,
  cash: number,
  alloc: number,
  opts: { anchorMode: boolean; buyFeeRate: number },
): SkipReason | null {
  const { anchorMode, buyFeeRate } = opts;
  const sourceIdx = trade.sourceIdx;
  const buyCost = alloc * buyFeeRate;

  // 该策略当前持仓（同 sourceIdx）。
  const ownPositions = positions.filter((p) => p.sourceIdx === sourceIdx);

  // ① already_held（anchorMode 停用）。
  if (!anchorMode) {
    if (ownPositions.some((p) => p.tsCode === trade.tsCode)) {
      return 'already_held';
    }
  }

  // ② slots_full（anchorMode 视 maxPositions=null）。
  if (!anchorMode && source.maxPositions !== null) {
    if (ownPositions.length >= source.maxPositions) {
      return 'slots_full';
    }
  }

  // ③ exposure_cap（anchorMode 视 exposureCap=null）。严格 > 才 skip。
  if (!anchorMode && source.exposureCap !== null && navRef > 0) {
    const ownMv = ownPositions.reduce((sum, p) => sum + p.mv, 0);
    const projected = (ownMv + alloc) / navRef;
    if (projected > source.exposureCap) {
      return 'exposure_cap';
    }
  }

  // ④ cash_short（anchorMode 停用：资金无限语义，现金允许变负）。
  //    非 anchorMode：现金不足整笔跳过（不部分成交）。
  if (!anchorMode && cash < alloc + buyCost) {
    return 'cash_short';
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 汇总指标
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算汇总指标。
 *
 * - totalRet = finalNav/initialCapital - 1
 * - annualRet = (1+totalRet)^(244/交易日数) - 1（finalNav<=0 → null）
 * - maxDrawdown：每日 NAV 峰值回落最大比例（负数；无回撤 0）
 * - sharpe = mean(dailyRet)/std(dailyRet) × √244（样本标准差 n-1；std=0 → null）
 * - calmar = annualRet/|maxDrawdown|（回撤 0 或 annualRet null → null）
 * - dailyWinRate/dailyKelly：dailyRet 序列喂 calcSignalStats（holdDays 全 1）取 winRate/kellyF
 * - totalCosts：全部买卖费用绝对额合计
 */
export function computeSummary(
  dailyRows: EngineDailyRow[],
  fills: EngineFill[],
  initialCapital: number,
  totalCosts: number,
): EngineSummary {
  const nDays = dailyRows.length;
  const nTaken = fills.filter((f) => f.status === 'taken').length;
  const nSkipped = fills.length - nTaken;

  const finalNav = nDays > 0 ? dailyRows[nDays - 1].nav : initialCapital;
  const totalRet = finalNav / initialCapital - 1;

  // 年化：finalNav <= 0 时无意义 → null。
  let annualRet: number | null = null;
  if (finalNav > 0 && nDays > 0) {
    annualRet =
      Math.pow(1 + totalRet, TRADING_DAYS_PER_YEAR / nDays) - 1;
  }

  // 最大回撤：扫描 NAV 峰值回落。
  let peak = -Infinity;
  let maxDrawdown = 0; // 负数；无回撤 0
  for (const row of dailyRows) {
    if (row.nav > peak) peak = row.nav;
    if (peak > 0) {
      const dd = row.nav / peak - 1; // <= 0
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
  }

  // 夏普：样本标准差（n-1）。
  const dailyRets = dailyRows.map((r) => r.dailyRet);
  let sharpe: number | null = null;
  if (dailyRets.length >= 2) {
    const mean =
      dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const variance =
      dailyRets.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      (dailyRets.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) {
      sharpe = (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }
  }

  // 卡玛：回撤为 0 或 annualRet null → null。
  const calmar =
    annualRet !== null && maxDrawdown < 0
      ? annualRet / Math.abs(maxDrawdown)
      : null;

  // 日胜率 / 日凯利：喂 calcSignalStats（holdDays 全 1）。
  const stats = calcSignalStats(dailyRets, dailyRets.map(() => 1));

  return {
    finalNav,
    totalRet,
    annualRet,
    maxDrawdown,
    sharpe,
    calmar,
    dailyWinRate: stats.winRate,
    dailyKelly: stats.kellyF,
    nTaken,
    nSkipped,
    totalCosts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 按 key 分组（保持插入顺序）。 */
function groupBy<T>(arr: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = keyOf(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
