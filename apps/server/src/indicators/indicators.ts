/**
 * 技术指标计算 — 精确翻译自 kline_indicators.py
 * 所有公式与 Python 版本完全一致，确保历史数据一致性。
 */

export interface KlineRow {
  open_time: Date | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
  close_time?: Date | string;
  quote_volume?: string | number;
  trades?: string | number;
  taker_buy_base_vol?: string | number;
  taker_buy_quote_vol?: string | number;
}

export interface KlineRowWithIndicators extends KlineRow {
  DIF: number;
  DEA: number;
  MACD: number;
  'KDJ.K': number;
  'KDJ.D': number;
  'KDJ.J': number;
  BBI: number;
  MA5: number;
  MA30: number;
  MA60: number;
  MA120: number;
  MA240: number;
  '10_quote_volume': number;
  atr_14: number;
  loss_atr_14: number;
  low_9: number;
  high_9: number;
  stop_loss_pct: number;
  risk_reward_ratio: number;
}

/** EMA — 首值以第一个数据为种子（Python: k = 2/(period+1)） */
function calcEma(values: number[], period: number): number[] {
  const k = 2.0 / (period + 1);
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    result.push(i === 0 ? values[i] : values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/** SMA — 不足 period 时取已有数据的均值 */
function calcSma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    const window = values.slice(start, i + 1);
    result.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  return result;
}

/** 按有效数字位数四舍五入（Python: _round_sig） */
function roundSig(x: number, sig = 8): number {
  if (x === 0 || !isFinite(x)) return x;
  const magnitude = Math.floor(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, Math.max(sig - 1 - magnitude, 0));
  return Math.round(x * factor) / factor;
}

/** Wilder's ATR — Python: _calc_atr */
function calcAtr(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const n = highs.length;
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  const atr: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < period - 1) {
      atr.push(tr.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1));
    } else if (i === period - 1) {
      atr.push(tr.slice(0, period).reduce((a, b) => a + b, 0) / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }
  return atr;
}

/**
 * 原地计算并填充技术指标
 * 精确翻译自 kline_indicators.py calc_indicators()
 */
export function calcIndicators(rows: KlineRow[]): KlineRowWithIndicators[] {
  const closes = rows.map((r) => parseFloat(String(r.close)));
  const highs = rows.map((r) => parseFloat(String(r.high)));
  const lows = rows.map((r) => parseFloat(String(r.low)));
  const n = closes.length;

  // MACD
  const ema12 = calcEma(closes, 12);
  const ema26 = calcEma(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEma(dif, 9);
  const macd = dif.map((d, i) => 2.0 * (d - dea[i]));

  // KDJ（周期 9，初始 K=D=50）
  const kVals: number[] = [];
  const dVals: number[] = [];
  const jVals: number[] = [];
  let prevK = 50.0;
  let prevD = 50.0;
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - 8);
    const hMax = Math.max(...highs.slice(s, i + 1));
    const lMin = Math.min(...lows.slice(s, i + 1));
    const rsv = hMax !== lMin
      ? ((closes[i] - lMin) / (hMax - lMin)) * 100
      : 50.0;
    const k = prevK * (2 / 3) + rsv / 3;
    const d = prevD * (2 / 3) + k / 3;
    kVals.push(k);
    dVals.push(d);
    jVals.push(3 * k - 2 * d);
    prevK = k;
    prevD = d;
  }

  // BBI = (MA3+MA6+MA12+MA24)/4
  const sma3 = calcSma(closes, 3);
  const sma6 = calcSma(closes, 6);
  const sma12 = calcSma(closes, 12);
  const sma24 = calcSma(closes, 24);
  const bbi = sma3.map((v, i) => (v + sma6[i] + sma12[i] + sma24[i]) / 4);

  const ma5 = calcSma(closes, 5);
  const ma30 = calcSma(closes, 30);
  const ma60 = calcSma(closes, 60);
  const ma120 = calcSma(closes, 120);
  const ma240 = calcSma(closes, 240);

  const qvols = rows.map((r) => parseFloat(String(r.quote_volume || 0)));
  const qvol10 = calcSma(qvols, 10);
  const atr14 = calcAtr(highs, lows, closes, 14);

  // 9日高低、止损幅度、盈亏比
  const low9: number[] = [];
  const high9: number[] = [];
  const slPct: number[] = [];
  const rr: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - 8);
    const h9 = Math.max(...highs.slice(s, i + 1));
    const l9 = Math.min(...lows.slice(s, i + 1));
    high9.push(h9);
    low9.push(l9);
    slPct.push(closes[i] ? (1 - l9 / closes[i]) * 100 : 0.0);
    const loss = closes[i] - l9;
    rr.push(loss ? (h9 - closes[i]) / loss : 0.0);
  }

  return rows.map((row, i) => ({
    ...row,
    DIF: roundSig(dif[i], 8),
    DEA: roundSig(dea[i], 8),
    MACD: roundSig(macd[i], 8),
    'KDJ.K': parseFloat(kVals[i].toFixed(4)),
    'KDJ.D': parseFloat(dVals[i].toFixed(4)),
    'KDJ.J': parseFloat(jVals[i].toFixed(4)),
    BBI: roundSig(bbi[i], 8),
    MA5: roundSig(ma5[i], 8),
    MA30: roundSig(ma30[i], 8),
    MA60: roundSig(ma60[i], 8),
    MA120: roundSig(ma120[i], 8),
    MA240: roundSig(ma240[i], 8),
    '10_quote_volume': parseFloat(qvol10[i].toFixed(2)),
    atr_14: roundSig(atr14[i], 8),
    loss_atr_14: roundSig(closes[i] - atr14[i], 8),
    low_9: roundSig(low9[i], 8),
    high_9: roundSig(high9[i], 8),
    stop_loss_pct: parseFloat(slPct[i].toFixed(4)),
    risk_reward_ratio: roundSig(rr[i], 4),
  })) as KlineRowWithIndicators[];
}
