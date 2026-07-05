import { ExitConfig } from '../../core/exit-simulator';

export function buildExitConfig(
  exitMode: string | null,
  exitParams: Record<string, unknown> | null,
): ExitConfig {
  const p = exitParams ?? {};
  switch (exitMode) {
    case 'fixed_n':
      return { mode: 'fixed_n', horizonN: (p.N as number) ?? 5 };
    case 'trailing_lock':
      return {
        mode: 'trailing_lock',
        maxHold: (p.maxHold as number) ?? undefined,
        stopRatio: (p.stopRatio as number) ?? 0.999,
        floorRatio: (p.floorRatio as number) ?? 0.999,
        floorEnabled: (p.floorEnabled as boolean) ?? true,
        ma5RequireDown: (p.ma5RequireDown as boolean) ?? true,
      };
    case 'strategy':
      return {
        mode: 'strategy',
        maxHold: (p.maxHold as number) ?? 10,
        exitConditions: (p.exitConditions as unknown[] | undefined) ?? undefined,
      };
    case 'phase_lock':
      return {
        mode: 'phase_lock',
        initFactor: (p.initFactor as number) ?? 0.999,
        lockFactor: (p.lockFactor as number) ?? 0.999,
        lookback: (p.lookback as number) ?? 10,
      };
    default:
      return { mode: 'fixed_n', horizonN: (p.N as number) ?? 5 };
  }
}
