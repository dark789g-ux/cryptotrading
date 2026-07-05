import {
  HoldingDaySnapshot,
  SimulationInput,
  WindowQuote,
} from '../types';

export function tradingDay(
  calDate: string,
  opts: Partial<HoldingDaySnapshot> = {},
): HoldingDaySnapshot {
  return {
    calDate,
    hasQuote: true,
    qfqOpen: opts.qfqOpen ?? 10,
    qfqClose: opts.qfqClose ?? 10,
    qfqHigh: opts.qfqHigh ?? null,
    qfqLow: opts.qfqLow ?? null,
    rawOpen: opts.rawOpen ?? 10,
    rawHigh: opts.rawHigh ?? null,
    upLimit: opts.upLimit ?? 11,
    downLimit: opts.downLimit ?? null,
    ma5: opts.ma5 ?? null,
    exitSignalHit: opts.exitSignalHit ?? false,
    ...opts,
  };
}

export function suspendedDay(calDate: string): HoldingDaySnapshot {
  return {
    calDate,
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

export function baseInput(
  days: HoldingDaySnapshot[],
  exit: SimulationInput['exit'],
  overrides: Partial<SimulationInput> = {},
): SimulationInput {
  return {
    tsCode: '000001.SZ',
    signalDate: '20260101',
    days,
    daysSinceList: 999,
    delistDate: null,
    exit,
    ...overrides,
  };
}

export function makeQuote(
  qfqOpen: number | null,
  qfqClose: number | null,
  open: number | null = qfqOpen,
): WindowQuote {
  return { qfqOpen, qfqClose, open };
}
