/**
 * signal-stats.exit-params.ts
 *
 * trailing_lock(band_lock) / phase_lock 出场参数的「量化 + 默认 + 组装(jsonb) + 校验」。
 * 从 signal-stats.service.ts 抽出（纯函数、零行为改动），供 service 的 create/update/validateDto 委托。
 */
import { BadRequestException } from '@nestjs/common';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';
import { SignalTestEntity } from '../../entities/strategy/signal-test.entity';

// ── band_lock 参数：量化 + 默认 + 组装 ───────────────────────────────────────

/** band_lock 4 参数默认值（与核 decideBandLock 的 `?? 默认` 逐字一致）。 */
const BAND_LOCK_DEFAULTS = {
  stopRatio: 0.999,
  floorRatio: 0.999,
  floorEnabled: true,
  ma5RequireDown: true,
} as const;

/**
 * ratio 量化：round-half-up 到 0.001（NNNN = floor(r*1000+0.5)）。
 * 与核 band_lock_exit `floor(r*1000+0.5)` 对齐，避免 JS Math.round 的 banker's 分叉。
 * 返回量化后的 ratio（NNNN/1000）。
 */
export function quantizeRatio(r: number): number {
  return Math.floor(r * 1000 + 0.5) / 1000;
}

/**
 * 把 DTO 的 band_lock 4 参数组装成落库的 bandLockParams jsonb。
 * - 非 trailing_lock 模式 → null。
 * - trailing_lock 且量化后 4 参数全为默认 → null（存量行零漂移）。
 * - 否则 → 量化后的完整 4 字段对象（runner 直接透传，核不再量化）。
 * 调用前提：已过 validateDto（ratio 量化后在合法范围、布尔合法）。
 */
export function buildBandLockParams(
  dto: CreateSignalTestDto,
): SignalTestEntity['bandLockParams'] {
  if (dto.exitMode !== 'trailing_lock') return null;
  const stopRatio =
    dto.stopRatio !== undefined ? quantizeRatio(dto.stopRatio) : BAND_LOCK_DEFAULTS.stopRatio;
  const floorRatio =
    dto.floorRatio !== undefined ? quantizeRatio(dto.floorRatio) : BAND_LOCK_DEFAULTS.floorRatio;
  const floorEnabled = dto.floorEnabled ?? BAND_LOCK_DEFAULTS.floorEnabled;
  const ma5RequireDown = dto.ma5RequireDown ?? BAND_LOCK_DEFAULTS.ma5RequireDown;
  // 全默认 → null（零漂移）。
  if (
    stopRatio === BAND_LOCK_DEFAULTS.stopRatio &&
    floorRatio === BAND_LOCK_DEFAULTS.floorRatio &&
    floorEnabled === BAND_LOCK_DEFAULTS.floorEnabled &&
    ma5RequireDown === BAND_LOCK_DEFAULTS.ma5RequireDown
  ) {
    return null;
  }
  return { stopRatio, floorRatio, floorEnabled, ma5RequireDown };
}

// ── phase_lock 参数：量化 + 默认 + 组装 ──────────────────────────────────────

/** phase_lock 3 参数默认值（与共享核 phase_lock_exit.py 默认逐字一致）。 */
const PHASE_LOCK_DEFAULTS = {
  initFactor: 0.999,
  lockFactor: 0.999,
  lookback: 10,
} as const;

/**
 * 把 DTO 的 phase_lock 3 参数组装成落库的 phaseLockParams jsonb。
 * - 非 phase_lock 模式 → null。
 * - phase_lock 且量化后 3 参数全为默认 → null（存量行零漂移）。
 * - 否则 → 量化后的完整 3 字段对象（runner 直接透传，核不再量化）。
 * 调用前提：已过 validateDto（factor 量化后在合法范围、lookback 正整数）。
 */
export function buildPhaseLockParams(
  dto: CreateSignalTestDto,
): SignalTestEntity['phaseLockParams'] {
  if (dto.exitMode !== 'phase_lock') return null;
  const initFactor =
    dto.initFactor !== undefined ? quantizeRatio(dto.initFactor) : PHASE_LOCK_DEFAULTS.initFactor;
  const lockFactor =
    dto.lockFactor !== undefined ? quantizeRatio(dto.lockFactor) : PHASE_LOCK_DEFAULTS.lockFactor;
  const lookback = dto.lookback ?? PHASE_LOCK_DEFAULTS.lookback;
  // 全默认 → null（零漂移）。
  if (
    initFactor === PHASE_LOCK_DEFAULTS.initFactor &&
    lockFactor === PHASE_LOCK_DEFAULTS.lockFactor &&
    lookback === PHASE_LOCK_DEFAULTS.lookback
  ) {
    return null;
  }
  return { initFactor, lockFactor, lookback };
}

// ── band_lock / phase_lock 参数校验（fail-fast 400）──────────────────────────

/**
 * 校验 trailing_lock 的 band_lock 4 参数（仅在 exitMode='trailing_lock' 分支调用）。
 *   stopRatio:      提供 → 量化后 NNNN∈[1,1000]（ratio∈[0.001,1.0]），否则 400
 *   floorRatio:     提供 → 量化后 NNNN∈[1,9999]（ratio∈[0.001,9.999]，允许锁盈 >1），否则 400
 *   floorEnabled:   提供 → 必须 boolean
 *   ma5RequireDown: 提供 → 必须 boolean
 */
export function validateBandLockParams(dto: CreateSignalTestDto): void {
  const checkRatio = (name: string, v: number | undefined, maxNNNN: number): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new BadRequestException(`${name} 必须为有限数值`);
    }
    const nnnn = Math.floor(v * 1000 + 0.5); // 与核量化对齐（round-half-up）
    if (nnnn < 1 || nnnn > maxNNNN) {
      throw new BadRequestException(
        `${name} 量化后须在 [${(1 / 1000).toFixed(3)}, ${(maxNNNN / 1000).toFixed(3)}] 范围内`,
      );
    }
  };
  checkRatio('stopRatio', dto.stopRatio, 1000);
  checkRatio('floorRatio', dto.floorRatio, 9999);
  if (dto.floorEnabled !== undefined && typeof dto.floorEnabled !== 'boolean') {
    throw new BadRequestException('floorEnabled 必须为布尔值');
  }
  if (dto.ma5RequireDown !== undefined && typeof dto.ma5RequireDown !== 'boolean') {
    throw new BadRequestException('ma5RequireDown 必须为布尔值');
  }
}

/**
 * 校验 phase_lock 的 3 参数（仅在 exitMode='phase_lock' 分支调用）。
 *   initFactor: 提供 → 量化后 NNNN∈[1,2000]（ratio∈[0.001,2.0]，允许 >1），否则 400
 *   lockFactor: 提供 → 量化后 NNNN∈[1,2000]（同上），否则 400
 *   lookback:   提供 → 整数且 ∈[1,250]，否则 400
 * 范围依据 spec 02 §参数范围（量化校验）。
 */
export function validatePhaseLockParams(dto: CreateSignalTestDto): void {
  const checkRatio = (name: string, v: number | undefined, maxNNNN: number): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new BadRequestException(`${name} 必须为有限数值`);
    }
    const nnnn = Math.floor(v * 1000 + 0.5); // 与核量化对齐（round-half-up）
    if (nnnn < 1 || nnnn > maxNNNN) {
      throw new BadRequestException(
        `${name} 量化后须在 [${(1 / 1000).toFixed(3)}, ${(maxNNNN / 1000).toFixed(3)}] 范围内`,
      );
    }
  };
  checkRatio('initFactor', dto.initFactor, 2000);
  checkRatio('lockFactor', dto.lockFactor, 2000);
  if (dto.lookback !== undefined) {
    if (typeof dto.lookback !== 'number' || !Number.isInteger(dto.lookback)) {
      throw new BadRequestException('lookback 必须为整数');
    }
    if (dto.lookback < 1 || dto.lookback > 250) {
      throw new BadRequestException('lookback 须在 [1, 250] 范围内');
    }
  }
}
