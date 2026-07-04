import { classifyRegime, RegimeResult } from '../regime.classifier';
import {
  CooldownState,
  initCooldown,
  isInCooldown,
  registerExit,
  updateDrawdownHalt,
} from '../core/cooldown';
import { buyRate, sellRate } from '../core/cost';
import { simulateTradeCore, SimulationOutcome, HoldingDaySnapshot } from '../core/exit-simulator';
import { computeAlloc, MIN_ALLOC_YUAN } from '../core/sizing';
import { computeSummary, EngineDailyRow } from '../core/summary';
import { SkipReason } from '../core/types';
import {
  RegimeBacktestInput,
  RegimeBacktestResult,
  RegimeBacktestTrade,
} from './regime-backtest.types';

interface OpenPosition {
  tsCode: string;
  exitDate: string;
  ret: number;
  alloc: number;
  buyCost: number;
  mv: number;
  lastMarkPrice: number;
  daysByDate: Map<string, HoldingDaySnapshot>;
  trade: RegimeBacktestTrade;
}

export function runRegimeBacktest(input: RegimeBacktestInput): RegimeBacktestResult {
  const { regimeConfig, capital, calendar, oamvDaily, signalsByDate } = input;
  const { initialCapital, cost, positionRatio, maxPositions, sizing, circuitBreaker: cb } = capital;
  const anchorMode = capital.anchorMode ?? false;
  const buyFeeRate = buyRate(cost);

  const positions: OpenPosition[] = [];
  const trades: RegimeBacktestTrade[] = [];
  const dailyRows: EngineDailyRow[] = [];

  let cash = initialCapital;
  let prevNav = initialCapital;
  let totalCosts = 0;
  let peak = -Infinity;
  let nTaken = 0;
  let nSkipped = 0;

  const cooldown: CooldownState = initCooldown(cb?.baseCooldownDays ?? 0);
  let ddHalted = false;

  function closeAndRecord(pos: OpenPosition, dayIdx: number): void {
    const gross = pos.alloc * (1 + pos.ret);
    const sellFeeRateVal = sellRate(cost, pos.exitDate);
    const sellCost = gross * sellFeeRateVal;
    cash += gross - sellCost;
    totalCosts += sellCost;

    const investedTotal = pos.alloc + pos.buyCost;
    pos.trade.costsPaid = pos.buyCost + sellCost;
    pos.trade.realizedRetNet =
      investedTotal !== 0
        ? (gross - sellCost - pos.alloc - pos.buyCost) / investedTotal
        : 0;

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
  }

  for (let dayIdx = 0; dayIdx < calendar.length; dayIdx++) {
    const d = calendar[dayIdx];
    const navRef = prevNav;

    // 1. close positions
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i].exitDate !== d) continue;
      closeAndRecord(positions[i], dayIdx);
      positions.splice(i, 1);
    }

    // 2. regime classification
    const oamv = oamvDaily.get(d);
    let regime: RegimeResult;
    if (!oamv) {
      regime = 'unknown';
    } else {
      regime = classifyRegime(oamv.amvDif, oamv.amvMacd);
    }

    let regimeNoOpen = regime === 'unknown';
    let entryAction: 'trade' | 'flat' | undefined;
    let exitMode: string | undefined;
    if (!regimeNoOpen) {
      const entry = regimeConfig[regime];
      entryAction = entry.action;
      exitMode = entry.exitMode ?? 'fixed_n';
      if (entryAction === 'flat') regimeNoOpen = true;
    }

    // 3. circuit breaker gates
    const frozenCooldown = !anchorMode && !!cb?.enableCooldown && isInCooldown(cooldown, dayIdx);
    const ddNow = peak > 0 ? prevNav / peak - 1 : 0;
    if (cb?.enableDrawdownHalt && !anchorMode) {
      ddHalted = updateDrawdownHalt(ddHalted, ddNow, cb);
    }
    const frozenDD = !anchorMode && !!cb?.enableDrawdownHalt && ddHalted;
    const frozen = frozenCooldown || frozenDD;

    // 4. entry
    const daySignals = signalsByDate.get(d) ?? [];
    for (const signal of daySignals) {
      const outcome: SimulationOutcome = simulateTradeCore(signal.simulationInput);
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
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      if (regimeNoOpen) {
        tradeRec.skipReason = 'regime_flat';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      if (outcome.kind === 'filtered') {
        tradeRec.skipReason = 'sized_out';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      const simTrade = outcome.trade;

      // quality=0.5: 当前回测不接入信号质量评分，占位默认值。
      // signal_weighted 模式下乘子退化为 (floor+cap)/2；后续若接入质量评分，
      // 由 signals 预枚举阶段（data-loader）提供。
      const alloc = computeAlloc({
        quality: 0.5,
        positionRatio,
        sizing,
        navRef: prevNav,
        anchorMode,
      });

      // already_held
      if (!anchorMode && positions.some((p) => p.tsCode === signal.tsCode)) {
        tradeRec.skipReason = 'already_held';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      // slots_full
      if (!anchorMode && maxPositions !== null && positions.length >= maxPositions) {
        tradeRec.skipReason = 'slots_full';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      // sized_out
      if (!anchorMode && alloc < MIN_ALLOC_YUAN) {
        tradeRec.skipReason = 'sized_out';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      // cash_short
      const buyCost = alloc * buyFeeRate;
      if (!anchorMode && cash < alloc + buyCost) {
        tradeRec.skipReason = 'cash_short';
        trades.push(tradeRec);
        nSkipped++;
        continue;
      }

      // taken
      cash -= alloc + buyCost;
      totalCosts += buyCost;
      tradeRec.status = 'taken';
      tradeRec.exitDate = simTrade.exitDate;
      tradeRec.ret = simTrade.ret;
      tradeRec.exitReason = simTrade.exitReason;
      tradeRec.alloc = alloc;
      tradeRec.costsPaid = buyCost;
      trades.push(tradeRec);
      nTaken++;

      const daysByDate = new Map<string, HoldingDaySnapshot>();
      for (const day of signal.simulationInput.days) {
        daysByDate.set(day.calDate, day);
      }

      const pos: OpenPosition = {
        tsCode: signal.tsCode,
        exitDate: simTrade.exitDate,
        ret: simTrade.ret,
        alloc,
        buyCost,
        mv: alloc,
        lastMarkPrice: simTrade.buyPrice,
        daysByDate,
        trade: tradeRec,
      };

      if (simTrade.exitDate === d) {
        closeAndRecord(pos, dayIdx);
      } else {
        positions.push(pos);
      }
    }

    // 5. mark-to-market
    for (const pos of positions) {
      const bar = pos.daysByDate.get(d);
      if (!bar) continue;
      if (!bar.hasQuote || bar.qfqClose === null) continue;
      if (Number.isFinite(pos.lastMarkPrice) && pos.lastMarkPrice !== 0) {
        pos.mv *= bar.qfqClose / pos.lastMarkPrice;
      }
      pos.lastMarkPrice = bar.qfqClose;
    }

    // 6. record
    let sumMv = 0;
    for (const pos of positions) {
      sumMv += pos.mv;
    }
    const nav = cash + sumMv;
    const dailyRet = nav / prevNav - 1;
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
  return { dailyRows, trades, summary };
}
