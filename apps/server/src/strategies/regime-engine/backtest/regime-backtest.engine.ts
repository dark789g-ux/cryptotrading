import { classifyRegime, RegimeResult } from '../regime.classifier';
import {
  CooldownState,
  initCooldown,
  isInCooldown,
  registerExit,
  updateDrawdownHalt,
} from '../core/cooldown';
import { buyRate, sellRate } from '../core/cost';
import { HoldingDaySnapshot } from '../core/exit-simulator';
import {
  computeAlloc,
  computeCashSplitAlloc,
  MIN_ALLOC_YUAN,
} from '../core/sizing';
import { computeSummary, EngineDailyRow } from '../core/summary';
import {
  RegimeBacktestInput,
  RegimeBacktestResult,
  RegimeBacktestTrade,
  RegimeDailyAuditEntry,
  RegimeDailyAuditExit,
  RegimeTradePhase,
} from './regime-backtest.types';
import {
  OpenPosition,
  tryInitExitFromSignal,
  markPosition,
  forceClosePositions,
  stepAndClosePositions,
  isKellyPipelineEnabled,
  collectCompletedRets,
  computeKellyMult,
} from './regime-backtest.engine-positions';

export function runRegimeBacktest(input: RegimeBacktestInput): RegimeBacktestResult {
  const { regimeConfig, capital, calendar, marketSnapshots, signalsByDate } = input;
  const { initialCapital, cost, sizing, circuitBreaker: cb } = capital;
  const kellyCfg = capital.kelly;
  const kellyEnabled = isKellyPipelineEnabled(input);
  const anchorMode = capital.anchorMode ?? false;
  let positionRatio: number | null | undefined;
  let maxPositions: number | null = null;
  const buyFeeRate = buyRate(cost);

  const positions: OpenPosition[] = [];
  const trades: RegimeBacktestTrade[] = [];
  const dailyRows: EngineDailyRow[] = [];
  const auditRows: RegimeBacktestResult['auditRows'] = [];

  let cash = initialCapital;
  let simCash = initialCapital;
  const simPositions: OpenPosition[] = [];
  const completedTrades: RegimeBacktestTrade[] = [];
  let completedTradeCount = 0;
  let wasProbeMode = false;

  let prevNav = initialCapital;
  let totalCosts = 0;
  let peak = -Infinity;
  let nTaken = 0;
  let nSkipped = 0;

  const cooldown: CooldownState = initCooldown(cb?.baseCooldownDays ?? 0);
  let ddHalted = false;

  function recordCompletedTrade(trade: RegimeBacktestTrade): void {
    completedTrades.push(trade);
    completedTradeCount++;
  }

  function recordDayEntry(
    signal: { signalDate: string; buyDate: string; tsCode: string },
    tradeRec: RegimeBacktestTrade,
    dayEntries: RegimeDailyAuditEntry[],
  ): void {
    dayEntries.push({
      tsCode: signal.tsCode,
      signalDate: signal.signalDate,
      buyDate: signal.buyDate,
      status: tradeRec.status,
      skipReason: tradeRec.skipReason,
      alloc: tradeRec.alloc,
      tradePhase: tradeRec.tradePhase,
    });
  }

  function recordSignal(
    signal: { signalDate: string; buyDate: string; tsCode: string },
    tradeRec: RegimeBacktestTrade,
    dayEntries: RegimeDailyAuditEntry[],
  ): void {
    trades.push(tradeRec);
    recordDayEntry(signal, tradeRec, dayEntries);
  }

  function pushDayExit(pos: OpenPosition, dayExits: RegimeDailyAuditExit[]): void {
    dayExits.push({
      tsCode: pos.tsCode,
      exitDate: pos.exitDate!,
      ret: pos.ret,
      realizedRetNet: pos.trade.realizedRetNet,
      exitReason: pos.trade.exitReason,
      tradePhase: pos.trade.tradePhase,
    });
  }

  function closeLivePosition(
    pos: OpenPosition,
    dayIdx: number,
    dayExits: RegimeDailyAuditExit[],
  ): void {
    const ret = pos.ret!;
    const exitDate = pos.exitDate!;
    const gross = pos.alloc * (1 + ret);
    const sellFeeRateVal = sellRate(cost, exitDate);
    const sellCost = gross * sellFeeRateVal;
    cash += gross - sellCost;
    totalCosts += sellCost;

    const investedTotal = pos.alloc + pos.buyCost;
    pos.trade.costsPaid = pos.buyCost + sellCost;
    pos.trade.realizedRetNet =
      investedTotal !== 0
        ? (gross - sellCost - pos.alloc - pos.buyCost) / investedTotal
        : 0;
    pos.trade.tradePhase = kellyEnabled ? (pos.trade.tradePhase ?? 'live') : pos.trade.tradePhase;
    pushDayExit(pos, dayExits);

    if (cb?.enableCooldown && !anchorMode) {
      const isWin = (pos.trade.realizedRetNet ?? 0) > 0;
      registerExit(
        cooldown,
        isWin,
        false,
        dayIdx,
        cb.consecutiveLossesThreshold,
        cb.maxCooldownDays,
        cb.extendOnLoss,
        cb.reduceOnProfit,
      );
    }
    recordCompletedTrade(pos.trade);
  }

  function closeSimPosition(pos: OpenPosition, dayExits: RegimeDailyAuditExit[]): void {
    const ret = pos.ret!;
    const exitDate = pos.exitDate!;
    const gross = pos.alloc * (1 + ret);
    const sellFeeRateVal = sellRate(cost, exitDate);
    const sellCost = gross * sellFeeRateVal;
    simCash += gross - sellCost;

    const investedTotal = pos.alloc + pos.buyCost;
    pos.trade.costsPaid = pos.buyCost + sellCost;
    pos.trade.realizedRetNet =
      investedTotal !== 0
        ? (gross - sellCost - pos.alloc - pos.buyCost) / investedTotal
        : 0;
    pushDayExit(pos, dayExits);
    recordCompletedTrade(pos.trade);
  }

  for (let dayIdx = 0; dayIdx < calendar.length; dayIdx++) {
    const d = calendar[dayIdx];
    const navRef = prevNav;
    const dayStartCompleted = completedTradeCount;
    const dayEntries: RegimeDailyAuditEntry[] = [];
    const dayExits: RegimeDailyAuditExit[] = [];

    const completedRets = collectCompletedRets(completedTrades);
    const kellyMult =
      kellyEnabled && kellyCfg
        ? computeKellyMult(kellyCfg, completedRets)
        : 1;

    const isSimPhase =
      kellyEnabled && kellyCfg !== undefined && completedTradeCount < kellyCfg.simTrades;
    const isProbeMode =
      kellyEnabled &&
      kellyCfg !== undefined &&
      !isSimPhase &&
      kellyCfg.enableProbe &&
      kellyMult <= 0 &&
      positions.length === 0;
    const useSimLedger = isSimPhase || isProbeMode;
    const activePhase: RegimeTradePhase = isSimPhase
      ? 'simulation'
      : isProbeMode
        ? 'probe'
        : 'live';

    if (wasProbeMode && !isProbeMode && simPositions.length > 0) {
      forceClosePositions(simPositions, d, 'probe_force_close', (pos) =>
        closeSimPosition(pos, dayExits),
      );
    }
    wasProbeMode = isProbeMode;

    // 先推进出场，再开新仓
    stepAndClosePositions(positions, d, (pos) =>
      closeLivePosition(pos, dayIdx, dayExits),
    );
    stepAndClosePositions(simPositions, d, (pos) => closeSimPosition(pos, dayExits));

    const snapshot = marketSnapshots.get(d);
    let regime: RegimeResult;
    if (!snapshot) {
      regime = 'unknown';
    } else {
      regime = classifyRegime(snapshot, regimeConfig.quadrants);
    }

    let regimeNoOpen = regime === 'unknown';
    let entryAction: 'trade' | 'flat' | undefined;
    let exitMode: string | undefined;
    let requireAllProfitable = false;
    if (!regimeNoOpen) {
      const entry = regimeConfig.quadrants.find((q) => q.key === regime);
      entryAction = entry?.action;
      exitMode = entry?.exitMode ?? 'fixed_n';
      if (entryAction === 'flat') regimeNoOpen = true;

      positionRatio = entry?.positionRatio;
      maxPositions = entry?.maxPositions ?? null;
      requireAllProfitable =
        entry?.requireAllPositionsProfitable
        ?? capital.requireAllPositionsProfitable
        ?? false;
    }

    const frozenCooldown =
      !anchorMode &&
      !useSimLedger &&
      !!cb?.enableCooldown &&
      isInCooldown(cooldown, dayIdx);
    const ddNow = peak > 0 ? prevNav / peak - 1 : 0;
    if (cb?.enableDrawdownHalt && !anchorMode) {
      ddHalted = updateDrawdownHalt(ddHalted, ddNow, cb);
    }
    const frozenDD = !anchorMode && !!cb?.enableDrawdownHalt && ddHalted;
    const frozen = frozenCooldown || frozenDD;

    const daySignals = signalsByDate.get(d) ?? [];
    const targetPositions = useSimLedger ? simPositions : positions;
    const profitGate =
      !requireAllProfitable ||
      targetPositions.length === 0 ||
      targetPositions.every((p) => p.mv >= p.alloc);

    for (const signal of daySignals) {
      const tradeRec: RegimeBacktestTrade = {
        signalDate: signal.signalDate,
        buyDate: signal.buyDate,
        exitDate: null,
        tsCode: signal.tsCode,
        regime,
        exitMode: exitMode ?? '',
        status: 'skipped',
      };

      if (frozen) {
        tradeRec.skipReason = frozenCooldown ? 'cooldown' : 'drawdown_halt';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      if (!profitGate) {
        tradeRec.skipReason = 'profit_gate';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      if (regimeNoOpen) {
        tradeRec.skipReason = 'regime_flat';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      const initResult = tryInitExitFromSignal(signal.simulationInput);
      if (initResult.ok === false) {
        tradeRec.skipReason = initResult.reason;
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      const targetCash = useSimLedger ? simCash : cash;

      if (!anchorMode && targetPositions.some((p) => p.tsCode === signal.tsCode)) {
        tradeRec.skipReason = 'already_held';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      if (!anchorMode && maxPositions !== null && targetPositions.length >= maxPositions) {
        tradeRec.skipReason = 'slots_full';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      const r = positionRatio;
      if (r == null || !(typeof r === 'number' && r > 0)) {
        tradeRec.skipReason = 'sized_out';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      const applyKellySizing = kellyEnabled && !isProbeMode;
      let effectiveR = r;
      if (applyKellySizing && kellyEnabled) {
        if (kellyMult <= 0) {
          tradeRec.skipReason = 'sized_out';
          recordSignal(signal, tradeRec, dayEntries);
          nSkipped++;
          continue;
        }
        effectiveR = r * kellyMult;
      }

      let alloc: number;
      if (anchorMode) {
        alloc = computeAlloc({
          quality: 0.5,
          positionRatio: r,
          sizing,
          navRef,
          anchorMode,
          effectivePositionRatio: applyKellySizing ? effectiveR : r,
          sourceKellyMult: applyKellySizing ? kellyMult : 1,
        });
      } else {
        const split = computeCashSplitAlloc({
          cash: targetCash,
          positionRatio: effectiveR,
          openCount: targetPositions.length,
        });
        if (split === null) {
          tradeRec.skipReason = 'budget_full';
          recordSignal(signal, tradeRec, dayEntries);
          nSkipped++;
          continue;
        }
        alloc = split;
      }

      if (!anchorMode && alloc < MIN_ALLOC_YUAN) {
        tradeRec.skipReason = 'sized_out';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      const buyCost = alloc * buyFeeRate;
      if (!anchorMode && targetCash < alloc + buyCost) {
        tradeRec.skipReason = 'cash_short';
        recordSignal(signal, tradeRec, dayEntries);
        nSkipped++;
        continue;
      }

      if (useSimLedger) {
        simCash -= alloc + buyCost;
      } else {
        cash -= alloc + buyCost;
        totalCosts += buyCost;
      }

      tradeRec.status = 'taken';
      if (kellyEnabled) {
        tradeRec.tradePhase = activePhase;
      }
      // exitDate / ret / exitReason 待日频 step 或 backtest_end 写入
      tradeRec.alloc = alloc;
      tradeRec.costsPaid = buyCost;
      recordSignal(signal, tradeRec, dayEntries);
      nTaken++;

      const daysByDate = new Map<string, HoldingDaySnapshot>();
      for (const day of signal.simulationInput.days) {
        daysByDate.set(day.calDate, day);
      }

      const simInput = signal.simulationInput;
      const pos: OpenPosition = {
        tsCode: signal.tsCode,
        buyDate: initResult.buyDate,
        alloc,
        buyCost,
        entryPrice: initResult.entryPrice,
        mv: alloc,
        lastMarkPrice: initResult.entryPrice,
        daysByDate,
        exitState: initResult.state,
        exit: simInput.exit,
        signalHigh: simInput.signalHigh,
        recentLows: simInput.recentLows,
        delistDate: simInput.delistDate,
        trade: tradeRec,
      };

      if (useSimLedger) {
        simPositions.push(pos);
      } else {
        positions.push(pos);
      }
    }

    for (const pos of positions) {
      markPosition(pos, d);
    }
    for (const pos of simPositions) {
      markPosition(pos, d);
    }

    const wasSimPhaseAtStart =
      kellyEnabled && kellyCfg !== undefined && dayStartCompleted < kellyCfg.simTrades;
    if (
      kellyEnabled &&
      kellyCfg !== undefined &&
      wasSimPhaseAtStart &&
      completedTradeCount >= kellyCfg.simTrades &&
      simPositions.length > 0
    ) {
      forceClosePositions(simPositions, d, 'sim_force_close', (pos) =>
        closeSimPosition(pos, dayExits),
      );
    }

    // 日历末日仍持仓 → 以当日收盘强平
    if (dayIdx === calendar.length - 1) {
      if (simPositions.length > 0) {
        forceClosePositions(simPositions, d, 'backtest_end', (pos) =>
          closeSimPosition(pos, dayExits),
        );
      }
      if (positions.length > 0) {
        forceClosePositions(positions, d, 'backtest_end', (pos) =>
          closeLivePosition(pos, dayIdx, dayExits),
        );
      }
    }

    let sumMv = 0;
    for (const pos of positions) {
      sumMv += pos.mv;
    }
    const nav = cash + sumMv;
    const dailyRet = nav / prevNav - 1;

    const inCooldown =
      !anchorMode && !!cb?.enableCooldown && isInCooldown(cooldown, dayIdx);
    let cooldownRemaining: number | null = null;
    if (inCooldown && cooldown.cooldownUntilBarIdx !== null) {
      cooldownRemaining = cooldown.cooldownUntilBarIdx - dayIdx;
    }

    auditRows.push({
      tradeDate: d,
      nav,
      cash,
      regime,
      frozenReason: frozen ? (frozenCooldown ? 'cooldown' : 'drawdown_halt') : null,
      tradePhase: activePhase,
      entries: dayEntries,
      exits: dayExits,
      cooldown: {
        inCooldown,
        duration: cooldown.cooldownDuration,
        remaining: cooldownRemaining,
        consecLosses: cooldown.consecLosses,
      },
      openSymbols: positions.map((p) => p.tsCode),
    });

    dailyRows.push({
      tradeDate: d,
      nav,
      cash,
      dailyRet,
      positionCount: positions.length,
      exposure: nav !== 0 ? sumMv / nav : 0,
    });
    prevNav = nav;
    if (nav > peak) peak = nav;
  }

  const summary = computeSummary(dailyRows, nTaken, nSkipped, initialCapital, totalCosts);
  return { dailyRows, auditRows, trades, summary };
}
