/** 全收益指数：adj_factor 分解 + 缺失 fallback（port quant_pipeline/custom_index/total_return.py） */

import type {
  ComponentBar,
  ComputeContext,
  IndexQuoteRow,
  WeightVersion,
} from './custom-index-compute.types';
import {
  computePriceIndexQuotes,
  defaultPriceReturn,
  type ComponentReturnFn,
  type CustomIndexWarningHandler,
} from './custom-index-price-index';

export function totalReturnFromAdj(bar: ComponentBar): number | null {
  const adj = bar.adjFactor;
  const adjPrev = bar.adjFactorPrev;
  if (adj == null || adjPrev == null || adj <= 0 || adjPrev <= 0) {
    return null;
  }
  if (!bar.close || !bar.pricePrevRaw) {
    return null;
  }
  const cur = bar.close * adj;
  const prev = bar.pricePrevRaw * adjPrev;
  if (prev <= 0) {
    return null;
  }
  return cur / prev - 1.0;
}

export function makeTotalReturnFn(params?: {
  onWarning?: CustomIndexWarningHandler;
}): ComponentReturnFn {
  return (bar: ComponentBar): number | null => {
    const tr = totalReturnFromAdj(bar);
    if (tr != null && Number.isFinite(tr)) {
      return tr;
    }
    params?.onWarning?.('custom_index_total_return_fallback', {
      conCode: bar.conCode,
      tradeDate: bar.tradeDate,
    });
    return defaultPriceReturn(bar);
  };
}

export function computeTotalReturnQuotes(params: {
  versions: readonly WeightVersion[];
  ctx: ComputeContext;
  baseDate: string;
  basePoint: number;
  onWarning?: CustomIndexWarningHandler;
}): IndexQuoteRow[] {
  return computePriceIndexQuotes({
    versions: params.versions,
    ctx: params.ctx,
    baseDate: params.baseDate,
    basePoint: params.basePoint,
    returnFn: makeTotalReturnFn({ onWarning: params.onWarning }),
    onWarning: params.onWarning,
  });
}
