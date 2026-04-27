import { KlineRow, KlineRowWithIndicators } from './indicators';

export interface IndicatorCalcState {
  count: number;
  ema12: number;
  ema26: number;
  dea: number;
  kdjK: number;
  kdjD: number;
  atr14: number;
  closes: number[];
  highs: number[];
  lows: number[];
  qvols: number[];
  trs: number[];
  brickSma2a: number;
  brickSma4a: number;
  brickSma5a: number;
  brickPrev1: number;
  brickPrev2: number;
  brickInited: boolean;
}

export interface KlineRowWithIndicatorState {
  row: KlineRowWithIndicators;
  state: IndicatorCalcState;
  brickChart: { brick: number; delta: number; xg: boolean };
}

const EMA12_PERIOD = 12;
const EMA26_PERIOD = 26;
const DEA_PERIOD = 9;
const ATR_PERIOD = 14;
const BRICK_P = 4;
const BRICK_N1 = 4;
const BRICK_N2 = 6;

export function calcIndicatorsStreaming(
  rows: KlineRow[],
  seed?: IndicatorCalcState | null,
): KlineRowWithIndicatorState[] {
  const calculator = new IndicatorStreamCalculator(seed ?? undefined);
  return rows.map((row) => calculator.next(row));
}

export function normalizeIndicatorCalcState(value: unknown): IndicatorCalcState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<IndicatorCalcState>;
  if (typeof raw.count !== 'number' || raw.count < 0) return null;
  return {
    count: raw.count,
    ema12: num(raw.ema12),
    ema26: num(raw.ema26),
    dea: num(raw.dea),
    kdjK: num(raw.kdjK, 50),
    kdjD: num(raw.kdjD, 50),
    atr14: num(raw.atr14),
    closes: arr(raw.closes, 239),
    highs: arr(raw.highs, 8),
    lows: arr(raw.lows, 8),
    qvols: arr(raw.qvols, 9),
    trs: arr(raw.trs, 13),
    brickSma2a: num(raw.brickSma2a),
    brickSma4a: num(raw.brickSma4a),
    brickSma5a: num(raw.brickSma5a),
    brickPrev1: num(raw.brickPrev1),
    brickPrev2: num(raw.brickPrev2),
    brickInited: Boolean(raw.brickInited),
  };
}

class IndicatorStreamCalculator {
  private state?: IndicatorCalcState;

  constructor(seed?: IndicatorCalcState) {
    this.state = seed ? cloneState(seed) : undefined;
  }

  next(source: KlineRow): KlineRowWithIndicatorState {
    const close = parseFloat(String(source.close));
    const high = parseFloat(String(source.high));
    const low = parseFloat(String(source.low));
    const qvol = parseFloat(String(source.quote_volume || 0));
    const prev = this.state;
    const index = prev?.count ?? 0;

    const ema12 = calcNextEma(close, EMA12_PERIOD, prev?.ema12);
    const ema26 = calcNextEma(close, EMA26_PERIOD, prev?.ema26);
    const difRaw = ema12 - ema26;
    const dea = calcNextEma(difRaw, DEA_PERIOD, prev?.dea);
    const macdRaw = 2.0 * (difRaw - dea);

    const highs9 = appendWindow(prev?.highs ?? [], high, 9);
    const lows9 = appendWindow(prev?.lows ?? [], low, 9);
    const hMax = Math.max(...highs9);
    const lMin = Math.min(...lows9);
    const rsv = hMax !== lMin ? ((close - lMin) / (hMax - lMin)) * 100 : 50.0;
    const prevK = prev?.kdjK ?? 50.0;
    const prevD = prev?.kdjD ?? 50.0;
    const kdjK = prevK * (2 / 3) + rsv / 3;
    const kdjD = prevD * (2 / 3) + kdjK / 3;
    const kdjJ = 3 * kdjK - 2 * kdjD;

    const closesForCalc = appendWindow(prev?.closes ?? [], close, 240);
    const ma3 = avgLast(closesForCalc, 3);
    const ma6 = avgLast(closesForCalc, 6);
    const ma12 = avgLast(closesForCalc, 12);
    const ma24 = avgLast(closesForCalc, 24);
    const bbiRaw = (ma3 + ma6 + ma12 + ma24) / 4;
    const ma5 = strictAvg(closesForCalc, index, 5);
    const ma30 = strictAvg(closesForCalc, index, 30);
    const ma60 = strictAvg(closesForCalc, index, 60);
    const ma120 = strictAvg(closesForCalc, index, 120);
    const ma240 = strictAvg(closesForCalc, index, 240);

    const qvolsForCalc = appendWindow(prev?.qvols ?? [], qvol, 10);
    const qvol10 = avgLast(qvolsForCalc, 10);
    const tr = index === 0
      ? high - low
      : Math.max(
        high - low,
        Math.abs(high - (prev?.closes[prev.closes.length - 1] ?? close)),
        Math.abs(low - (prev?.closes[prev.closes.length - 1] ?? close)),
      );
    const trsForCalc = appendWindow(prev?.trs ?? [], tr, 14);
    const atr14 = calcNextAtr(index, tr, trsForCalc, prev?.atr14);

    const high9 = Math.max(...highs9);
    const low9 = Math.min(...lows9);
    const stopLossPct = close ? (1 - low9 / close) * 100 : 0.0;
    const loss = close - low9;
    const riskRewardRatio = loss ? (high9 - close) / loss : 0.0;

    const brick = calcNextBrick(prev, high, low, close);
    const aa = index >= 1 && brick.brick > (prev?.brickPrev1 ?? 0);
    const aaPrev = index >= 2 && (prev?.brickPrev1 ?? 0) > (prev?.brickPrev2 ?? 0);
    const brickDelta = index >= 2
      ? calcBrickDelta(brick.brick, prev?.brickPrev1 ?? 0, prev?.brickPrev2 ?? 0)
      : 0;
    const brickXg = index >= 2 && !aaPrev && aa;

    const nextState: IndicatorCalcState = {
      count: index + 1,
      ema12,
      ema26,
      dea,
      kdjK,
      kdjD,
      atr14,
      closes: closesForCalc.slice(-239),
      highs: appendWindow(prev?.highs ?? [], high, 8),
      lows: appendWindow(prev?.lows ?? [], low, 8),
      qvols: qvolsForCalc.slice(-9),
      trs: trsForCalc.slice(-13),
      brickSma2a: brick.sma2a,
      brickSma4a: brick.sma4a,
      brickSma5a: brick.sma5a,
      brickPrev1: brick.brick,
      brickPrev2: prev?.brickPrev1 ?? 0,
      brickInited: true,
    };
    this.state = nextState;

    return {
      row: {
        ...source,
        DIF: roundSig(difRaw, 8),
        DEA: roundSig(dea, 8),
        MACD: roundSig(macdRaw, 8),
        'KDJ.K': parseFloat(kdjK.toFixed(4)),
        'KDJ.D': parseFloat(kdjD.toFixed(4)),
        'KDJ.J': parseFloat(kdjJ.toFixed(4)),
        BBI: roundSig(bbiRaw, 8),
        MA5: roundNullableSig(ma5, 8),
        MA30: roundNullableSig(ma30, 8),
        MA60: roundNullableSig(ma60, 8),
        MA120: roundNullableSig(ma120, 8),
        MA240: roundNullableSig(ma240, 8),
        '10_quote_volume': parseFloat(qvol10.toFixed(2)),
        atr_14: roundSig(atr14, 8),
        loss_atr_14: roundSig(close - atr14, 8),
        low_9: roundSig(low9, 8),
        high_9: roundSig(high9, 8),
        stop_loss_pct: parseFloat(stopLossPct.toFixed(4)),
        risk_reward_ratio: roundSig(riskRewardRatio, 4),
      },
      state: cloneState(nextState),
      brickChart: { brick: brick.brick, delta: brickDelta, xg: brickXg },
    };
  }
}

function calcNextEma(value: number, period: number, prev?: number): number {
  if (prev == null) return value;
  const k = 2.0 / (period + 1);
  return value * k + prev * (1 - k);
}

function calcNextAtr(index: number, tr: number, trs: number[], prevAtr?: number): number {
  if (index < ATR_PERIOD - 1) {
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }
  if (index === ATR_PERIOD - 1) {
    return trs.reduce((a, b) => a + b, 0) / ATR_PERIOD;
  }
  return ((prevAtr ?? tr) * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
}

function calcNextBrick(
  prev: IndicatorCalcState | undefined,
  high: number,
  low: number,
  close: number,
): { brick: number; sma2a: number; sma4a: number; sma5a: number } {
  const highs = appendWindow(prev?.highs ?? [], high, BRICK_P);
  const lows = appendWindow(prev?.lows ?? [], low, BRICK_P);
  const hhv = Math.max(...highs);
  const llv = Math.min(...lows);
  const range = hhv - llv;
  const var1a = range > 0 ? (hhv - close) / range * 100 - 90 : -90;
  const var3a = range > 0 ? (close - llv) / range * 100 : 50;
  let sma2a: number;
  let sma4a: number;
  let sma5a: number;
  if (!prev?.brickInited) {
    sma2a = var1a;
    sma4a = var3a;
    sma5a = var3a;
  } else {
    sma2a = (var1a + (BRICK_N1 - 1) * prev.brickSma2a) / BRICK_N1;
    sma4a = (var3a + (BRICK_N2 - 1) * prev.brickSma4a) / BRICK_N2;
    sma5a = (sma4a + (BRICK_N2 - 1) * prev.brickSma5a) / BRICK_N2;
  }
  const var6a = (sma5a + 100) - (sma2a + 100);
  return { brick: var6a > 4 ? var6a - 4 : 0, sma2a, sma4a, sma5a };
}

function calcBrickDelta(current: number, prev1: number, prev2: number): number {
  const diff1 = Math.abs(current - prev1);
  const diff2 = Math.abs(prev1 - prev2);
  return diff2 > 1e-10 ? diff1 / diff2 : 0;
}

function avgLast(values: number[], period: number): number {
  const start = Math.max(0, values.length - period);
  const window = values.slice(start);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function strictAvg(values: number[], index: number, period: number): number | null {
  if (index < period - 1) return null;
  return avgLast(values, period);
}

function appendWindow(values: number[], value: number, limit: number): number[] {
  const next = [...values, value];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function roundSig(x: number, sig = 8): number {
  if (x === 0 || !isFinite(x)) return x;
  const magnitude = Math.floor(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, Math.max(sig - 1 - magnitude, 0));
  return Math.round(x * factor) / factor;
}

function roundNullableSig(x: number | null, sig = 8): number | null {
  return x == null ? null : roundSig(x, sig);
}

function cloneState(state: IndicatorCalcState): IndicatorCalcState {
  return {
    ...state,
    closes: [...state.closes],
    highs: [...state.highs],
    lows: [...state.lows],
    qvols: [...state.qvols],
    trs: [...state.trs],
  };
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arr(value: unknown, limit: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => num(item, NaN))
    .filter((item) => Number.isFinite(item))
    .slice(-limit);
}
