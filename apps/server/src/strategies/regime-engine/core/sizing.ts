import { SizingConfig } from './types';
import { calcSignalStats } from './metrics';

export const MIN_ALLOC_YUAN = 1;

export interface ComputeAllocParams {
  quality: number;
  positionRatio: number;
  sizing?: SizingConfig;
  navRef: number;
  anchorMode: boolean;
  effectivePositionRatio?: number;
  sourceKellyMult?: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function computeAlloc(params: ComputeAllocParams): number {
  const {
    quality,
    positionRatio,
    sizing,
    navRef,
    anchorMode,
    effectivePositionRatio,
    sourceKellyMult,
  } = params;

  if (anchorMode) {
    return positionRatio * navRef;
  }

  const mode = sizing?.mode ?? 'fixed';
  const base = effectivePositionRatio ?? positionRatio;

  let mult: number;
  switch (mode) {
    case 'signal_weighted': {
      const s = sizing!;
      mult = s.floorMult + (s.capMult - s.floorMult) * quality;
      break;
    }
    case 'source_kelly':
      mult = sourceKellyMult ?? 1;
      break;
    case 'fixed':
    default:
      mult = 1;
      break;
  }

  return base * mult * navRef;
}

export function computeSourceKellyMult(
  rets: number[],
  sizing: { kellyFraction: number; kellyMaxMult: number },
  warn?: (msg: string) => void,
): number {
  const stats = calcSignalStats(
    rets,
    rets.map(() => 1),
  );
  const kf = stats.kellyF;

  if (kf !== null) {
    return kf <= 0 ? 0 : clamp(kf * sizing.kellyFraction, 0, sizing.kellyMaxMult);
  }

  if (stats.avgWin === null && stats.avgLoss !== null) {
    return 0;
  }
  warn?.('source_kelly kellyF=null（全胜/全平/样本不足），退化 fixed（mult=1）');
  return 1;
}
