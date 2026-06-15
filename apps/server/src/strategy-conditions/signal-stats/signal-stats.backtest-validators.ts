/**
 * signal-stats.backtest-validators.ts
 *
 * 扁平单源迷你回测配置（SignalTestBacktestConfig）的 fail-fast 校验（spec 04 §4.6）。
 * 从 signal-stats.service.ts 抽出（纯函数、零行为改动）；语义复用 portfolio-sim 的
 * create-portfolio-sim 校验（区间/枚举/anchorMode），落到扁平形。
 *
 * rankSpec 的「histAvailable 仅前向」是 warn 级提示——注入 warn 回调（service 传 logger.warn），
 * 保持纯函数不直接依赖 Logger。
 */
import { BadRequestException } from '@nestjs/common';
import { SignalTestBacktestConfig } from '../../entities/strategy/signal-test.entity';
import {
  RANK_FACTOR_REGISTRY,
  VALID_RANK_FACTOR_KEYS,
} from '../portfolio-sim/portfolio-sim.factor-registry';
import { validateRegimes } from '../portfolio-sim/portfolio-sim.regime-validator';

// ── 迷你回测 config 校验白名单（复用 portfolio-sim 语义，spec 04 §4.6）─────────
const VALID_RANK_DIRS = new Set(['asc', 'desc']);
const VALID_SIZING_MODES = new Set(['fixed', 'signal_weighted', 'source_kelly']);

/**
 * 校验扁平单源迷你回测配置（spec 04 §4.6）。null/undefined = 不跑回测，直接放行。
 * 校验语义复用 portfolio-sim.service.validateCreateDto（区间/枚举/anchorMode），
 * 但落到扁平形（不嵌 sources:[...]，runId 由 runner 在触发时注入本 run.id）。
 *
 * @param warn rankSpec histAvailable 提示回调（service 传 (m)=>this.logger.warn(m)）。
 */
export function validateBacktestConfig(
  bc: SignalTestBacktestConfig | null | undefined,
  warn?: (msg: string) => void,
): void {
  if (bc === undefined || bc === null) return;
  if (typeof bc !== 'object') {
    throw new BadRequestException('backtestConfig 非法');
  }

  // initialCapital > 0
  if (typeof bc.initialCapital !== 'number' || !(bc.initialCapital > 0)) {
    throw new BadRequestException('backtestConfig.initialCapital 须 > 0');
  }

  // positionRatio ∈ (0, 1]
  if (
    typeof bc.positionRatio !== 'number' ||
    !(bc.positionRatio > 0) ||
    bc.positionRatio > 1
  ) {
    throw new BadRequestException('backtestConfig.positionRatio 须在 (0, 1] 区间');
  }

  // maxPositions: null 或 ≥1 整数
  if (
    bc.maxPositions !== null &&
    (!Number.isInteger(bc.maxPositions) || (bc.maxPositions as number) < 1)
  ) {
    throw new BadRequestException(
      'backtestConfig.maxPositions 须为 ≥1 的整数或 null',
    );
  }

  // exposureCap: null 或 (0,1]
  if (
    bc.exposureCap !== null &&
    (typeof bc.exposureCap !== 'number' ||
      !(bc.exposureCap > 0) ||
      bc.exposureCap > 1)
  ) {
    throw new BadRequestException(
      'backtestConfig.exposureCap 须在 (0, 1] 区间或 null',
    );
  }

  // cost 各费率 ≥ 0
  const cost = bc.cost;
  if (!cost || typeof cost !== 'object') {
    throw new BadRequestException('backtestConfig.cost 不能为空');
  }
  const feeKeys: Array<keyof typeof cost> = [
    'commissionPerSide',
    'transferPerSide',
    'stampSellBefore20230828',
    'stampSellFrom20230828',
    'slippagePerSide',
  ];
  for (const k of feeKeys) {
    const v = cost[k];
    if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v)) {
      throw new BadRequestException(
        `backtestConfig.cost.${String(k)} 须为 ≥0 的有限数`,
      );
    }
  }

  // anchorMode 须布尔
  if (typeof bc.anchorMode !== 'boolean') {
    throw new BadRequestException('backtestConfig.anchorMode 须为布尔值');
  }

  // rankSpec.factors：每项 factor∈9 白名单、weight>0、dir∈{asc,desc}；允许 []
  validateBacktestRankSpec(bc.rankSpec, warn);

  // sizing：mode∈白名单；signal_weighted/source_kelly 子约束
  validateBacktestSizing(bc.sizing);

  // circuitBreaker：null 或双触发字段齐全（与 portfolio-sim 同语义）
  validateBacktestCircuitBreaker(bc.circuitBreaker);

  // regimes：账户级 regime 调仓（与 portfolio-sim 复用同一 validateRegimes）
  validateRegimes(bc.regimes, 'backtestConfig.regimes');
}

function validateBacktestRankSpec(
  spec: SignalTestBacktestConfig['rankSpec'],
  warn?: (msg: string) => void,
): void {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.factors)) {
    throw new BadRequestException('backtestConfig.rankSpec.factors 须为数组');
  }
  for (let j = 0; j < spec.factors.length; j++) {
    const f = spec.factors[j];
    const ftag = `backtestConfig.rankSpec.factors[${j}]`;
    if (!f || typeof f !== 'object') {
      throw new BadRequestException(`${ftag} 非法`);
    }
    if (!VALID_RANK_FACTOR_KEYS.has(f.factor)) {
      throw new BadRequestException(
        `${ftag}.factor 非法：${String(f.factor)}（须为注册表内因子 KEY）`,
      );
    }
    if (typeof f.weight !== 'number' || !(f.weight > 0) || !Number.isFinite(f.weight)) {
      throw new BadRequestException(`${ftag}.weight 须为 > 0 的有限数`);
    }
    if (!VALID_RANK_DIRS.has(f.dir)) {
      throw new BadRequestException(`${ftag}.dir 须为 asc / desc`);
    }
    if (!RANK_FACTOR_REGISTRY[f.factor].histAvailable) {
      warn?.(`${ftag}.factor=${f.factor} 历史不足，仅前向`);
    }
  }
}

function validateBacktestSizing(sizing: SignalTestBacktestConfig['sizing']): void {
  if (!sizing || typeof sizing !== 'object') {
    throw new BadRequestException('backtestConfig.sizing 不能为空');
  }
  const stag = 'backtestConfig.sizing';
  if (!VALID_SIZING_MODES.has(sizing.mode)) {
    throw new BadRequestException(
      `${stag}.mode 须为 fixed / signal_weighted / source_kelly`,
    );
  }
  if (sizing.mode === 'signal_weighted') {
    if (
      typeof sizing.floorMult !== 'number' ||
      !(sizing.floorMult > 0) ||
      !Number.isFinite(sizing.floorMult)
    ) {
      throw new BadRequestException(`${stag}.floorMult 须为 > 0 的有限数`);
    }
    if (
      typeof sizing.capMult !== 'number' ||
      !Number.isFinite(sizing.capMult) ||
      sizing.capMult < sizing.floorMult
    ) {
      throw new BadRequestException(`${stag}.capMult 须为 ≥ floorMult 的有限数`);
    }
  }
  if (sizing.mode === 'source_kelly') {
    if (
      typeof sizing.kellyFraction !== 'number' ||
      !(sizing.kellyFraction > 0) ||
      sizing.kellyFraction > 1
    ) {
      throw new BadRequestException(`${stag}.kellyFraction 须在 (0, 1] 区间`);
    }
    if (
      typeof sizing.kellyMaxMult !== 'number' ||
      !(sizing.kellyMaxMult > 0) ||
      !Number.isFinite(sizing.kellyMaxMult)
    ) {
      throw new BadRequestException(`${stag}.kellyMaxMult 须为 > 0 的有限数`);
    }
  }
}

function validateBacktestCircuitBreaker(
  cb: SignalTestBacktestConfig['circuitBreaker'],
): void {
  if (cb === undefined || cb === null) return;
  const tag = 'backtestConfig.circuitBreaker';
  if (typeof cb !== 'object') {
    throw new BadRequestException(`${tag} 非法`);
  }

  if (cb.enableCooldown) {
    if (
      !Number.isInteger(cb.consecutiveLossesThreshold) ||
      cb.consecutiveLossesThreshold < 1
    ) {
      throw new BadRequestException(
        `${tag}.consecutiveLossesThreshold 须为 ≥1 的整数`,
      );
    }
    if (
      typeof cb.baseCooldownDays !== 'number' ||
      !Number.isFinite(cb.baseCooldownDays) ||
      cb.baseCooldownDays < 0
    ) {
      throw new BadRequestException(`${tag}.baseCooldownDays 须为 ≥0 的有限数`);
    }
    if (
      typeof cb.maxCooldownDays !== 'number' ||
      !Number.isFinite(cb.maxCooldownDays) ||
      cb.maxCooldownDays < cb.baseCooldownDays
    ) {
      throw new BadRequestException(
        `${tag}.maxCooldownDays 须为 ≥ baseCooldownDays 的有限数`,
      );
    }
    if (
      typeof cb.extendOnLoss !== 'number' ||
      !Number.isFinite(cb.extendOnLoss) ||
      cb.extendOnLoss < 0
    ) {
      throw new BadRequestException(`${tag}.extendOnLoss 须为 ≥0 的有限数`);
    }
    if (
      typeof cb.reduceOnProfit !== 'number' ||
      !Number.isFinite(cb.reduceOnProfit) ||
      cb.reduceOnProfit < 0
    ) {
      throw new BadRequestException(`${tag}.reduceOnProfit 须为 ≥0 的有限数`);
    }
  }

  if (cb.enableDrawdownHalt) {
    if (
      typeof cb.drawdownHaltPct !== 'number' ||
      !Number.isFinite(cb.drawdownHaltPct) ||
      !(cb.drawdownHaltPct > 0) ||
      !(cb.drawdownHaltPct < 1)
    ) {
      throw new BadRequestException(`${tag}.drawdownHaltPct 须在 (0, 1) 开区间`);
    }
    if (
      typeof cb.drawdownResumePct !== 'number' ||
      !Number.isFinite(cb.drawdownResumePct) ||
      cb.drawdownResumePct < 0 ||
      cb.drawdownResumePct > cb.drawdownHaltPct
    ) {
      throw new BadRequestException(
        `${tag}.drawdownResumePct 须在 [0, drawdownHaltPct] 区间`,
      );
    }
  }
}
