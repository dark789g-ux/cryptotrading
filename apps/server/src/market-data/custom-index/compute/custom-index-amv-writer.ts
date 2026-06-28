import { resolvePitMembers } from './custom-index-weight-resolver';
import {
  CUSTOM_INDEX_AMV_SCALE_K,
  type ComputeContext,
  type CustomIndexAmvRow,
  type IndexQuoteRow,
  type WeightVersion,
} from './custom-index-compute.types';

/** AMV 均线辅助（对齐 Python calc_simple_ma）。 */
export function calcSimpleMa(
  values: readonly (number | null)[],
  period: number,
): Array<number | null> {
  const out: Array<number | null> = [];
  const buf: number[] = [];

  for (const v of values) {
    if (v === null || Number.isNaN(v)) {
      out.push(null);
      continue;
    }
    buf.push(v);
    const window = buf.slice(-period);
    if (window.length < period) {
      out.push(null);
    } else {
      out.push(window.reduce((sum, x) => sum + x, 0) / period);
    }
  }

  return out;
}

export function computeAmvRows(params: {
  customIndexId: string;
  versions: readonly WeightVersion[];
  ctx: ComputeContext;
  quotes: readonly IndexQuoteRow[];
}): CustomIndexAmvRow[] {
  const { customIndexId, versions, ctx, quotes } = params;

  const quoteClose = new Map<string, number>();
  for (const q of quotes) {
    if (q.close !== null && q.close !== undefined) {
      quoteClose.set(q.tradeDate, q.close);
    }
  }

  const tradeDates = quotes.map((q) => q.tradeDate);
  const amvValues: Array<number | null> = [];

  for (const tradeDate of tradeDates) {
    const indexClose = quoteClose.get(tradeDate);
    if (indexClose === undefined || indexClose <= 0) {
      amvValues.push(null);
      continue;
    }

    const members = resolvePitMembers(versions, tradeDate);
    const dayBars = ctx.barsByDate[tradeDate] ?? {};

    let turnover = 0;
    let hasData = false;
    for (const member of members) {
      const bar = dayBars[member.conCode];
      if (bar === undefined || bar.vol === null || bar.vol <= 0) {
        continue;
      }
      turnover += bar.close * bar.vol;
      hasData = true;
    }

    if (!hasData) {
      amvValues.push(null);
      continue;
    }

    amvValues.push((turnover / indexClose) * CUSTOM_INDEX_AMV_SCALE_K);
  }

  const ma5 = calcSimpleMa(amvValues, 5);
  const ma10 = calcSimpleMa(amvValues, 10);
  const ma20 = calcSimpleMa(amvValues, 20);
  const ma60 = calcSimpleMa(amvValues, 60);

  const rows: CustomIndexAmvRow[] = [];
  for (let i = 0; i < tradeDates.length; i++) {
    const amv = amvValues[i];
    if (amv === null || Number.isNaN(amv)) {
      continue;
    }
    rows.push({
      customIndexId,
      tradeDate: tradeDates[i],
      amv,
      amvMa5: ma5[i],
      amvMa10: ma10[i],
      amvMa20: ma20[i],
      amvMa60: ma60[i],
    });
  }

  return rows;
}
