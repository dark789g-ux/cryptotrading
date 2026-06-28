/** 价格指数 Laspeyres 链式链接（port quant_pipeline/custom_index/price_index.py） */

import type {
  ComponentBar,
  ComputeContext,
  IndexQuoteRow,
  MemberWeight,
  StockMeta,
  WeightVersion,
} from './custom-index-compute.types';
import {
  normalizeWeights,
  resolvePitMembers,
} from './custom-index-weight-resolver';

export type ComponentReturnFn = (bar: ComponentBar) => number | null;

export type CustomIndexWarningHandler = (
  code: string,
  detail: Record<string, unknown>,
) => void;

function isFinitePositive(x: number | null | undefined): x is number {
  return x != null && Number.isFinite(x) && x > 0;
}

export function isComponentValid(params: {
  conCode: string;
  tradeDate: string;
  bar: ComponentBar | null | undefined;
  meta: StockMeta | null | undefined;
}): boolean {
  const { tradeDate, bar, meta } = params;
  if (bar == null || !isFinitePositive(bar.price)) {
    return false;
  }
  if (meta != null) {
    if (meta.listDate != null && tradeDate < meta.listDate) {
      return false;
    }
    if (meta.delistDate != null && tradeDate > meta.delistDate) {
      return false;
    }
  }
  if (bar.vol != null && bar.vol <= 0) {
    return false;
  }
  return true;
}

export function filterValidMembers(params: {
  tradeDate: string;
  members: readonly MemberWeight[];
  bars: Record<string, ComponentBar>;
  stockMeta: Record<string, StockMeta>;
}): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const member of params.members) {
    const meta = params.stockMeta[member.conCode];
    const bar = params.bars[member.conCode];
    if (
      isComponentValid({
        conCode: member.conCode,
        tradeDate: params.tradeDate,
        bar,
        meta,
      })
    ) {
      raw[member.conCode] = member.weight;
    }
  }
  return normalizeWeights(raw);
}

export function findActualStartDate(params: {
  tradeDates: string[];
  baseDate: string;
  initialMembers: readonly MemberWeight[];
  ctx: ComputeContext;
}): string | null {
  const candidates = params.tradeDates.filter((d) => d >= params.baseDate);
  const required = new Set(params.initialMembers.map((m) => m.conCode));
  for (const tradeDate of candidates) {
    const dayBars = params.ctx.barsByDate[tradeDate] ?? {};
    let ok = true;
    for (const code of required) {
      const meta = params.ctx.stockMeta[code];
      const bar = dayBars[code];
      if (
        !isComponentValid({
          conCode: code,
          tradeDate,
          bar,
          meta,
        })
      ) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return tradeDate;
    }
  }
  return null;
}

function computeComponentReturn(
  bar: ComponentBar,
  returnFn: ComponentReturnFn,
): number | null {
  const ret = returnFn(bar);
  if (ret == null || !Number.isFinite(ret)) {
    return null;
  }
  return ret;
}

export function defaultPriceReturn(bar: ComponentBar): number | null {
  if (!isFinitePositive(bar.price) || !isFinitePositive(bar.pricePrev)) {
    return null;
  }
  return bar.price / bar.pricePrev - 1.0;
}

function computeWeightedReturn(
  weights: Record<string, number>,
  bars: Record<string, ComponentBar>,
  returnFn: ComponentReturnFn,
): number | null {
  if (Object.keys(weights).length < 2) {
    return null;
  }
  let total = 0.0;
  for (const [code, weight] of Object.entries(weights)) {
    const bar = bars[code];
    if (bar == null) {
      return null;
    }
    const ret = computeComponentReturn(bar, returnFn);
    if (ret == null) {
      return null;
    }
    total += weight * ret;
  }
  return total;
}

function synthesizeOhlc(params: {
  indexClose: number;
  indexPreClose: number;
  weights: Record<string, number>;
  bars: Record<string, ComponentBar>;
}): [number, number, number] {
  const { indexClose, indexPreClose, weights, bars } = params;
  if (indexPreClose <= 0) {
    return [indexClose, indexClose, indexClose];
  }

  let openRet = 0.0;
  let highRatio = 0.0;
  let lowRatio = 0.0;
  for (const [code, weight] of Object.entries(weights)) {
    const bar = bars[code];
    if (bar == null || !isFinitePositive(bar.price)) {
      continue;
    }
    if (isFinitePositive(bar.openPrice) && isFinitePositive(bar.pricePrev)) {
      openRet += weight * (bar.openPrice / bar.pricePrev - 1.0);
    }
    if (isFinitePositive(bar.highPrice)) {
      highRatio += weight * (bar.highPrice / bar.price - 1.0);
    }
    if (isFinitePositive(bar.lowPrice)) {
      lowRatio += weight * (bar.lowPrice / bar.price - 1.0);
    }
  }

  const indexOpen = indexPreClose * (1.0 + openRet);
  const indexHigh = indexClose * (1.0 + highRatio);
  const indexLow = indexClose * (1.0 + lowRatio);
  return [
    indexOpen,
    Math.max(indexHigh, indexLow, indexClose),
    Math.min(indexHigh, indexLow, indexClose),
  ];
}

export function computePriceIndexQuotes(params: {
  versions: readonly WeightVersion[];
  ctx: ComputeContext;
  baseDate: string;
  basePoint: number;
  returnFn?: ComponentReturnFn;
  onWarning?: CustomIndexWarningHandler;
}): IndexQuoteRow[] {
  const retFn = params.returnFn ?? defaultPriceReturn;
  let initialMembers = resolvePitMembers(params.versions, params.baseDate);
  if (initialMembers.length === 0 && params.versions.length > 0) {
    initialMembers = params.versions[0].members;
  }

  const actualStart = findActualStartDate({
    tradeDates: params.ctx.tradeDates,
    baseDate: params.baseDate,
    initialMembers,
    ctx: params.ctx,
  });
  if (actualStart == null) {
    params.onWarning?.('custom_index_no_actual_start', {
      baseDate: params.baseDate,
    });
    return [];
  }

  const quotes: IndexQuoteRow[] = [];
  let indexLevel: number | null = null;
  let prevClose: number | null = null;

  for (const tradeDate of params.ctx.tradeDates) {
    if (tradeDate < actualStart) {
      continue;
    }

    const members = resolvePitMembers(params.versions, tradeDate);
    const dayBars = params.ctx.barsByDate[tradeDate] ?? {};
    const weights = filterValidMembers({
      tradeDate,
      members,
      bars: dayBars,
      stockMeta: params.ctx.stockMeta,
    });

    if (Object.keys(weights).length < 2) {
      params.onWarning?.('custom_index_insufficient_members', {
        tradeDate,
        validCount: Object.keys(weights).length,
      });
      continue;
    }

    if (tradeDate === actualStart) {
      indexLevel = params.basePoint;
    } else {
      const weightedRet = computeWeightedReturn(weights, dayBars, retFn);
      if (weightedRet == null) {
        params.onWarning?.('custom_index_return_missing', {
          tradeDate,
        });
        continue;
      }
      if (indexLevel == null) {
        continue;
      }
      indexLevel = indexLevel * (1.0 + weightedRet);
    }

    const indexPre = prevClose ?? indexLevel;
    const [indexOpen, indexHigh, indexLow] = synthesizeOhlc({
      indexClose: indexLevel,
      indexPreClose: indexPre,
      weights,
      bars: dayBars,
    });

    let volSum = 0.0;
    let amtSum = 0.0;
    let volHas = false;
    let amtHas = false;
    for (const code of Object.keys(weights)) {
      const bar = dayBars[code];
      if (bar == null) {
        continue;
      }
      if (bar.vol != null && Number.isFinite(bar.vol)) {
        volSum += bar.vol;
        volHas = true;
      }
      if (bar.amount != null && Number.isFinite(bar.amount)) {
        amtSum += bar.amount;
        amtHas = true;
      }
    }

    const change = prevClose != null ? indexLevel - indexPre : 0.0;
    const pct =
      prevClose != null && indexPre > 0 ? (change / indexPre) * 100.0 : 0.0;

    quotes.push({
      tradeDate,
      open: indexOpen,
      high: indexHigh,
      low: indexLow,
      close: indexLevel,
      preClose: prevClose != null ? indexPre : indexLevel,
      change,
      pctChange: pct,
      volHand: volHas ? volSum : null,
      amount: amtHas ? amtSum : null,
    });
    prevClose = indexLevel;
  }

  return quotes;
}

export function computeTwoStockEqualIndex(params: {
  dates: string[];
  stockAPrices: number[];
  stockBPrices: number[];
  basePoint?: number;
}): number[] {
  const { dates, stockAPrices, stockBPrices } = params;
  const basePoint = params.basePoint ?? 1000.0;

  if (
    dates.length !== stockAPrices.length ||
    dates.length !== stockBPrices.length
  ) {
    throw new Error('dates/prices length mismatch');
  }
  if (dates.length < 1) {
    return [];
  }

  const levels = [basePoint];
  for (let i = 1; i < dates.length; i++) {
    const ra = stockAPrices[i] / stockAPrices[i - 1] - 1.0;
    const rb = stockBPrices[i] / stockBPrices[i - 1] - 1.0;
    const r = 0.5 * ra + 0.5 * rb;
    levels.push(levels[levels.length - 1] * (1.0 + r));
  }
  return levels;
}
